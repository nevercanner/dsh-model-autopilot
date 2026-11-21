/**
 * 小工具：并发限流、超时、错误归一化。零依赖。
 * @module util
 */

/**
 * 以固定并发跑完一组输入的异步任务。单个任务抛错不影响其它任务。
 * @template T
 * @param {readonly T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} run
 * @returns {Promise<void>}
 */
export async function runLimited(items, concurrency, run) {
  const queue = [...items]
  const width = Math.max(1, Math.min(concurrency, queue.length || 1))
  const workers = Array.from({ length: width }, async () => {
    while (queue.length > 0) {
      const item = /** @type {T} */ (queue.shift())
      try {
        await run(item)
      } catch {
        // 调用方自己决定要不要记录；这里只保证一个任务的失败不拖垮整轮。
      }
    }
  })
  await Promise.all(workers)
}

/**
 * 把任意 throw 归一化成 {code, message}。宿主抛出的 LlmError 带 code，
 * 上游 SDK 的原始错误可能只在 message 里。
 * @param {unknown} error
 * @returns {{ code: string, message: string }}
 */
export function failureOf(error) {
  if (error && typeof error === 'object') {
    const record = /** @type {any} */ (error)
    const nested = record.failure && typeof record.failure === 'object' ? record.failure : null
    const code =
      typeof record.code === 'string'
        ? record.code
        : nested && typeof nested.code === 'string'
          ? nested.code
          : 'UNKNOWN'
    const message =
      typeof record.message === 'string'
        ? record.message
        : nested && typeof nested.message === 'string'
          ? nested.message
          : String(error)
    return { code, message }
  }
  return { code: 'UNKNOWN', message: String(error) }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 只保留对象里值非 undefined 的键，方便构造 patch。
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
export function compact(patch) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) out[key] = value
  return out
}
