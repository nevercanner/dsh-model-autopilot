/**
 * 故障切换的决策函数（纯函数，可单测）。
 *
 * 为什么不把冷却也放这里：冷却已经在 `pool/transitions.js` 里有一份，且是
 * 唯一一份。这里只回答「同一个错误该重试还是换模型」「下一次重试等多久」。
 *
 * @module failover/breaker
 */

/**
 * 首帧前失败时是否值得在同一模型上重试。
 *
 * 值得重试：超时、传输/服务端错误、空响应 —— 换个时刻可能就好。
 * 不值得：
 *   - 鉴权失效、地区封锁：同一模型再试结果一样。
 *   - 限流/配额（throttled）：我们通常有多个候选，换一个比在原地等更快；
 *     免费通道按 session 计配额，原地重试往往只是再吃一次 429，还多占一个
 *     探测周期。这条也是「上游 5 次重试 × 插件重试」叠加的主要来源，掐掉它
 *     后单次请求的上游调用次数有明确上界。
 *
 * @param {import('../pool/types.js').ProbeVerdict} verdict
 * @returns {boolean}
 */
export function isRetryableVerdict(verdict) {
  // `truncated` 不在这里：在同一个模型上重试，输出上限还是那么小，只会再截一次。
  // 它走「换候选」路径（外层循环挑下一个模型）。
  return verdict === 'timeout' || verdict === 'unavailable' || verdict === 'empty'
}

/**
 * 是否属于「这个模型结构性不可用」，必须换模型。
 * @param {import('../pool/types.js').ProbeVerdict} verdict
 * @returns {boolean}
 */
export function isStructuralVerdict(verdict) {
  // `truncated` 也属结构性：这个模型的输出预算就是不够，换别家才可能写完整。
  return verdict === 'auth' || verdict === 'region-blocked' || verdict === 'truncated'
}

/**
 * 指数退避 + 抖动：initial * 2^attempt，封顶 maxMs，再乘 (1 ± jitter)。
 * @param {number} attempt - 0-based 重试序号
 * @param {{ initialMs: number, maxMs: number, jitterRatio: number }} backoff
 * @param {() => number} [random]
 * @returns {number} 毫秒
 */
export function backoffDelay(attempt, backoff, random = Math.random) {
  const base = Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.max(0, attempt))
  if (backoff.jitterRatio <= 0) return Math.round(base)
  const spread = base * backoff.jitterRatio
  return Math.round(base - spread + random() * spread * 2)
}
