/**
 * 单模型探针：用「能产生判决的最小请求」问一次通道是否还通。
 *
 * 为什么必须真发请求：免费通道的失效往往不是元数据层面的 —— 模型仍出现在
 * listModels 里，只有在真正推一次 token 时才回 429 / 地区拒绝 / 凭据失效。
 * 所以探针的判据是「拿到第一段输出」而不是「模型在清单里」。
 *
 * 请求形状按宿主真实契约（GenerateOptions）：
 *   { provider, model, messages: [{ role: 'user', content: [{ type: 'text', text }] }], maxTokens, signal }
 * content 是 ContentBlock[]，不是裸字符串。
 *
 * 超时用「截止时间的 Promise 与迭代竞速」，而不是只 abort signal：宿主正常会响应
 * abort，但探针不能把「上游不响应」当成「永远等下去」。
 *
 * @module probe/probe
 */
import { VERDICT } from '../pool/types.js'
import { classifyFailure, classifyError } from './classify.js'

/** 最小提示词：只要能换来一个 token 即可，不带工具、不带系统提示。 */
/**
 * 探针请求的形状。
 *
 * 为什么必须贴近真实请求：早先用 `'ping'` + `maxTokens: 8` 探测，和宿主真实
 * 请求（带 system、带工具、几百上千条历史）差得太远。结果是好几条**明明能用**
 * 的通道被判死 —— deepseek-web/deepseek-chat 被探成 timeout 45s，而它正是
 * 当前会话在用的通道；有些上游对「maxTokens 过小」直接回错，被分类成
 * auth/unavailable。判死的代价是整轮被调度器排除，用户看到「明明有 100+ 免费
 * 模型，池里只剩 2 个 available」。
 */
export const PROBE_PROMPT = 'Reply with the single word: ok'

/** 探针输出预算。8 会被部分上游的 min-output 限制直接拒，产生假阴性。 */
export const PROBE_MAX_TOKENS = 32

/** 探针 system：与真实请求带 system 的形状保持一致。 */
export const PROBE_SYSTEM = '你是连通性测试端点，请按用户要求简短回复。'

/** 内部哨兵：竞速到截止时间。 */
const DEADLINE = Symbol('probe-deadline')

/**
 * @typedef {object} ProbeResult
 * @property {import('../pool/types.js').ProbeVerdict} verdict
 * @property {number} latencyMs - 首帧耗时（ok 时）或整体耗时
 * @property {string} [detail]
 */

/**
 * 探一个模型。
 * @param {{ stream: (options: any) => AsyncIterable<any> }} llm - 宿主 llm 服务
 * @param {{ provider: string, model: string, key?: string }} entry
 * @param {{ timeoutMs?: number, signal?: AbortSignal, prompt?: string }} [options]
 * @returns {Promise<ProbeResult>}
 */
export async function probeOnce(llm, entry, options = {}) {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : 45_000
  const started = Date.now()

  if (!llm || typeof llm.stream !== 'function') {
    return { verdict: VERDICT.unknown, latencyMs: 0, detail: 'ctx.llm.stream 不可用' }
  }

  const controller = new AbortController()
  let timedOut = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  /** @type {(value?: unknown) => void} */
  let settleDeadline = () => {}

  /** 与每次 next() 竞速的截止时间。外部取消也走这里，否则会白等到超时。 */
  const deadline = new Promise((resolve) => {
    settleDeadline = resolve
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('probe timeout'))
      resolve(DEADLINE)
    }, timeoutMs)
    timer.unref?.()
  })
  // 没人竞速时也不要变成 unhandled rejection 源
  deadline.catch(() => {})

  const external = options.signal
  const onExternalAbort = () => {
    controller.abort(external?.reason)
    settleDeadline(DEADLINE)
  }
  external?.addEventListener('abort', onExternalAbort, { once: true })

  /** @type {AsyncIterator<any> | undefined} */
  let iterator
  let sawContent = false

  try {
    const stream = llm.stream({
      provider: entry.provider,
      model: entry.model,
      system: options.system ?? PROBE_SYSTEM,
      messages: [
        { role: 'user', content: [{ type: 'text', text: options.prompt ?? PROBE_PROMPT }] }
      ],
      maxTokens: options.maxTokens ?? PROBE_MAX_TOKENS,
      signal: controller.signal
    })

    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      return { verdict: VERDICT.unknown, latencyMs: Date.now() - started, detail: 'stream 不是异步可迭代对象' }
    }
    iterator = stream[Symbol.asyncIterator]()

    while (true) {
      const raced = await Promise.race([iterator.next(), deadline])
      if (raced === DEADLINE) {
        return {
          verdict: timedOut ? VERDICT.timeout : VERDICT.aborted,
          latencyMs: Date.now() - started,
          detail: timedOut ? `probe timeout after ${timeoutMs}ms` : 'aborted'
        }
      }
      if (raced.done) break
      const chunk = raced.value
      const type = chunk?.type

      if (type === 'text-delta' || type === 'reasoning-delta') {
        // 首帧即证明通道可用（账号、地区、配额都过了）。不必等整段结束。
        sawContent = true
        return { verdict: VERDICT.ok, latencyMs: Date.now() - started, detail: 'first-token' }
      }

      if (type === 'tool-call-delta') {
        // 最小请求不该触发工具调用；出现即说明通道可用，只是探针提示词被当成工具意图。
        sawContent = true
        return { verdict: VERDICT.ok, latencyMs: Date.now() - started, detail: 'tool-call' }
      }

      if (type === 'finish') {
        const reason = chunk.reason ?? {}
        if (reason.failure) {
          return {
            verdict: classifyFailure(reason.failure),
            latencyMs: Date.now() - started,
            // 上游有时只给 code、不给 message（trae 的 auth 就是这样）。
            // 只存 message 会让 detail 变成空字符串，排查时完全看不出原因，
            // 所以 code 也要带上。
            detail:
              [reason.failure.message, reason.failure.code].filter((part) => typeof part === 'string' && part !== '').join(' / ') ||
              JSON.stringify(reason.failure).slice(0, 200)
          }
        }
        if (reason.kind === 'aborted') {
          return {
            verdict: timedOut ? VERDICT.timeout : VERDICT.aborted,
            latencyMs: Date.now() - started,
            detail: timedOut ? `probe timeout after ${timeoutMs}ms` : 'aborted'
          }
        }
        // 正常结束但一个 token 都没有：EMPTY_RESPONSE 的等价物。
        return {
          verdict: sawContent ? VERDICT.ok : VERDICT.empty,
          latencyMs: Date.now() - started,
          detail: sawContent ? undefined : 'stream finished without tokens'
        }
      }
    }

    return { verdict: sawContent ? VERDICT.ok : VERDICT.empty, latencyMs: Date.now() - started }
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        verdict: timedOut ? VERDICT.timeout : VERDICT.aborted,
        latencyMs: Date.now() - started,
        detail: timedOut ? `probe timeout after ${timeoutMs}ms` : 'aborted'
      }
    }
    const verdict = classifyError(error)
    return { verdict, latencyMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    if (timer !== null) clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
    // 提前判定成功时主动释放流，避免占着一条上游连接。
    // 不 await：有些上游的 return() 会等 flush 完成，探针不等它。
    try {
      void Promise.resolve(iterator?.return?.()).catch(() => {})
    } catch {
      /* 释放失败不影响判决 */
    }
  }
}
