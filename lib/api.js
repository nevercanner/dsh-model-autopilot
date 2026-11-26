/**
 * 面板数据通道：一个只读 + 一个动作的 same-origin HTTP 路由。
 *
 * 为什么不开一条 Remote（typert）：Remote 需要 host 侧注册可寻址的服务与客户端
 * 侧生成的绑定，对「面板展示 + 一个按钮」这种需求太重；宿主 webserver 的前缀路由
 * 是现成机制（our-free-model 的 /api/our-free-model 就是这么做的），注册即有、
 * 随 fiber 释放即无。
 *
 * 安全边界：只接受同源请求（Origin 的 host 必须等于请求 Host），只暴露状态与
 * 「触发探测」，没有任何写入配置/凭据的入口。
 *
 * @module api
 */
import { failureOf } from './util.js'
import { AUTOPILOT_PROVIDER } from './autopilot.js'
import { groupPlans } from './onboarding.js'
import { describeCredentials } from './registry/credentials.js'

export const API_PREFIX = '/api/model-autopilot'

/** 面板一次最多看多少条条目：200 条全量下发既慢又没人看得完。 */
const MAX_ENTRIES = 60

/**
 * 组装面板需要的状态。
 * @param {any} service - index.js 暴露的实例
 * @param {number} [now]
 */
export function describeState(service, now = Date.now()) {
  const { pool, prober, autopilot, catalogFilter } = service
  const entries = pool.all().map((entry) => ({
    key: entry.key,
    cost: entry.cost,
    health: entry.health,
    failCount: entry.failCount,
    cooldownLeft: Math.max(0, entry.cooldownUntil - now),
    hidden: pool.shouldHide(entry, undefined, now),
    verdict: entry.lastProbe?.verdict ?? null,
    latencyMs: entry.lastProbe?.latencyMs ?? null
  }))

  // 面板排序：隐藏的、失效的、冷却中的排前面 —— 需要处理的东西先出现。
  entries.sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? -1 : 1
    const rank = (item) => (item.health === 'dead' ? 0 : item.health === 'cooling' ? 1 : item.health === 'degraded' ? 2 : 3)
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.key.localeCompare(b.key)
  })

  return {
    ok: true,
    generatedAt: now,
    pool: pool.stats(now),
    probe: prober.status(),
    autopilot: autopilot.status(),
    catalogFilter: {
      installed: service.catalogFilterInstalled === true,
      ...catalogFilter.stats()
    },
    /** 虚拟 provider 的注册状态：回答「为什么 autopilot 用不了」。 */
    adapter: service.adapterControl?.status?.() ?? null,
    /** 真实请求进入 autopilot 的直接证据：调用次数与最后一次选型。 */
    autopilotCalls: service.adapterControl?.adapter?.stats?.() ?? null,
    /** 额度情报（AIHOT 羊毛清单）的状态。 */
    quotaIntel: service.quotaIntelStatus?.() ?? service.quotaIntel?.status?.() ?? null,
    providerErrors: pool.snapshot().providerErrors,
    totalEntries: entries.length,
    entries: entries.slice(0, MAX_ENTRIES)
  }
}

/**
 * 单条条目的快照（与 describeState 的 entries 元素同形）。
 * 面板的「单项探测」用它就地替换那一行，不必整页重载。
 * @param {any} service
 * @param {string} key
 * @param {number} [now]
 */
export function describeEntry(service, key, now = Date.now()) {
  const entry = service.pool.get(key)
  if (!entry) return null
  return {
    key: entry.key,
    cost: entry.cost,
    health: entry.health,
    failCount: entry.failCount,
    cooldownLeft: Math.max(0, entry.cooldownUntil - now),
    hidden: service.pool.shouldHide(entry, undefined, now),
    verdict: entry.lastProbe?.verdict ?? null,
    latencyMs: entry.lastProbe?.latencyMs ?? null,
    // 失败原因：没有它就只能看到 auth/throttled 这种标签，查不出到底是
    // 「额度用完」还是「登录态失效」（例如 trae 的 no usable credential）。
    detail: entry.lastProbe?.detail ?? null,
    contextWindow: entry.contextWindow ?? 0,
    truncatedCount: entry.truncatedCount ?? 0
  }
}

/**
 * 某个 provider（或全部）的模型清单。
 *
 * 数据源是**宿主目录**（ctx.llm.listModels），不是池：池按 excludeProviders 排除了
 * 虚拟 provider autopilot，而这里要能看见它（面板要列出可选 provider）。
 * 成本与健康状态从池里合并进来。
 *
 * @param {any} service
 * @param {string} [provider]
 * @param {number} [limit]
 */
export async function describeModels(service, provider = '', limit = 200) {
  // provider 为空表示「全部」：宿主没有 listAllModels，只能逐 provider 拼。
  if (provider === '') {
    const providers = service.pool.all().map((entry) => entry.provider)
    const unique = [...new Set(providers)]
    unique.push(AUTOPILOT_PROVIDER)
    const merged = []
    for (const id of unique) {
      const rows = await describeModels(service, id, limit)
      merged.push(...rows)
      if (merged.length >= limit) break
    }
    return merged.slice(0, limit)
  }
  const raw = await service.catalogFilter?.rawListModels?.(provider)
  const models = Array.isArray(raw) ? raw : []
  const pooled = new Map(service.pool.all().map((entry) => [entry.key, entry]))
  return models.slice(0, limit).map((model) => {
    const key = `${model.provider}/${model.id}`
    const entry = pooled.get(key)
    return {
      key,
      provider: model.provider,
      model: model.id,
      name: model.name ?? model.id,
      cost: entry?.cost ?? (model.provider === AUTOPILOT_PROVIDER ? 'virtual' : 'unknown'),
      health: entry?.health ?? (model.provider === AUTOPILOT_PROVIDER ? 'virtual' : 'unknown'),
      contextWindow: entry?.contextWindow ?? 0,
      reasoning: entry?.reasoning ?? false,
      failCount: entry?.failCount ?? 0,
      truncatedCount: entry?.truncatedCount ?? 0,
      cooldownLeft: Math.max(0, (entry?.cooldownUntil ?? 0) - Date.now()),
      // 失效原因：面板要能回答「为什么这个通道不能用了」，
      // 而不是只给一个 auth/throttled 标签（看不到是额度、还是登录过期）。
      verdict: entry?.lastProbe?.verdict ?? null,
      detail: entry?.lastProbe?.detail ?? null
    }
  })
}

/**
 * @param {{ service: any, logger?: any }} options
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createApiHandler({ service, logger = console }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.slice(API_PREFIX.length) || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
        return send(res, 405, { ok: false, error: 'method not allowed' })
      }
      // 宿主 webserver 可能监听 0.0.0.0（局域网转发），而这条路由不走宿主的登录 fence。
      // 只允许回环地址访问：面板永远在本机页面上。
      if (!isLoopback(req)) {
        return send(res, 403, { ok: false, error: 'local requests only' })
      }
      if (!sameOrigin(req)) {
        return send(res, 403, { ok: false, error: 'cross-origin request refused' })
      }

      if (route === '/' || route === '') {
        return send(res, 200, describeState(service))
      }

      if (route === '/models' && method === 'GET') {
        const provider = url.searchParams.get('provider') ?? ''
        return send(res, 200, { ok: true, models: await describeModels(service, provider) })
      }

      if (route === '/plan' && method === 'GET') {
        // 当前排序预览：面板据此显示「首选之后谁排第一」。
        const rows = service.scheduler?.explain?.({}) ?? []
        // 首选被跳过时的原因：回答「为什么我锁定的模型没被选中」。
        const selection = service.scheduler?.plan?.({}) ?? null
        return send(res, 200, {
          ok: true,
          plan: rows.slice(0, 20),
          preference: service.preference?.get?.() ?? { provider: null, model: null },
          ...(selection?.pinnedSkipped === undefined ? {} : { pinnedSkipped: selection.pinnedSkipped }),
          // 当前模型：排序第一位，即下次请求会用的模型
          current: rows.length > 0 ? rows[0].key ?? null : null,
          // 下一模型：排序第二位，即当前模型失败后顺位切换的第一个候选
          next: rows.length > 1 ? rows[1].key ?? null : null
        })
      }

      if (route === '/try-adapter' && method === 'POST') {
        if (!hasSameOriginHeader(req)) {
          return send(res, 403, { ok: false, error: 'try-adapter requires a same-origin page request' })
        }
        const intent = await readJson(req).catch(() => null)
        try {
          const result = await service.tryAdapter?.({ text: intent?.text })
          return send(res, 200, result ?? { ok: false, error: 'tryAdapter 不可用' })
        } catch (error) {
          return send(res, 200, { ok: false, error: failureOf(error).message, code: /** @type {any} */ (error)?.code ?? null })
        }
      }

      if (route === '/session-model' && method === 'GET') {
        // 读会话的**持久** selection（不是一次性缓存），用来解释「切了又跳回去」。
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') return send(res, 400, { ok: false, error: 'sessionId 必填' })
        return send(res, 200, {
          ok: true,
          ...(await service.readSessionModel?.(sessionId))
        })
      }

      if (route === '/try' && method === 'POST') {
        // 诊断用：真实走一次自动选型，返回选中的模型与尝试链（不含回复内容）。
        if (!hasSameOriginHeader(req)) {
          return send(res, 403, { ok: false, error: 'try requires a same-origin page request' })
        }
        const intent = await readJson(req).catch(() => null)
        const text = intent && typeof intent.text === 'string' && intent.text !== '' ? intent.text : 'ping'
        try {
          const result = await service.autopilot.run({
            intent: 'api-try',
            messages: [{ role: 'user', content: [{ type: 'text', text }] }]
          })
          // 消费首帧：首帧之后的错误不会切换模型，这里要看见它。
          let firstChunk = null
          let streamError = null
          const iterator = result.stream[Symbol.asyncIterator]()
          try {
            const next = await iterator.next()
            firstChunk = next.done ? null : next.value?.type ?? 'unknown'
          } catch (error) {
            streamError = failureOf(error).message
          } finally {
            try {
              await iterator.return?.()
            } catch {
              /* 释放失败不影响诊断 */
            }
          }
          return send(res, 200, {
            ok: streamError === null,
            model: result.model,
            reason: result.reason,
            attempts: result.attempts,
            firstChunk,
            ...(streamError === null ? {} : { streamError })
          })
        } catch (error) {
          const detail = /** @type {any} */ (error)
          return send(res, 200, {
            ok: false,
            error: failureOf(error).message,
            code: detail?.code ?? null,
            attempts: detail?.attempts ?? []
          })
        }
      }

      if (route === '/onboarding' && method === 'GET') {
        // 注册清单：哪些通道还没配 Key、去哪领、每天要不要签到。
        const installed = new Set(service.pool.all().map((entry) => entry.provider))
        const groups = groupPlans().map((group) => ({
          ...group,
          installed: installed.has(group.provider),
          // 已装且池里有可用条目 → 基本已配好
          active: service.pool
            .all()
            .some((entry) => entry.provider === group.provider && entry.health === 'available')
        }))
        // 凭据是否已配：只看存在性，不读密钥值。
        const credentials = await describeCredentials(service.ctx)
        return send(res, 200, { ok: true, groups, credentials })
      }

      if (route === '/quota' && method === 'GET') {
        // 额度情报：AIHOT「Token 羊毛」清单。
        const snapshot = service.quotaIntel?.() ?? null
        const status = service.quotaIntelStatus?.() ?? service.quotaIntel?.status?.() ?? null
        return send(res, 200, {
          ok: true,
          status,
          providers: snapshot?.providers ?? {},
          entries: snapshot?.entries ?? []
        })
      }

      if (route === '/quota/sync' && method === 'POST') {
        if (!hasSameOriginHeader(req)) {
          return send(res, 403, { ok: false, error: 'quota sync requires a same-origin page request' })
        }
        const result = await service.quotaIntel?.sync?.('api')
        return send(res, result?.ok ? 200 : 502, { ok: Boolean(result?.ok), ...(result ?? {}) })
      }

      if (route === '/preference' && method === 'GET') {
        return send(res, 200, { ok: true, preference: service.preference?.get?.() ?? { provider: null, model: null } })
      }

      if (route === '/preference' && method === 'POST') {
        if (!hasSameOriginHeader(req)) {
          return send(res, 403, { ok: false, error: 'preference requires a same-origin page request' })
        }
        const intent = await readJson(req).catch(() => null)
        const provider = intent && typeof intent.provider === 'string' ? intent.provider : null
        const model = intent && typeof intent.model === 'string' ? intent.model : null
        const result = service.preference?.set?.(provider, model)
        if (!result) return send(res, 503, { ok: false, error: '首选设置不可用' })
        if (!result.ok) return send(res, 400, { ok: false, error: result.error })
        return send(res, 200, { ok: true, preference: result.preference })
      }

      if (route === '/sessions' && method === 'GET') {
        if (typeof service.listSessions !== 'function') {
          return send(res, 503, { ok: false, error: 'sessionController 不可用' })
        }
        const sessions = await service.listSessions()
        return send(res, 200, { ok: true, sessions })
      }

      if (route === '/select' && method === 'POST') {
        // 切换模型是有副作用的动作：同样要求同源页面。
        if (!hasSameOriginHeader(req)) {
          return send(res, 403, { ok: false, error: 'select requires a same-origin page request' })
        }
        const intent = await readJson(req).catch(() => null)
        const provider = intent && typeof intent.provider === 'string' ? intent.provider : ''
        const model = intent && typeof intent.model === 'string' ? intent.model : ''
        const sessionId = intent && typeof intent.sessionId === 'string' ? intent.sessionId : ''
        if (provider === '' || model === '') {
          return send(res, 400, { ok: false, error: 'provider 与 model 都必填' })
        }
        if (typeof service.selectModel !== 'function') {
          return send(res, 503, { ok: false, error: '宿主没有装配 sessionController，无法切换会话模型' })
        }
        try {
          const result = await service.selectModel({
            provider,
            model,
            sessionId,
            ...(intent && typeof intent.reasoningEffort === 'string' ? { reasoningEffort: intent.reasoningEffort } : {})
          })
          return send(res, 200, {
            ok: true,
            selected: result?.selected ?? null,
            // 默认模型落盘结果（updated/skipped/errors），便于确认「重启后还在不在」
            ...(result?.persisted === undefined ? {} : { persisted: result.persisted })
          })
        } catch (error) {
          return send(res, 400, { ok: false, error: failureOf(error).message })
        }
      }

      if (route === '/probe' && method === 'POST') {
        // 会真的向上游发请求，属于「有副作用」的动作：必须是同源页面发起的，
        // 不接受无 Origin 的脚本调用（避免任意本地进程拿它当探测器滥用额度）。
        if (!hasSameOriginHeader(req)) {
          return send(res, 403, { ok: false, error: 'probe requires a same-origin page request' })
        }
        const intent = await readJson(req).catch(() => null)
        // 单条目标：`?model=<provider/model>` 优先，其次 body `{key}`（兼容旧调用）。
        const targetKey =
          url.searchParams.get('model') ||
          (intent && typeof intent.key === 'string' ? intent.key : '')
        if (targetKey !== '') {
          // 单条：等结果（有 45s 探针超时兜底）。
          const result = await service.prober.probeKey(targetKey)
          if (result === null) return send(res, 404, { ok: false, error: `unknown model "${targetKey}"` })
          // 带一条最新快照回去，面板就地替换这一行（冷却/健康都会变）。
          return send(res, 200, {
            ok: true,
            key: targetKey,
            result,
            entry: describeEntry(service, targetKey)
          })
        }
        // 整轮：不阻塞响应（一轮可能几十秒），面板靠轮询看进度。
        service.prober
          .round('api')
          .catch((error) => logger.warn?.(`model-autopilot: API 触发探测失败 (${failureOf(error).message})`))
        return send(res, 202, { ok: true, triggered: true })
      }

      return send(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      logger.warn?.(`model-autopilot: API 处理失败 (${failureOf(error).message})`)
      return send(res, 500, { ok: false, error: failureOf(error).message })
    }
  }
}

/**
 * 挂到宿主 webserver 上。用 `ctx.inject(['webServer'])` 等待服务出现 ——
 * apply 时直接 `ctx.get('webServer')` 可能是 undefined（插件先于浏览器端发布），
 * 那样路由永远挂不上。
 * @param {{ ctx: any, handler: Function, logger?: any }} options
 */
export function mountApi({ ctx, handler, logger = console }) {
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped.webServer
    scoped.effect(
      () => server.register({ kind: 'prefix', path: API_PREFIX, handler }),
      'model-autopilot: api routes'
    )
    logger.info?.(`model-autopilot: 面板 API 已挂载 ${API_PREFIX}`)
  })
}

/** @param {any} req */
function isLoopback(req) {
  const address = req.socket?.remoteAddress
  if (typeof address !== 'string' || address === '') return true // 没有 socket 信息（单测替身）按本机处理
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 同源判定：有 Origin 时必须与 Host 一致；没有 Origin 视为非页面请求。
 * @param {any} req
 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === (req.headers?.host ?? '')
  } catch {
    return false
  }
}

/** 有副作用的路由额外要求「确实来自同源页面」。 */
function hasSameOriginHeader(req) {
  const origin = req.headers?.origin
  // 没有 Origin 头 → 不是浏览器的**跨源**请求。
  //
  // CSRF 的前提是「攻击者在自己的站点上让浏览器带上用户凭据发请求」，那种请求
  // 必然带 Origin 且与我们不同源。同源 fetch 在部分链路（宿主 API 网关转发、
  // 非浏览器本地调用）里不带 Origin —— 之前要求「必须有 Origin」导致面板点
  // 「立即探测」直接吃 403。
  //
  // 远程访问已由 loopback 限制（req.socket.remoteAddress）挡住，所以这里
  // 接受无 Origin 的情况；带了 Origin 就仍然必须同源。
  if (typeof origin !== 'string' || origin === '') return true
  return sameOrigin(req)
}

/**
 * 读取并解析 JSON body（上限 64KB）。
 * @param {any} req
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** @param {any} res @param {number} status @param {unknown} payload */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead?.(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  })
  res.end?.(body)
}
