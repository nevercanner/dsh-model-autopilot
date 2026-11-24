/**
 * 故障切换主循环。
 *
 * 核心是一个容易被忽略的约束：**只有首帧之前才能切换模型**。
 * 一旦已经向调用方吐过一个 token，这次请求的语义就绑定了那个模型 —— 再换一个
 * 模型重放，用户会看到两段不同模型写的东西。所以这里对每个候选先「偷看首块」：
 * 首块能拿到才算这次尝试成立，首块是失败再换下一个。首块之后的错误只记一次失败
 * 并上抛，由 agent loop 决定怎么显示。
 *
 * 写回池的时机：成功 → markSuccess（清零失败计数、解除屏蔽）；
 * 失败 → markFailure（与探针共用同一套冷却规则）。
 *
 * @module failover/failover
 */
import { classifyError, classifyFailure } from '../probe/classify.js'
import { backoffDelay, isRetryableVerdict } from './breaker.js'
import { detailOf } from '../pool/types.js'
import { sleep } from '../util.js'

/**
 * @typedef {object} AttemptRecord
 * @property {string} key
 * @property {boolean} ok
 * @property {string} [verdict]
 * @property {number} retry
 * @property {number} latencyMs
 * @property {string} [detail]
 */

/** 判决 → 宿主错误码（决定 agent loop 是否重试整轮）。 */
const CODE_OF_VERDICT = Object.freeze({
  throttled: 'RATE_LIMIT',
  timeout: 'TIMEOUT',
  unavailable: 'SERVER',
  auth: 'INVALID_CREDENTIAL',
  empty: 'EMPTY_RESPONSE',
  'region-blocked': 'SERVER',
  // 输出被 max_tokens 截断。宿主侧的 `finish.reason.kind === 'max-tokens'`。
  truncated: 'MAX_TOKENS'
})

/**
 * 耗尽原因码。
 *
 * 为什么要把「耗尽原因」和「最后一次失败的语义」分开：
 *   两者是**不同维度**。同样是 RATE_LIMIT 收尾，可能是「池子里真没有能用的」
 *   （候选耗尽），也可能是「时间不够、还没试完」（预算耗尽）。共用一个 code 时，
 *   调用方/宿主无法区分，排查时会走错方向 —— 看到 RATE_LIMIT 以为该等冷却，
 *   实际是预算太小该调 maxTotalMs。
 *
 * 因此：
 *   error.code          = 耗尽原因码（下面这两个之一）
 *   error.lastVerdictCode = 最后一次失败的具体语义（RATE_LIMIT / TIMEOUT / SERVER…）
 */
export const EXHAUSTED_CODE = Object.freeze({
  /** 时间/尝试预算已用尽，**不是**没模型可用。 */
  budget: 'AUTOPILOT_BUDGET_EXHAUSTED',
  /** 还有候选但全部失败，或已没有更多候选。 */
  candidates: 'AUTOPILOT_CANDIDATES_EXHAUSTED'
})

/**
 * @typedef {object} AutopilotCall
 * @property {any[]} messages
 * @property {string} [system]
 * @property {any[]} [tools]
 * @property {any} [toolHistory]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {string[]} [stop]
 * @property {string} [reasoningEffort]
 * @property {AbortSignal} [signal]
 */

/**
 * @param {Error & { verdict?: string }} error
 * @param {import('../pool/types.js').ProbeVerdict} verdict
 */
function withVerdict(error, verdict) {
  error.verdict = verdict
  return error
}

/** 把宿主的 LlmFailure 变成带 verdict 的 Error，便于统一处理。 */
function failureError(failure) {
  const error = new Error(failure?.message ?? 'upstream failure')
  error.name = 'AutopilotUpstreamError'
  error.code = failure?.code
  return withVerdict(error, classifyFailure(failure))
}

/**
 * 打开一个候选模型的流，并「偷看」到第一个**语义帧**。
 *
 * 两个硬要求：
 *
 * 1. 不能只看第一块：上游常常先发 `usage` / `step-start` 之类的元数据帧，
 *    额度耗尽之类的失败可能是**先 usage、再 error finish**。只看首块会把它当成
 *    「成功」返回给调用方，结果是：不在候选间切换、错误在流中途才炸出来、
 *    最后由宿主回退默认模型 —— 表现就是「失败了却没有自动切换」。
 *
 * 2. 必须有首帧超时：provider 可能接受请求却一直不吐数据（上游卡死、连接半开、
 *    网关排队）。没有上限，整条会话会无限挂起（用户看到的就是「卡了」），
 *    而宿主的 stream idle 超时管不到首帧之前这一段。
 *
 * 判定点：
 *   text/reasoning/tool-call delta → 已经有产出，算成功
 *   finish + failure               → 失败，换候选
 *   finish 正常结束                 → 成功（可能空回复）
 *   超过 firstFrameTimeoutMs        → 失败（timeout），换候选
 *
 * @param {{ stream: (options: any) => AsyncIterable<any> }} llm
 * @param {import('../pool/types.js').ModelEntry} entry
 * @param {AutopilotCall} call
 * @param {{ timeoutMs?: number }} [options]
 */
async function openWithPeek(llm, entry, call, options = {}) {
  if (call.signal?.aborted) throw withVerdict(new Error('aborted'), 'aborted')

  let stream
  try {
    stream = llm.stream({
      ...call,
      provider: entry.provider,
      model: entry.model
    })
  } catch (error) {
    throw withVerdict(/** @type {Error} */ (error), classifyError(error))
  }

  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw withVerdict(new Error('stream 不是异步可迭代对象'), 'unknown')
  }

  const iterator = stream[Symbol.asyncIterator]()
  /** @type {any[]} */
  const preamble = []

  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 30_000
  const DEADLINE = Symbol('first-frame-deadline')
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  /** @type {(value?: unknown) => void} */
  let settle = () => {}
  const deadline = new Promise((resolve) => {
    settle = resolve
    timer = setTimeout(() => resolve(DEADLINE), timeoutMs)
    // **不要 unref**：这个定时器是「上游挂死不吐数据」时唯一能把等待解开的东西。
    // 一旦 unref，当上游永远不产出、而进程里又没有别的事可做时，事件循环会先
    // 结束 —— 这次请求的 Promise 永远不 settle（宿主那边表现为「卡住不动」，
    // 测试里表现为 "Promise resolution is still pending but the event loop has
    // already resolved"）。
    // 它在 cleanup() 里一定被 clearTimeout，生命周期不超过本次请求，不会拖住进程。
  })
  // 外部取消也要立刻解开等待，否则用户按停止后还要等满超时。
  const onAbort = () => settle(DEADLINE)
  call.signal?.addEventListener?.('abort', onAbort, { once: true })

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer)
    call.signal?.removeEventListener?.('abort', onAbort)
  }

  try {
    while (true) {
      const raced = await Promise.race([iterator.next(), deadline])
      if (raced === DEADLINE) {
        const aborted = call.signal?.aborted === true
        const error = withVerdict(
          new Error(aborted ? 'aborted' : `首帧超时（${timeoutMs}ms 内没有收到任何内容）`),
          aborted ? 'aborted' : 'timeout'
        )
        // 首帧超时不该原地重试：再等一轮只是把用户晾更久。
        if (!aborted) /** @type {any} */ (error).firstFrameTimeout = true
        throw error
      }
      const first = raced
      if (first.done) {
        if (preamble.length > 0) return { iterator, firstChunks: preamble }
        throw withVerdict(new Error('stream 结束且没有任何 chunk'), 'empty')
      }
      const chunk = first.value
      const type = chunk?.type

      if (type === 'finish') {
        const reason = chunk.reason ?? {}
        if (reason.failure) throw failureError(reason.failure)
        if (reason.kind === 'aborted') throw withVerdict(new Error('aborted'), 'aborted')
        // 输出被 max_tokens 截断，且**一个字都还没吐**：这等于这次调用什么都没拿到
        // （通常是 maxTokens 给得太小，或该模型的输出上限远低于请求）。
        // 这种情况要按失败处理、换一个输出预算更大的模型，而不是把一个空回复
        // 当成成功交给用户。
        if (reason.kind === 'max-tokens' && !preamble.some(isSemanticChunk)) {
          throw withVerdict(new Error('输出被 max_tokens 截断，且没有任何内容产出'), 'truncated')
        }
        return { iterator, firstChunks: [...preamble, chunk] }
      }

      if (type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta') {
        return { iterator, firstChunks: [...preamble, chunk] }
      }

      // usage / step-start 等元数据帧：留到后面原样转发，继续往后看。
      preamble.push(chunk)
      if (preamble.length > 8) {
        // 一直没有语义帧：保守当成成功，避免把正常但话少的模型判失败。
        return { iterator, firstChunks: preamble }
      }
    }
  } catch (error) {
    // 不 await：若上游挂在 pending next() 上，async generator 的 return() 会排队
    // 等那一笔完成 —— await 它等于把超时又变回无限等待（测试实测会挂死）。
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {})
    } catch {
      /* ignore */
    }
    if (/** @type {any} */ (error)?.verdict) throw error
    throw withVerdict(/** @type {Error} */ (error), classifyError(error))
  } finally {
    cleanup()
  }
}

/**
 * 是不是「账号级」失败：整个 provider 都走不通，不必再试同账号的其它模型。
 *
 * - throttled：额度/限流是账号维度的，换个模型名还是同一个额度池
 * - auth：凭据是 provider 维度的
 * - region-blocked：地区封锁是 provider 维度的
 *
 * 不进这个集合的：timeout / unavailable / empty / truncated —— 那些可能只是
 * 这一个模型或这一次请求的问题，同 provider 的其它模型仍值得一试。
 *
 * @param {string} verdict
 * @returns {boolean}
 */
function isProviderWideVerdict(verdict) {
  return verdict === 'throttled' || verdict === 'auth' || verdict === 'region-blocked'
}

/**
 * 记录一次「输出被截断」。
 *
 * 为什么单独记而不是 `markFailure`：模型没坏，只是它的输出预算不够（或上游
 * 把 max_tokens 压得很小）。判失败会让它进冷却、拖 30 分钟，反而更糟。正确做法
 * 是记一个**降权信号**：下一次调度优先挑输出上限更大的模型。
 *
 * @param {any} pool
 * @param {import('../pool/types.js').ModelEntry} entry
 * @param {any} chunk
 */
function recordTruncation(pool, entry, chunk) {
  if (chunk?.type !== 'finish') return
  if (chunk.reason?.kind !== 'max-tokens') return
  try {
    pool.markTruncated?.(entry.key)
  } catch {
    /* 统计失败不影响出流 */
  }
}

/**
 * 是不是「有实际产出」的帧（文本 / 推理 / 工具调用）。
 * @param {any} chunk
 * @returns {boolean}
 */
function isSemanticChunk(chunk) {
  const type = chunk?.type
  return type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta'
}

/**
 * 挑「最可能成功」的一个：池里健康、不在冷却、探针测过且**延迟最低**的条目。
 *
 * 用于预算收手后的最后一搏：按延迟排序意味着它是最快能给响应的通道，
 * 比随机挑一个或直接报错都强。
 *
 * @param {any} pool
 * @param {string[]} excluded
 * @returns {import('../pool/types.js').ModelEntry | null}
 */
function pickFastestHealthy(pool, excluded) {
  const now = Date.now()
  const excludedSet = new Set(excluded)
  const candidates = pool
    .all()
    .filter((entry) => !excludedSet.has(entry.key))
    .filter((entry) => entry.health !== 'dead')
    .filter((entry) => !(entry.cooldownUntil > now))
    .filter((entry) => entry.lastProbe?.verdict === 'ok' || entry.health === 'available')
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    const aLatency = a.lastProbe?.latencyMs ?? Infinity
    const bLatency = b.lastProbe?.latencyMs ?? Infinity
    if (aLatency !== bLatency) return aLatency - bLatency
    return (a.failCount ?? 0) - (b.failCount ?? 0)
  })
  return candidates[0]
}

/**
 * 挑出「还没试过、且还有可能成功」的候选：不在本轮排除表里、没判死、
 * 不在冷却中。
 *
 * 用于预算收手后的并发试探 —— 探针延迟数据可能缺失，没法预知谁快，
 * 所以把还活着的机会全都拿出来一起试。
 *
 * @param {any} pool
 * @param {string[]} excluded
 * @returns {import('../pool/types.js').ModelEntry[]}
 */
function pickRemainingHealthy(pool, excluded) {
  const now = Date.now()
  const excludedSet = new Set(excluded)
  return pool
    .all()
    .filter((entry) => !excludedSet.has(entry.key))
    .filter((entry) => entry.health !== 'dead')
    .filter((entry) => !(entry.cooldownUntil > now))
    // 注意：**不要**再加「health === 'available' || lastProbe.verdict === 'ok'」。
    // `unknown` 表示「从未探过」，不等于「不能用」—— 恰恰是最值得一试的候选。
    // 加了那个条件会让预算收手时的并发试探把一个从没试过的健康通道也排除掉，
    // 于是明明还有机会却直接报耗尽（实测：从未探过的快通道被过滤，测试报错）。
    .sort((a, b) => {
      // 探针测过的、延迟低的优先（能更快出声）；没数据的排后面。
      const aLatency = a.lastProbe?.latencyMs ?? Infinity
      const bLatency = b.lastProbe?.latencyMs ?? Infinity
      if (aLatency !== bLatency) return aLatency - bLatency
      return a.key.localeCompare(b.key)
    })
}

/**
 * 并发试探多个候选，谁先成功用谁，其余立刻中止。
 *
 * 每个候选一条独立的 AbortController：胜出后立刻 abort 其它，
 * 不浪费上游额度（并发试的是同一批免费通道，多打一次就是多扣一次）。
 *
 * @param {any} ctx
 * @param {any} pool
 * @param {import('../pool/types.js').ModelEntry[]} contenders
 * @param {any} call
 * @param {number} timeoutMs
 * @returns {Promise<{
 *   winner: { entry: any, opened: any, latencyMs: number } | null,
 *   results: Array<{ entry: any, ok: boolean, verdict?: string, latencyMs: number, raced: boolean }>
 * }>}
 */
async function raceCandidates(ctx, pool, contenders, call, timeoutMs) {
  /** @type {Array<{ entry: any, promise: Promise<any> }>} */
  const running = contenders.map((entry) => {
    const controller = new AbortController()
    const callWithSignal = { ...call, signal: controller.signal }
    const started = Date.now()
    const promise = openWithPeek(ctx.llm, entry, callWithSignal, { timeoutMs })
      .then((opened) => ({ entry, ok: true, opened, latencyMs: Date.now() - started, controller }))
      .catch((error) => ({
        entry,
        ok: false,
        verdict: /** @type {any} */ (error)?.verdict ?? classifyError(error),
        latencyMs: Date.now() - started,
        controller
      }))
    return { entry, promise }
  })

  /** @type {Array<{ entry: any, ok: boolean, verdict?: string, latencyMs: number, raced: boolean }>} */
  const results = []
  /** @type {any} */
  let winner = null

  // 逐个 await，但它们是**并发**跑的：第一个成功的立刻成为胜者。
  for (const item of running) {
    const settled = await item.promise
    if (settled.ok) {
      winner = settled
      results.push({ entry: settled.entry, ok: true, latencyMs: settled.latencyMs, raced: true })
      break
    }
    results.push({
      entry: settled.entry,
      ok: false,
      verdict: settled.verdict,
      latencyMs: settled.latencyMs,
      raced: false
    })
  }

  // 胜者已定：中止其余还在跑的探测。
  for (const item of running) {
    try {
      item.promise.then(
        (settled) => settled?.controller?.abort?.(),
        () => {}
      )
    } catch {
      /* 中止失败不影响主流程 */
    }
  }
  // 记下被中止的候选（它们没成没败，只是输了这场竞速）。
  for (const item of running) {
    if (results.some((r) => r.entry.key === item.entry.key)) continue
    results.push({ entry: item.entry, ok: false, latencyMs: 0, raced: false })
  }

  return { winner, results }
}

/**
 * 挑一个终极兜底模型：`config.failover.terminalFallback` 指定的通道里，
 * 挑一个没被排除、没判死、且不在冷却中的条目。
 *
 * 兜底**不受 `allowPaid` 限制** —— 它本身就是「付费也能用」的那一层，
 * 否则免费全挂时还是会停住。
 *
 * @param {any} pool
 * @param {any} config
 * @param {string[]} excluded
 * @returns {import('../pool/types.js').ModelEntry | null}
 */
function pickTerminalFallback(pool, config, excluded) {
  const target = config.failover?.terminalFallback
  if (!target || typeof target.provider !== 'string') return null
  const now = Date.now()
  const excludedSet = new Set(excluded)
  const sameProvider = pool
    .all()
    .filter((entry) => entry.provider === target.provider)
    .filter((entry) => (target.model === null ? true : entry.model === target.model))

  // 第一优先：本次请求没试过、健康、不在冷却里的。
  const fresh = sameProvider
    .filter((entry) => !excludedSet.has(entry.key))
    .filter((entry) => entry.health !== 'dead')
    .filter((entry) => !(entry.cooldownUntil > now))

  // 第二优先（这道才是「兜底」的本意）：即使它刚被当普通候选试过并失败、
  // 甚至还在冷却里，也再强制试一次。
  //
  // 为什么必须这样：之前把 `!excluded` 也当硬条件，导致兜底通道一旦在前面被
  // 挑中过（付费通道在 allowPaidByDefault 下就是普通候选），失败后就再也兜
  // 不上 —— 用户看到「所有候选均失败」，而兜底通道明明是 available。
  // 瞬时故障（限流几秒）本来就可能已恢复，最后防线不该被一次失败挡死。
  const forced = sameProvider.filter((entry) => !fresh.includes(entry) && entry.health !== 'dead')

  const candidates = fresh.length > 0 ? fresh : forced
  if (candidates.length === 0) return null
  // 失败次数少的优先，其次最近探测延迟低的。
  candidates.sort((a, b) => {
    if (a.failCount !== b.failCount) return a.failCount - b.failCount
    return (a.lastProbe?.latencyMs ?? Infinity) - (b.lastProbe?.latencyMs ?? Infinity)
  })
  return candidates[0]
}

/**
 * 把「已偷看」的流包装成对外的可迭代对象。
 * 首帧之后的失败不能再切换模型，只写回一次失败再上抛。
 * @param {import('../pool/pool.js').createPool extends (...args:any)=>infer R ? R : never} pool
 * @param {import('../pool/types.js').ModelEntry} entry
 * @param {AsyncIterator<any>} iterator
 * @param {any[]} firstChunks
 */
function trackStream(pool, entry, iterator, firstChunks) {
  return (async function* replay() {
    try {
      for (const chunk of firstChunks) {
        recordTruncation(pool, entry, chunk)
        yield chunk
      }
      while (true) {
        const next = await iterator.next()
        if (next.done) return
        recordTruncation(pool, entry, next.value)
        yield next.value
      }
    } catch (error) {
      const verdict = classifyError(error)
      // 已经吐过内容，无法切换；记一次失败让下次调度避开它。
      if (verdict !== 'aborted') pool.markFailure(entry.key, verdict)
      throw error
    } finally {
      // 同样不 await：消费者可能在上游挂起时退出，await return() 会把退出拖成挂死。
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {})
      } catch {
        /* ignore */
      }
    }
  })()
}

/**
 * @param {object} options
 * @param {{ llm: any, logger?: any }} options.ctx
 * @param {ReturnType<typeof import('../pool/pool.js').createPool>} options.pool
 * @param {ReturnType<typeof import('../schedule/scheduler.js').createScheduler>} options.scheduler
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} options.config
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {() => number} [options.random] - 退避抖动的随机源（测试注入）
 * @param {(ms: number) => Promise<void>} [options.wait] - 退避等待（测试注入）
 */
export function createFailover({
  ctx,
  pool,
  scheduler,
  config,
  logger = console,
  random = Math.random,
  wait = sleep,
  preference = null
}) {
  /**
   * 一次请求的完整流程：选型 → 首帧探路 → 重试/换模型 → 返回可迭代流。
   *
   * @param {AutopilotCall & { intent?: string, require?: any, allowPaid?: boolean, now?: number }} request
   * @returns {Promise<{
   *   model: { provider: string, model: string, key: string, cost: string },
   *   attempts: AttemptRecord[],
   *   fallbacks: import('../pool/types.js').ModelEntry[],
   *   reason: string,
   *   stream: AsyncIterable<any>
   * }>}
   */
  async function run(request) {
    const { intent, require: requirement, allowPaid, signal, now: _now, ...rawCall } = request
    // 上下文过滤允许**降级一次**：若按估算 token 硬筛后一个候选都没有（池里
    // 全是大会话装不下的小窗口模型），死守 requirement 只会直接报「无候选」。
    // 这种情况下退回不按上下文筛，让上游自己回 400 并把判决记到具体模型上，
    // 至少还有机会落到某个大窗口通道。
    let contextRequirement = requirement
    // provider/model 必须清掉：调用方（autopilot adapter）传进来的是
    // 'autopilot'/'auto'，那是虚拟路由不是真实模型。真实路由由候选条目决定。
    const { provider: _ignoredProvider, model: _ignoredModel, ...rest } = rawCall
    const call = compactCall({ ...rest, signal })
    /** @type {AttemptRecord[]} */
    const attempts = []
    /** @type {string[]} */
    const excluded = []
    /** @type {import('../pool/types.js').ModelEntry[]} */
    let fallbacks = []
    let reason = 'no-candidate'
    /** @type {unknown} */
    let lastError = null
    /**
     * 换模型的总时间预算。
     *
     * 语义（重要）：**预算不是停止条件，是节奏调节器**。
     * 用户的诉求是「除非完成任务，否则无感自动切换，不能因为预算耗尽就中断任务」。
     * 所以预算只用来：
     *   - 收缩后续候选的首帧超时（剩余时间越少，给下一个的耐心越短）；
     *   - 在「剩余时间连一次快速失败都试不完」时收手（那才是真的没救了）。
     * 绝不因为「用满了 30s」就抛错弃任务 —— 那正是用户要避免的「中断」。
     */
    const startedAt = Date.now()
    const budgetMs = config.failover.maxTotalMs ?? 120_000
    /**
     * 单次候选至少还要有这么多剩余预算才值得试。
     * 低于它就等于「明知来不及还硬上」—— 白等一轮，还让总耗时超支。
     */
    const MIN_USEFUL_MS = 1_500
    /**
     * 按剩余预算收缩单次候选的首帧超时。
     *
     * 为什么必须收缩：之前固定给 firstFrameTimeoutMs（10s），不看剩余预算。
     * 预算 30s 时，前 3 个候选各挂满 10s 就已经 30s，第 4 个仍给满 10s →
     * 实测总耗时 37191ms，超支 7s。
     */
    const attemptTimeout = () => {
      const remaining = budgetMs - (Date.now() - startedAt)
      const cap = config.failover.firstFrameTimeoutMs
      // 下限不能超过上限：否则用户显式配 firstFrameTimeoutMs=1000 时，
      // Math.max(1500, min(1000, ...)) = 1500 会把上限抬掉，
      // 导致 1100ms 才响应的挂死候选被判成功（实测 B3 用例因此失败）。
      const floor = Math.min(MIN_USEFUL_MS, cap)
      return Math.max(floor, Math.min(cap, remaining))
    }
    let budgetExhausted = false

    for (let index = 0; index < config.failover.maxModels; index += 1) {
      // 预算必须在**每次挑候选之前**查，而不是只在循环入口查一次。
      // 之前只在 index=0 时查，导致一次请求能跑 14 个候选、130s 才落点 ——
      // 用户在界面上看到的是「卡住」，其实是在一个接一个地等超时。
      //
      // 剩余预算连「一次快速失败」都试不完时才收手 —— 这是唯一该停的理由。
      // 不能因为「用满了预算」就停：用户的诉求是「除非完成任务，否则无感切换」。
      // 收手后不抛「预算耗尽」，而是当「候选耗尽」处理（见下方 exhausted 构造）：
      // 对用户来说任务没做完，语义上就是「没找到能用的模型」。
      if (attempts.length > 0 && budgetMs - (Date.now() - startedAt) < MIN_USEFUL_MS) {
        budgetExhausted = true
        logger.warn?.(
          `model-autopilot: 换模型已用 ${Date.now() - startedAt}ms，剩余预算不足 ${MIN_USEFUL_MS}ms，无法再试下一个`
        )
        break
      }
      const plan = scheduler.plan({
        requirement,
        allowPaid,
        exclude: excluded,
        now: Date.now()
      })
      if (index === 0) {
        fallbacks = plan.fallbacks
        reason = plan.reason
      }
      const entry = plan.primary
      if (!entry) break

      excluded.push(entry.key)

      for (let retry = 0; retry <= config.failover.maxRetriesPerModel; retry += 1) {
        const started = Date.now()
        try {
          const opened = await openWithPeek(ctx.llm, entry, call, {
            timeoutMs: attemptTimeout()
          })
          pool.markSuccess(entry.key)
          attempts.push({
            key: entry.key,
            ok: true,
            retry,
            latencyMs: Date.now() - started
          })
          logger.info?.(
            `model-autopilot: ${entry.cost === 'free' ? '免费' : '付费'} ${entry.key} 命中（第 ${retry + 1} 次尝试，首帧 ${Date.now() - started}ms）`
          )
          return {
            model: detailOf(entry),
            attempts,
            fallbacks,
            reason,
            stream: trackStream(pool, entry, opened.iterator, opened.firstChunks)
          }
        } catch (error) {
          const verdict = /** @type {any} */ (error)?.verdict ?? classifyError(error)
          const latencyMs = Date.now() - started
          lastError = error
          attempts.push({
            key: entry.key,
            ok: false,
            verdict,
            retry,
            latencyMs,
            detail: error instanceof Error ? error.message : String(error)
          })

          if (verdict === 'aborted' || signal?.aborted) throw error

          pool.markFailure(entry.key, verdict, Date.now())

          // ── provider 级跳过 ────────────────────────────────────────────────
          // 账号级失败（额度耗尽 / 凭据无效 / 地区封锁）往往是**整条账号路**走不通，
          // 同 provider 的其它模型接着试只会把 maxModels 的额度耗在一个死账号上。
          //
          // 两个例外不跳过：
          //   1. 多渠道路由网关（config.failover.gatewayProviders）：同 provider 下
          //      的模型各自路由到不同上游，彼此独立，整体跳过会砍掉能用的通道。
          //   2. 别的 provider 也没有活路时：跳过了就没候选了，不如逐个老实试。
          const isGateway = (config.failover.gatewayProviders ?? []).includes(entry.provider)
          if (isProviderWideVerdict(verdict) && !isGateway) {
            const hasOtherProvider = pool
              .all()
              .some((item) => item.provider !== entry.provider && item.health !== 'dead')
            if (hasOtherProvider) {
              const siblings = pool
                .all()
                .filter((item) => item.provider === entry.provider)
                .map((item) => item.key)
                .filter((key) => !excluded.includes(key))
              if (siblings.length > 0) {
                excluded.push(...siblings)
                logger.info?.(
                  `model-autopilot: ${entry.provider} 账号级失败（${verdict}），跳过该通道剩余 ${siblings.length} 个模型`
                )
              }
            }
          }

          // 首选 provider 的额度类失败：额度不会在默认冷却（60s）内恢复。
          // 不延长冷却的话，调度器每隔一分钟又把它排第一、再失败一次 ——
          // 用户看到的就是「一直在同一个通道上撞墙」。这里按分钟级拉长。
          const pinnedProvider = preference?.isPinned?.() ? preference.get()?.provider : null
          if (pinnedProvider !== null && entry.provider === pinnedProvider && verdict === 'throttled') {
            pool.extendCooldown?.(entry.key, 10 * 60_000, Date.now())
          }

          logger.warn?.(
            `model-autopilot: ${entry.key} 失败 (${verdict}${retry > 0 ? `，第 ${retry + 1} 次` : ''})：` +
              truncate(error instanceof Error ? error.message : String(error))
          )

          const canRetry =
            config.failover.retrySameModel &&
            isRetryableVerdict(verdict) &&
            // 首帧超时不原地重试：再等一轮只是把用户晾更久，直接换候选。
            /** @type {any} */ (error)?.firstFrameTimeout !== true &&
            retry < config.failover.maxRetriesPerModel

          if (!canRetry) break

          const delay = backoffDelay(retry, config.failover.backoff, random)
          if (delay > 0) await wait(delay)
          if (signal?.aborted) throw withVerdict(new Error('aborted'), 'aborted')
        }
      }
    }

    // ── 最后一道：不因为预算就中断任务 ──────────────────────────────────────
    //
    // 用户的诉求：「除非完成任务，否则无感自动切换模型，不能因为预算耗尽就中断」。
    // 预算收手（budgetExhausted）只说明「按常规耐心已经试完一轮了」，
    // 不等于「没有可用模型」。所以这里再挑一次**最可能成功**的通道硬试：
    // 池里探针测过、健康、不在冷却、且延迟最低的那条 —— 它是剩下最可能
    // 在短时间内出响应的选项。多花几秒换「任务完成」是划算的。
    if (budgetExhausted) {
      // 并发试探所有剩余候选，谁先响应就用谁。
      //
      // 为什么要并发而不是「挑一个最可能快的」：预算收手时，剩余候选里谁快
      // **无从得知** —— 探针的延迟数据可能缺失（从未探过 / 数据过期），排序只能
      // 退化成 key 字典序，于是会挑中一个慢通道再白等一轮（实测：挑中 a3 而
      // 不是 z-fast-ok，直接把最后的希望也耗掉了）。
      //
      // 用户诉求：「要在剩余预算内尽可能多试候选，直到拿到有效响应」—— 并发
      // 试探是这句话的直接实现：所有候选同时发出，谁先出声就用谁，其余立刻
      // 中止（不浪费上游额度）。
      const contenders = pickRemainingHealthy(pool, excluded).slice(0, config.failover.raceCandidates)
      if (contenders.length > 0) {
        const raced = await raceCandidates(ctx, pool, contenders, call, config.failover.firstFrameTimeoutMs)
        for (const record of raced.results) {
          attempts.push({
            key: record.entry.key,
            ok: record.ok,
            ...(record.ok ? {} : { verdict: record.verdict }),
            retry: 0,
            latencyMs: record.latencyMs,
            terminal: true,
            lastResort: true,
            ...(record.raced ? { raced: true } : {})
          })
        }
        if (raced.winner !== null) {
          const winner = raced.winner
          pool.markSuccess(winner.entry.key)
          logger.info?.(
            `model-autopilot: 预算收手后由 ${winner.entry.key} 接手完成（并发试探 ${contenders.length} 个）`
          )
          return {
            stream: trackStream(pool, winner.entry, winner.opened.iterator, winner.opened.firstChunks),
            model: winner.entry,
            attempts,
            fallbacks,
            reason: 'last-resort'
          }
        }
      }
    }

    // ── 终极兜底 ────────────────────────────────────────────────────────────
    // 免费通道全试完了还不行，就用 terminalFallback（默认 deepseek-account）
    // 继续干。用户的诉求是「一直干活不停」：这时候抛错只会让会话停住或让宿主
    // 回退默认模型重发一轮，等于白折腾。只有兜底通道也失败，才真正认输。
    const fallbackEntry = pickTerminalFallback(pool, config, excluded)
    if (fallbackEntry !== null) {
      excluded.push(fallbackEntry.key)
      for (let retry = 0; retry <= config.failover.maxRetriesPerModel; retry += 1) {
        const started = Date.now()
        try {
          const opened = await openWithPeek(ctx.llm, fallbackEntry, call, {
            timeoutMs: attemptTimeout()
          })
          pool.markSuccess(fallbackEntry.key)
          attempts.push({
            key: fallbackEntry.key,
            ok: true,
            retry,
            latencyMs: Date.now() - started,
            terminal: true
          })
          logger.info?.(
            `model-autopilot: 候选耗尽，已兜底到 ${fallbackEntry.key}（第 ${retry + 1} 次尝试）`
          )
          return {
            stream: trackStream(pool, fallbackEntry, opened.iterator, opened.firstChunks),
            model: fallbackEntry,
            attempts,
            fallbacks,
            reason: 'terminal-fallback'
          }
        } catch (error) {
          const verdict = /** @type {any} */ (error)?.verdict ?? classifyError(error)
          pool.markFailure(fallbackEntry.key, verdict)
          attempts.push({
            key: fallbackEntry.key,
            ok: false,
            retry,
            verdict,
            latencyMs: Date.now() - started,
            terminal: true
          })
          lastError = error
          if (verdict === 'aborted') throw error
          const canRetry =
            config.failover.retrySameModel &&
            isRetryableVerdict(verdict) &&
            /** @type {any} */ (error)?.firstFrameTimeout !== true &&
            retry < config.failover.maxRetriesPerModel
          if (!canRetry) break
          const delay = backoffDelay(retry, config.failover.backoff, random)
          if (delay > 0) await wait(delay)
          if (signal?.aborted) throw withVerdict(new Error('aborted'), 'aborted')
        }
      }
    }

    const lastVerdict = attempts.filter((item) => !item.ok).at(-1)?.verdict
    // 循环正常走完（没被 break）但总耗时已超预算时，也要算「预算耗尽」——
    // 否则 maxModels 恰好等于候选数时，最后一轮跑完超时却报「所有候选均失败」，
    // 措辞误导用户以为池里真没有能用的模型。
    if (!budgetExhausted && Date.now() - startedAt > budgetMs) budgetExhausted = true
    // 区分「预算耗尽」与「候选耗尽」：两者对用户的含义不同 ——
    // 前者是「时间到了，不是因为没模型可用」，后者才是「池子里真没有能用的」。
    //
    // 但**收尾语义**上有个重要区别：预算耗尽时任务还没做完，用户要的是
    // 「继续干活」，所以最终抛出的错误码仍应是「候选耗尽」（= 没找到可用模型），
    // 预算信息只作为附加字段给出。真正的「预算耗尽」码留给**预算检查点**触发
    // 的那类场景（连一次快速失败都试不完，确实无路可走）。
    const failCount = attempts.filter((item) => !item.ok).length
    const exhausted = new Error(
      budgetExhausted
        ? `model-autopilot: 换模型预算耗尽（已用 ${Date.now() - startedAt}ms / 上限 ${budgetMs}ms，` +
            `${attempts.length} 次尝试，${failCount} 次失败）`
        : `model-autopilot: 所有候选模型均失败（${attempts.length} 次尝试，${failCount} 次失败）`
    )
    exhausted.name = 'AutopilotExhaustedError'
    const withExtra = /** @type {any} */ (exhausted)
    // 先按**耗尽原因**定码，再单独保留「最后一次失败的具体语义」。
    // 之前两种耗尽共用 CODE_OF_VERDICT[lastVerdict]，同样是 RATE_LIMIT 收尾时
    // 预算耗尽与候选耗尽报同一个码，调用方无法区分。
    withExtra.code = budgetExhausted ? EXHAUSTED_CODE.budget : EXHAUSTED_CODE.candidates
    withExtra.lastVerdictCode = CODE_OF_VERDICT[lastVerdict] ?? 'UNKNOWN'
    withExtra.attempts = attempts
    withExtra.cause = lastError
    withExtra.reason = reason
    // 让调用方/面板能区分两种耗尽：reason 说明选型路径，budgetExhausted 说明是否时间到了。
    withExtra.budgetExhausted = budgetExhausted
    withExtra.elapsedMs = Date.now() - startedAt
    withExtra.budgetMs = budgetMs
    throw exhausted
  }

  return { run }
}

/**
 * 去掉 undefined，避免把空字段塞进 GenerateOptions（宿主的 callConfig 比较会用到）。
 * @param {Record<string, any>} call
 */
function compactCall(call) {
  /** @type {Record<string, any>} */
  const out = {}
  for (const [key, value] of Object.entries(call)) if (value !== undefined) out[key] = value
  return out
}

/** @param {string} text @param {number} [max] */
function truncate(text, max = 180) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
