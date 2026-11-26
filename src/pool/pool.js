/**
 * 模型池：把「6 家模型商的模型」与「免费模型插件（如 dsh-our-free-model）」统一成
 * 可调度条目，并承载所有状态（健康、失败计数、冷却、探针结果、屏蔽标记）。
 *
 * 数据来源是宿主事实，不是配置文件：
 *   ctx.llm.listProviders()                    → provider 清单
 *   ctx.llm.listModels(providerId)             → 该 provider 的模型清单（含 provider 字段）
 *   ctx.llm.resolveModelInfo(providerId, id)   → 上下文窗口 / 模态 / reasoning 能力
 * 配置只负责三件事：谁是免费、优先级多少、参数阈值。
 *
 * @module pool/pool
 */
import { isFreeProvider, freeClassOf } from '../config.js'
import { lookupByFamily, matchesProviderList } from './provider-id.js'
import { entryKey } from './types.js'
import { transition, transitionSuccess, transitionFailure, shouldHide } from './transitions.js'
import { runLimited, failureOf, compact } from '../util.js'

/**
 * @typedef {import('./types.js').ModelEntry} ModelEntry
 * @typedef {import('./types.js').ProbeVerdict} ProbeVerdict
 */

/**
 * @param {object} options
 * @param {{ llm: any, logger?: any }} options.ctx
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} options.config
 * @param {ReturnType<typeof import('../store.js').createJsonStore>} options.store
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 */
export function createPool({ ctx, config, store, logger = console }) {
  /** @type {Map<string, ModelEntry>} */
  const entries = new Map()
  /** @type {Map<string, string>} providerId → 最近一次枚举/解析失败信息 */
  const providerErrors = new Map()
  /** @type {Set<(snapshot: PoolSnapshot) => void>} */
  const listeners = new Set()
  /** @type {Promise<void> | null} */
  let reloading = null
  let lastReloadAt = 0
  /**
   * 未经界面过滤的目录读取口。catalog-filter 装上 `ctx.llm.listModels` 之后，
   * 池必须绕开包装读全量，否则被隐藏的条目会从池里消失、再也探不到也恢复不了。
   * @type {null | ((provider: string) => Promise<readonly any[]>)}
   */
  let rawListModels = null

  /**
   * @typedef {object} PoolSnapshot
   * @property {readonly ModelEntry[]} entries
   * @property {readonly { id: string, error: string }[]} providerErrors
   * @property {number} updatedAt
   */

  /** @returns {ModelEntry[]} */
  function listAll() {
    return [...entries.values()]
  }

  /** @returns {PoolSnapshot} */
  function snapshotOf() {
    return {
      entries: listAll(),
      providerErrors: [...providerErrors.entries()].map(([id, error]) => ({ id, error })),
      updatedAt: lastReloadAt || Date.now()
    }
  }

  function emitChange() {
    const snapshot = snapshotOf()
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        logger.warn?.(`model-autopilot: pool listener failed (${failureOf(error).message})`)
      }
    }
  }

  /** @param {string} key */
  function persist(key) {
    const entry = entries.get(key)
    if (!entry) return
    // catalogFilter 关闭时 hiddenFromPicker 毫无意义（选择界面不做屏蔽），
    // 写下去只会攒出一堆「开启后一次性消失 N 条模型」的暗雷。
    const catalogEnabled = config.catalogFilter?.enabled === true
    // 写盘失败**绝不能**冒泡：persist() 由 apply() 调用，而 apply() 在
    // markFailure()/markSuccess() 里 —— 后者又位于 failover 的「模型尝试失败」
    // catch 块内。写盘异常一旦冒泡，会穿透整个 run()，把「磁盘故障」当成致命
    // 错误，切换链路当场断掉（用户看到的是「因为 disk full 而没切换」）。
    // 状态仍在内存里，调度不受影响 —— 磁盘满只该丢一点持久化，不该停工。
    try {
      store.setModel(key, {
        failCount: entry.failCount,
        cooldownUntil: entry.cooldownUntil,
        nextProbeAt: entry.nextProbeAt,
        health: entry.health,
        hiddenFromPicker: catalogEnabled ? entry.hiddenFromPicker === true : false,
        lastProbe: entry.lastProbe
      })
    } catch (error) {
      logger.warn?.(
        `model-autopilot: 池状态写入失败（${entry.key}）：${failureOf(error).message}` +
          '（状态仍在内存中，不影响调度）'
      )
    }
  }

  /**
   * 用一次判决更新条目，并广播。
   * @param {string} key
   * @param {Partial<ModelEntry>} patch
   */
  function apply(key, patch) {
    const entry = entries.get(key)
    if (!entry) return
    // catalogFilter 关闭时不允许把 hiddenFromPicker 置 true：
    // 面板不做屏蔽，这个标记只会变成存档里的脏数据。
    const next =
      config.catalogFilter?.enabled === true
        ? patch
        : /** @type {Partial<ModelEntry>} */ ({ ...patch, hiddenFromPicker: false })
    Object.assign(entry, compact(next))
    persist(key)
    emitChange()
  }

  /**
   * 枚举宿主当前事实，重建池。持久化状态按 key 恢复，不丢失败计数与冷却。
   * 并发调用合并成一次（宿主 llm/adapters-updated 可能连发）。
   * @returns {Promise<void>}
   */
  function reload() {
    if (reloading) return reloading
    reloading = (async () => {
      const llm = ctx?.llm
      if (!llm || typeof llm.listProviders !== 'function') {
        throw new Error('model-autopilot: ctx.llm.listProviders 不可用（llm 服务未装配）')
      }
      const providers = llm.listProviders()
      providerErrors.clear()
      /** 被 config.schedule.excludeProviders 挡在池外的 provider（诊断用）。 */
      const excludedProviders = []
      /** @type {Map<string, ModelEntry>} */
      const next = new Map()
      const now = Date.now()

      await runLimited(providers, 4, async (provider) => {
        const providerId = provider?.id
        if (typeof providerId !== 'string' || providerId === '') return
        // 本插件自己注册的虚拟 provider 必须排除在外（否则探测/调度会递归回自己）。
        if (matchesProviderList(providerId, config.schedule.excludeProviders)) {
          excludedProviders.push(providerId)
          return
        }
        const free = isFreeProvider(providerId, config)
        const priority = free
          ? config.free.priorityBonus
          : (lookupByFamily(providerId, config.paid.priorities) ?? config.paid.defaultPriority)

        /** @type {any[]} */
        let models = []
        try {
          // 有未过滤的读取口就走它：池的视野必须是全量。
          models = rawListModels ? await rawListModels(providerId) : await llm.listModels(providerId)
        } catch (error) {
          providerErrors.set(providerId, failureOf(error).message)
          return
        }
        if (!Array.isArray(models)) {
          providerErrors.set(providerId, 'listModels 返回的不是数组')
          return
        }

        for (const model of models) {
          const modelId = model?.id
          if (typeof modelId !== 'string' || modelId === '') continue
          const key = entryKey(providerId, modelId)
          const previous = entries.get(key)
          const saved = store.model(key)

          // 能力信息单独失败不算致命：listModels 已经给了 id/name/模态。
          let info = null
          try {
            info = typeof llm.resolveModelInfo === 'function' ? await llm.resolveModelInfo(providerId, modelId) : null
          } catch {
            info = null
          }

          next.set(key, {
            key,
            provider: providerId,
            model: modelId,
            name: typeof model?.name === 'string' && model.name !== '' ? model.name : modelId,
            cost: free ? 'free' : 'paid',
            priority,
            contextWindow: typeof info?.context?.contextWindow === 'number' ? info.context.contextWindow : 0,
            inputModalities: Array.isArray(info?.inputModalities)
              ? [...info.inputModalities]
              : Array.isArray(model?.inputModalities)
                ? [...model.inputModalities]
                : ['text'],
            reasoning: Boolean(info?.reasoning?.efforts?.length),
            health: previous?.health ?? saved?.health ?? 'unknown',
            failCount: previous?.failCount ?? saved?.failCount ?? 0,
            // 输出被 max_tokens 截断的次数：只用于降权，不算失败。
            truncatedCount: previous?.truncatedCount ?? saved?.truncatedCount ?? 0,
            cooldownUntil: previous?.cooldownUntil ?? saved?.cooldownUntil ?? 0,
            nextProbeAt: previous?.nextProbeAt ?? saved?.nextProbeAt ?? 0,
            halfOpen: false,
            hiddenFromPicker: previous?.hiddenFromPicker ?? saved?.hiddenFromPicker ?? false,
            lastProbe: previous?.lastProbe ?? saved?.lastProbe ?? null,
            providerError: null
          })
        }
      })

      entries.clear()
      for (const [key, entry] of next) entries.set(key, entry)
      lastReloadAt = now

      // 曾经存在、这次枚举不到的条目：从池里移除，但保留持久化状态，
      // 以便插件被临时摘除后又挂回来时冷却/失败计数还在。
      for (const listener of listeners) {
        try {
          listener(snapshotOf())
        } catch {
          /* 同 emitChange 的容错 */
        }
      }

      if (providerErrors.size > 0) {
        logger.warn?.(
          `model-autopilot: ${providerErrors.size} 个 provider 枚举失败（${[...providerErrors.keys()].join(', ')}）`
        )
      }
      // 落盘 provider 清单与枚举错误：诊断“某个模型商为什么不在池里”时，
      // 这是唯一能看的一手证据（宿主日志不一定取得到）。
      store.setMeta?.({
        providers: providers.map((provider) => ({
          id: provider?.id ?? '',
          name: provider?.name ?? '',
          free: provider?.id ? isFreeProvider(provider.id, config) : false,
          freeSource: provider?.id ? freeClassOf(provider.id, config) : null,
          error: provider?.id ? (providerErrors.get(provider.id) ?? null) : null,
          // 原始元数据里的标量字段：判断“这个 provider 属于哪个插件”要靠它
          // （settingsNs / plugin / adapter 之类），不落盘就无从诊断。
          raw: scalarFields(provider)
        })),
        entryCount: entries.size,
        excludedProviders
      })
      logger.info?.(`model-autopilot: 模型池已装载 ${entries.size} 个条目 / ${providers.length} 个 provider`)
    })().finally(() => {
      reloading = null
    })
    return reloading
  }

  const api = {
    reload,
    /**
     * 注入「未过滤目录」的读取口（catalog-filter 安装后由 index 调用）。
     * 传 null 恢复默认（直接读 ctx.llm.listModels）。
     * @param {null | ((provider: string) => Promise<readonly any[]>)} fn
     */
    setRawListModels(fn) {
      rawListModels = typeof fn === 'function' ? fn : null
    },
    /** @returns {readonly ModelEntry[]} */
    all: listAll,
    /** @param {string} key @returns {ModelEntry | undefined} */
    get(key) {
      return entries.get(key)
    },
    /** 免费条目（成本维度），供探针优先探。 @returns {ModelEntry[]} */
    freeEntries: () => listAll().filter((entry) => entry.cost === 'free'),
    /**
     * 写回一次探针判决。
     * @param {string} key
     * @param {ProbeVerdict} verdict
     * @param {{ at?: number, latencyMs?: number, detail?: string }} [meta]
     */
    markProbe(key, verdict, meta = {}) {
      const entry = entries.get(key)
      if (!entry) return
      const patch = transition(entry, verdict, { at: meta.at ?? Date.now(), ...meta }, config)
      apply(key, patch)
    },
    /**
     * 延长冷却到至少 minMs（只延不缩）。
     * 用于「额度耗尽」这类不会在默认冷却窗口内恢复的失败。
     * @param {string} key
     * @param {number} minMs
     * @param {number} [now]
     */
    extendCooldown(key, minMs, now = Date.now()) {
      const entry = entries.get(key)
      if (!entry) return
      const target = now + minMs
      if (target <= entry.cooldownUntil) return
      apply(key, { cooldownUntil: target, health: entry.health === 'available' ? 'cooling' : entry.health })
    },
    /**
     * 真实调用成功：比探针更强的一手证据，直接清零并取消屏蔽。
     * @param {string} key
     * @param {number} [at]
     */
    markSuccess(key, at = Date.now()) {
      const entry = entries.get(key)
      if (!entry) return
      apply(key, transitionSuccess(entry, at, config))
    },
    /**
     * 真实调用失败：与探针共用冷却规则，但不动 lastProbe（那不是探测结果）。
     * @param {string} key
     * @param {ProbeVerdict} verdict
     * @param {number} [at]
     */
    markFailure(key, verdict, at = Date.now()) {
      const entry = entries.get(key)
      if (!entry) return
      apply(key, transitionFailure(entry, verdict, at, config))
    },
    /**
     * 输出被 max_tokens 截断：**不是失败**，不进冷却、不升 failCount。
     *
     * 只累计一个降权信号：下次调度优先挑输出预算更大的模型。理由是模型本身
     * 没坏（它正常回答到预算上限），判失败会让它白冷却 30 分钟；但它的上限
     * 确实不够用，所以要让位给能写完整回答的通道。
     *
     * @param {string} key
     * @param {number} [at]
     */
    markTruncated(key, at = Date.now()) {
      const entry = entries.get(key)
      if (!entry) return
      const next = {
        ...entry,
        truncatedCount: (entry.truncatedCount ?? 0) + 1,
        lastTruncatedAt: at
      }
      apply(key, next)
    },
    /**
     * 是否从模型选择界面屏蔽。支持 (provider, model) 与 (entry) 两种调用。
     * @param {string | ModelEntry} providerOrEntry
     * @param {string} [model]
     * @param {number} [now]
     * @returns {boolean}
     */
    shouldHide(providerOrEntry, model, now = Date.now()) {
      const entry =
        typeof providerOrEntry === 'string'
          ? entries.get(entryKey(providerOrEntry, model ?? ''))
          : providerOrEntry
      if (!entry) return false
      return shouldHide(entry, now, config)
    },
    /**
     * 某 provider 下还有几个可见模型 —— catalog 层用它做「不屏蔽唯一可用项」判断。
     * @param {string} provider
     * @param {number} [now]
     * @returns {number}
     */
    visibleCountFor(provider, now = Date.now()) {
      let count = 0
      for (const entry of entries.values()) {
        if (entry.provider !== provider) continue
        if (!shouldHide(entry, now, config)) count += 1
      }
      return count
    },
    /** @returns {PoolSnapshot} */
    snapshot: snapshotOf,
    /**
     * @param {(snapshot: PoolSnapshot) => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 统计口径，面板与日志共用。 @param {number} [now] */
    stats(now = Date.now()) {
      /** @type {Record<string, number>} */
      const byHealth = {}
      let free = 0
      let paid = 0
      let hidden = 0
      for (const entry of entries.values()) {
        byHealth[entry.health] = (byHealth[entry.health] ?? 0) + 1
        if (entry.cost === 'free') free += 1
        else paid += 1
        if (shouldHide(entry, now, config)) hidden += 1
      }
      return { total: entries.size, free, paid, hidden, byHealth }
    }
  }

  return api
}

/**
 * 只取 provider 元数据里的标量字段，避免把整个 adapter 对象落进存档。
 * @param {unknown} value
 * @returns {Record<string, string | number | boolean>}
 */
function scalarFields(value) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {}
  if (typeof value !== 'object' || value === null) return out
  for (const [key, item] of Object.entries(/** @type {any} */ (value))) {
    const type = typeof item
    if (type === 'string') out[key] = item.length > 200 ? `${item.slice(0, 197)}...` : item
    else if (type === 'number' || type === 'boolean') out[key] = item
  }
  return out
}
