/**
 * host 入口：装配模型池与探针。
 *
 * 本阶段只做两件事（按规划分阶段）：
 *   ① 建池：把宿主所有 provider 的模型统一成可调度条目，并恢复上次的冷却/失败计数。
 *   ② 起探针：免费模型周期性全量探测，结果写回池。
 *
 * 后续阶段接进来的是 scheduler（选型）、failover（切换）、catalog-filter（界面屏蔽）、
 * client 半身（左侧栏入口）。
 *
 * 关于「把池交给下一阶段」：cordis 的 Context 是 Proxy，给未声明的属性赋值会抛
 * `cannot set property "x" without provide`，`ctx.set()` 也只改已声明的服务位。
 * 所以这里不去伪造一个服务，而是用模块级引用 + 导出 getter；同进程的插件
 * `import { currentService } from '@dsh-external/dsh-model-autopilot'` 即可拿到同一份池。
 *
 * @module index
 */
import { normalizeConfig } from './config.js'
import { fileURLToPath } from 'node:url'
import { resolveDataDir, resolveDshHome } from './paths.js'
import { createJsonStore } from './store.js'
import { createPool } from './pool/pool.js'
import { createProber } from './probe/prober.js'
import { createPreference } from './preference.js'
import { createQuotaIntel } from './aihot/quota-intel.js'
import { persistDefaultModel } from './host-config.js'
import { createScheduler } from './schedule/scheduler.js'
import { createFailover } from './failover/failover.js'
import { createAutopilot, createAutopilotAdapter, AUTOPILOT_PROVIDER } from './autopilot.js'
import { createCatalogFilter } from './catalog-filter/index.js'
import { createApiHandler, mountApi } from './api.js'
import { ensureClientHalf } from './client-half.js'
import { failureOf } from './util.js'

export const name = '@dsh-external/dsh-model-autopilot'
/** 只依赖 llm 服务；logger 是 cordis 内建，定时器用原生实现以保持零耦合。 */
export const inject = ['llm']

/** 诊断/下一阶段用的引用名（不是 cordis 服务名，见文件头说明）。 */
export const SERVICE_NAME = 'modelAutopilot'

/** @type {null | { config: any, pool: any, prober: any, store: any, status: () => any }} */
let activeService = null

/** 当前进程里生效的实例；热重载后指向新一代，卸载后为 null。 */
export function currentService() {
  return activeService
}

/**
 * 注册槽位放在 globalThis 上：**跨 fiber 存活**。
 *
 * 热重载会清掉模块缓存，模块级变量一律重置，所以槽位不能放模块里。放这里之后，
 * 旧 fiber 销毁时不再立刻释放路由，新 fiber 直接接管同一个 handle —— 路由全程
 * 存在，宿主不会在重载窗口里撞到 `no adapter registered`。
 *
 * 只有在**没有继任者**（真正卸载插件）时，才由延迟释放把 handle 收掉。
 */
const ADAPTER_SLOT = '__DSH_MODEL_AUTOPILOT_ADAPTER__'

/** 拿到（或创建）槽位。 */
function adapterSlot() {
  const holder = /** @type {any} */ (globalThis)
  if (!holder[ADAPTER_SLOT]) {
    holder[ADAPTER_SLOT] = { handle: null, adapter: null, generation: 0, releaseTimer: null }
  }
  return holder[ADAPTER_SLOT]
}

/**
 * 安装虚拟 provider，并让它**跨热重载存活**。
 *
 * 为什么不是简单的「失败后重试」：重试只能事后补，补之前进来的请求已经失败了
 * （宿主报 `no adapter registered for provider "autopilot"` 并回退默认模型）。
 * 真正的解法是让路由在重载期间**从不消失**：
 *   - 旧 fiber 销毁时不立即释放，改为延迟释放，等继任者接管；
 *   - 新 fiber 启动时发现槽位里有 handle，直接复用，不重新注册（也就不会撞名）。
 *
 * adapter 本身通过 getter 动态解析当前 fiber 的 autopilot 实例，所以复用旧
 * handle 不会操作到已销毁的服务。
 *
 * @param {any} ctx
 * @param {any} adapter
 * @param {any} logger
 */
export function installAutopilotProvider(ctx, adapter, logger = console) {
  const slot = adapterSlot()
  slot.generation += 1
  const myGeneration = slot.generation
  // 有继任者了：取消上一代安排的延迟释放。
  if (slot.releaseTimer !== null) {
    clearTimeout(slot.releaseTimer)
    slot.releaseTimer = null
  }

  let registered = false
  /** @type {null | (() => void)} */
  let handle = null
  let attempt = 0
  const delays = [10, 30, 120, 500, 1_500, 4_000]

  /** 宿主目录里是否已有这个 provider。 */
  const present = () => {
    try {
      return ctx.llm.listProviders().some((provider) => provider.id === AUTOPILOT_PROVIDER)
    } catch {
      return false
    }
  }

  const doRegister = () => {
    if (registered) return true

    // ① 槽位里有 handle 且路由还在 → 直接接管，不重新注册。
    if (slot.handle !== null && present()) {
      handle = slot.handle
      slot.adapter = adapter
      registered = true
      logger.info?.(`model-autopilot: 复用上一代的 "${AUTOPILOT_PROVIDER}" 路由（热重载无缝接力）`)
      return true
    }

    // ② 槽位为空但路由被别人占着 → 等它释放，不抢。
    if (present()) {
      logger.info?.(`model-autopilot: "${AUTOPILOT_PROVIDER}" 路由被占用，等待接管`)
      return false
    }

    // ③ 注册。
    try {
      handle = ctx.llm.registerAdapter([AUTOPILOT_PROVIDER], adapter)
      slot.handle = handle
      slot.adapter = adapter
      registered = true
      attempt = 0
      logger.info?.(`model-autopilot: 虚拟 provider "${AUTOPILOT_PROVIDER}" 已注册`)
      return true
    } catch (error) {
      logger.warn?.(`model-autopilot: 虚拟 provider 注册被拒（${failureOf(error).message}），稍后重试`)
      return false
    }
  }

  const schedule = () => {
    if (doRegister()) return
    if (attempt >= delays.length) {
      logger.warn?.('model-autopilot: 虚拟 provider 重试耗尽 —— 看护仍会继续尝试')
      return
    }
    const wait = delays[attempt]
    attempt += 1
    const timer = setTimeout(() => {
      if (!doRegister() && attempt < delays.length) schedule()
    }, wait)
    timer.unref?.()
  }

  schedule()

  // 事件驱动：路由一消失就补。
  ctx.effect(
    () =>
      ctx.on('llm/adapters-updated', () => {
        if (!present()) {
          registered = false
          slot.handle = null
          attempt = 0
          schedule()
        }
      }),
    'model-autopilot: adapter-watch'
  )

  // 兜底看护。
  const watchdog = setInterval(() => {
    if (!present()) {
      registered = false
      slot.handle = null
      attempt = 0
      schedule()
    }
  }, 30_000)
  watchdog.unref?.()
  ctx.effect(() => () => clearInterval(watchdog), 'model-autopilot: adapter-watchdog')

  // 销毁：延迟释放。给继任者留出接管时间；没有继任者才真正收掉。
  ctx.effect(
    () => () => {
      slot.releaseTimer = setTimeout(() => {
        slot.releaseTimer = null
        // 期间有继任者接管 → 什么都不做
        if (slot.generation !== myGeneration) return
        try {
          slot.handle?.()
        } catch {
          /* 释放失败不阻塞 */
        }
        slot.handle = null
        slot.adapter = null
        logger.info?.(`model-autopilot: 无继任者，已释放 "${AUTOPILOT_PROVIDER}" 路由`)
      }, 1_500)
      slot.releaseTimer.unref?.()
    },
    'model-autopilot: adapter-hold'
  )

  return {
    isRegistered: () => registered,
    isPresent: present,
    adapter,
    status: () => ({ registered, present: present(), calls: adapter?.stats?.().calls ?? 0 })
  }
}

/**
 * @param {any} ctx - cordis context
 * @param {unknown} rawConfig - entry config（cordis.patch.yml 的 config 字段）
 */
export async function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx?.logger ?? console

  let stateFile
  let preferenceFile
  /** DSH home：写默认模型时要定位 profile patch。 */
  const dshHomePath = resolveDshHome()
  try {
    const dataDir = resolveDataDir(config)
    stateFile = `${dataDir.replace(/[\\/]+$/, '')}/pool-state.json`
    // 首选设置单独一个文件：热重载时新旧 fiber 共用 pool-state.json 会互相覆盖。
    preferenceFile = `${dataDir.replace(/[\\/]+$/, '')}/preference.json`
  } catch (error) {
    logger.warn?.(`model-autopilot: 数据目录不可用，改为内存态 (${failureOf(error).message})`)
    stateFile = `${process.env.TEMP ?? process.env.TMPDIR ?? '.'}/dsh-model-autopilot-${process.pid}.json`
    preferenceFile = `${process.env.TEMP ?? process.env.TMPDIR ?? '.'}/dsh-model-autopilot-preference-${process.pid}.json`
  }

  const store = createJsonStore(stateFile, { logger })
  // 一次性迁移：catalogFilter 关闭时，把历史写下的 hiddenFromPicker=true 清掉。
  // 必须在 pool 初始化**之前**做 —— 否则 pool 先读取了旧 true，再写回就又脏了。
  if (config.catalogFilter?.enabled !== true && typeof store.resetHiddenFromPicker === 'function') {
    try {
      store.resetHiddenFromPicker('catalogFilter 已关闭')
    } catch (error) {
      logger.warn?.(`model-autopilot: hiddenFromPicker 迁移失败（${failureOf(error).message}）`)
    }
  }
  const pool = createPool({ ctx, config, store, logger })
  const prober = createProber({ ctx, pool, config, logger })
  const preference = createPreference({
    file: preferenceFile,
    pool,
    logger
  })
  // 额度情报（AIHOT 羊毛清单）：告诉调度器哪些通道现在有免费额度。
  const quotaIntel = createQuotaIntel({ config, logger })
  const scheduler = createScheduler({
    pool,
    config,
    logger,
    preference,
    // 情报是活的：每次 plan 时取当前快照，而不是启动时拍一次。
    quota: { get providers() { return quotaIntel.quota()?.providers ?? {} } }
  })
  const failover = createFailover({ ctx, pool, scheduler, config, logger, preference })
  const autopilot = createAutopilot({ ctx, pool, scheduler, failover, config, logger })

  // ① 先建池，再起探针：探针要探的是真实条目，空池起探毫无意义。
  try {
    await pool.reload()
  } catch (error) {
    logger.warn?.(`model-autopilot: 模型池装载失败 (${failureOf(error).message})`)
  }

  // ② 注册虚拟 provider：模型选择界面出现 "Autopilot" 一项。
  //    它被 config.schedule.excludeProviders 挡在池外，所以探针不会探它、
  //    调度不会选它 —— 只会由用户/上层显式选中来触发一次自动选型。
  //
  //    热重载时可能出现「新旧 fiber 短暂并存」：旧 fiber 还占着 'autopilot' 路由，
  //    新 fiber 注册会抛 DUPLICATE_ADAPTER。若不接住，整个 fiber 会判 failed，
  //    而旧 fiber 随后 dispose 又会把路由释放掉 —— 结果谁都没注册上。
  //    所以这里接住错误并做退避重试（接管）。
  const adapterControl = installAutopilotProvider(
    ctx,
    // getter 从 globalThis 取**当前** fiber 的 autopilot：adapter 会跨热重载复用，
    // 不能闭包住某一代的对象。
    createAutopilotAdapter({
      getAutopilot: () => /** @type {any} */ (globalThis).__DSH_MODEL_AUTOPILOT_RESOLVE__?.() ?? null,
      config,
      logger
    }),
    logger
  )
  // 新 fiber 覆盖 resolver：跨 fiber 复用的旧 adapter 由此拿到**当前**实例。
  // 卸载时清空，旧 adapter 会明确报「正在重载」而不是操作死服务。
  // 注意：这行前面是 `)` 结尾，必须以分号或独立语句开头，否则 ASI 会把
  // `(globalThis)` 当成上一行的函数调用 —— 那会让整个 apply 抛错、fiber failed。
  const globalHolder = /** @type {any} */ (globalThis)
  globalHolder.__DSH_MODEL_AUTOPILOT_RESOLVE__ = () => autopilot
  ctx.effect(
    () => () => {
      const holder = /** @type {any} */ (globalThis)
      if (holder.__DSH_MODEL_AUTOPILOT_RESOLVE__?.() === autopilot) {
        holder.__DSH_MODEL_AUTOPILOT_RESOLVE__ = null
      }
    },
    'model-autopilot: resolver'
  )
  // 保留 adapter 引用：调用统计是「真实请求确实进了 autopilot」的直接证据。
  const autopilotAdapter = adapterControl.adapter

  // 注册完立刻重建一次：adapter 是在上面那步才进宿主目录的，第一次 reload 看不到它。
  // 不依赖 'llm/adapters-updated' 事件来做这件事 —— 监听器本身也是 effect，可能晚于
  // 这一次 emit 才挂上，错过一次就永远不知道虚拟 provider 存在（也就验证不了排除生效）。
  try {
    await pool.reload()
  } catch (error) {
    logger.warn?.(`model-autopilot: 注册虚拟 provider 后重建池失败 (${failureOf(error).message})`)
  }

  // ③ 模型选择界面的动态屏蔽：包住 ctx.llm.listModels。
  //    选择界面的目录来自 session.modelCatalog() → buildModelCatalog(ctx) →
  //    ctx.llm.listProviders/listModels，所以在这一层过滤即可，不必碰客户端。
  //    install() 同步执行（要立刻可用），dispose 挂 fiber（热重载/卸载时还原）。
  const catalogFilter = createCatalogFilter({
    ctx,
    pool,
    config,
    logger,
    onRefresh: (snapshot) => {
      store.setMeta?.({ catalogFilter: { installed: true, ...snapshot } })
    }
  })
  let catalogInstalled = false
  if (config.catalogFilter.enabled) {
    catalogInstalled = catalogFilter.install()
    if (catalogInstalled) {
      // 池必须看全量目录：否则被界面隐藏的条目会从池里消失，探针再也探不到，
      // 冷却永远不到期 —— 也就永远恢复不了（实测会少 11 条，正好是被隐藏的数量）。
      pool.setRawListModels((provider) => catalogFilter.rawListModels(provider))
    }
    ctx.effect(() => () => catalogFilter.dispose(), 'model-autopilot: catalog-filter')
    // 自检：用不存在的 provider 调一次，确认实例覆写真的生效（而非静默失败）。
    catalogInstalled = (await catalogFilter.verify()) && catalogInstalled
    store.setMeta?.({
      catalogFilter: { installed: catalogInstalled, ...catalogFilter.stats() }
    })
  } else {
    logger.info('model-autopilot: catalog-filter 已按配置关闭')
  }

  // ④ 探针与存档都挂到 fiber 生命周期上：热重载/卸载时定时器一起清掉。
  ctx.effect(() => prober.start(), 'model-autopilot: prober')
  ctx.effect(() => quotaIntel.start(), 'model-autopilot: quota-intel')
  ctx.effect(
    () => () => {
      store.dispose()
      if (activeService?.pool === pool) activeService = null
    },
    'model-autopilot: store'
  )

  // ⑤ provider 目录变化（插件挂载/卸载、配置开关）→ 重建池。
  //    事件名来自 dsh-llm：commitRoutes / emitAdaptersUpdated 发布 'llm/adapters-updated'。
  //    我们自己触发的刷新要跳过：那次 emit 的目的是让界面重拉目录，不是让池重建。
  ctx.effect(
    () =>
      ctx.on('llm/adapters-updated', () => {
        if (catalogFilter.isRefreshing()) return
        pool.reload().catch((error) => {
          logger.warn?.(`model-autopilot: 目录变更后重建池失败 (${failureOf(error).message})`)
        })
      }),
    'model-autopilot: catalog-watch'
  )

  const stats = pool.stats()
  logger.info(
    `model-autopilot: 就绪 —— ${stats.total} 个模型（免费 ${stats.free} / 付费 ${stats.paid}），` +
      `探针间隔 ${config.probe.intervalMs === 0 ? '关闭' : `${Math.round(config.probe.intervalMs / 1000)}s`}，` +
      `自动选型 provider "${AUTOPILOT_PROVIDER}" 已注册`
  )

  activeService = {
    ctx,
    config,
    pool,
    prober,
    scheduler,
    failover,
    autopilot,
    preference,
    quotaIntel,
    adapterControl,
    catalogFilter,
    catalogFilterInstalled: catalogInstalled && config.catalogFilter.enabled,
    store,
    /**
     * 额度情报（AIHOT 羊毛清单）快照。
     */
    quotaIntel: () => quotaIntel.quota(),
    /** 额度情报的状态（enabled / 抓取时间 / 错误）。 */
    quotaIntelStatus: () => quotaIntel.status(),
    /**
     * 切换会话模型。走宿主 SessionController：它会把 selection 装到该会话的下一次请求上，
     * 并在后台把默认模型一起保存。没有 sessionController 的组合（纯 host 无 API 层）返回错误。
     * @param {{ provider: string, model: string, sessionId: string, reasoningEffort?: string }} request
     */
    /**
     * 列出已知会话（诊断/定位 sessionId 用）。宿主 sessionController.list() 返回摘要。
     */
    /**
     * 读会话持久的模型 selection，用于诊断「切了又跳回默认」。
     * 来源是 Session 投影里的 modelSelection（会话事件流 model/selection 的投影）。
     * @param {string} sessionId
     */
    /**
     * 走宿主完整链路验证虚拟 provider：ctx.llm.stream({provider:'autopilot'})。
     * 与 /try（直接调 autopilot.run）不同，这条路径会经过 registerAdapter 注册的
     * adapter、llm/stream waterfall 与宿主的 call 配置解析 —— 用来区分
     * 「adapter 坏了」与「selection 没切过来」。
     * @param {{ text?: string }} [request]
     */
    async tryAdapter(request = {}) {
      const llm = ctx.llm
      const messages = [{ role: 'user', content: [{ type: 'text', text: request.text ?? 'ping' }] }]
      const chunks = []
      const stream = llm.stream({ provider: AUTOPILOT_PROVIDER, model: 'auto', messages })
      const iterator = stream[Symbol.asyncIterator]()
      try {
        for (let index = 0; index < 3; index += 1) {
          const next = await iterator.next()
          if (next.done) break
          chunks.push(next.value?.type ?? 'unknown')
        }
      } finally {
        try {
          await iterator.return?.()
        } catch {
          /* 释放失败不影响诊断 */
        }
      }
      return { ok: true, chunks }
    },
    async readSessionModel(sessionId) {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
      if (!sessions || typeof sessions.get !== 'function') return { available: false, reason: 'sessions 服务不可用' }
      const session = sessions.get(sessionId)
      if (!session) return { available: false, reason: `会话 ${sessionId} 不在内存中` }
      const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
      const state = projections?.stateOf?.(session, 'modelSelection') ?? null
      return {
        available: true,
        selection: state,
        defaultModel: (() => {
          try {
            return ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
          } catch {
            return null
          }
        })()
      }
    },
    async listSessions() {
      const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
      if (!controller || typeof controller.list !== 'function') return []
      const raw = await controller.list()
      const items = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.items)
          ? raw.items
          : Array.isArray(raw?.sessions)
            ? raw.sessions
            : []
      return items.slice(0, 50).map((item) => ({
        id: item.id ?? item.sessionId ?? null,
        cwd: item.cwd ?? null,
        title: item.title ?? null,
        updatedAt: item.updatedAt ?? null
      }))
    },
    async selectModel(request) {
      const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
      if (!controller || typeof controller.selectModel !== 'function') {
        throw new Error('sessionController 不可用')
      }
      if (!request.sessionId) throw new Error('缺少 sessionId')
      // 切到虚拟 provider 前先确认 adapter 真的在：否则切过去后用户一发消息就
      // `no adapter registered for provider "autopilot"`，还把会话卡在一个坏路由上。
      if (request.provider === AUTOPILOT_PROVIDER && !adapterControl.isPresent()) {
        throw new Error('autopilot adapter 当前未注册，稍等几秒再试（插件正在自动重连）')
      }
      const selection = {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort })
      }
      const selected = await controller.selectModel({
        sessionId: request.sessionId,
        ...selection
      })
      // 宿主的 saveSelection 在 configEditor 缺失时静默放弃（本机就是 disabled），
      // 所以这里自己把默认模型写进 profile patch —— 否则 DSH 一重启就掉回旧默认，
      // 用户看到的就是「重启后又卡住、插件没切换」（其实请求根本没经过插件）。
      let persisted = null
      try {
        persisted = persistDefaultModel({ dshHome: dshHomePath, selection, logger })
      } catch (error) {
        logger.warn?.(`model-autopilot: 默认模型落盘失败（${failureOf(error).message}）`)
      }
      return { ...(selected ?? {}), persisted }
    },
    status: () => ({
      ...pool.stats(),
      autopilot: autopilot.status(),
      probe: prober.status(),
      quotaIntel: quotaIntel.status(),
      adapter: adapterControl.status(),
      /** 真实请求进入 autopilot 的直接证据（调用次数 + 最后一次选型）。 */
      autopilotCalls: autopilotAdapter?.stats?.() ?? null,
      catalogFilter: { installed: catalogInstalled && config.catalogFilter.enabled, ...catalogFilter.stats() },
      providerErrors: pool.snapshot().providerErrors
    })
  }

  // ⑥ 浏览器半身的注册自愈（并落盘原因，便于诊断「入口没出现」）。
  //    运行时注入的 client 行经常没进 client-modules 的表；这一步与注入器的
  //    refreshClientRow 做同一件事，失败原因写进池状态 meta。
  const clientHalf = ensureClientHalf(ctx, {
    // lib/index.js 与 lib/client.js 同级：这一步只用来在宿主解析不到时补缓存。
    clientPath: fileURLToPath(new URL('./client.js', import.meta.url)),
    onUpdate: (result) => {
      try {
        store.setMeta?.({ clientHalf: result })
      } catch {
        /* 落盘失败不影响运行 */
      }
    }
  })
  try {
    store.setMeta?.({ clientHalf })
  } catch {
    /* 落盘失败不影响运行 */
  }
  if (!clientHalf.ok) {
    logger.warn?.(`model-autopilot: 左侧栏入口未注册 (${clientHalf.reason ?? '未知原因'})`)
  }

  // ⑦ 浏览器半身的数据通道（左侧栏面板读它）。只在宿主有 webServer 时挂载；
  //    没有 HTTP 服务的组合里面板不可用，但不影响选型/切换本身。
  mountApi({ ctx, handler: createApiHandler({ service: activeService, logger }), logger })
}
