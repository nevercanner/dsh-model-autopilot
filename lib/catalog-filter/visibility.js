/**
 * 可见性规则（纯函数）。
 *
 * 目的只有一个：模型选择界面不应该列出「现在选了一定失败」的模型。
 * 判定全部委托给 `pool.shouldHide()`，这里只负责三件容易做错的事：
 *
 *   1. 受保护的 provider 一律不过滤（虚拟 provider `autopilot` 必须始终可见 ——
 *      它本来就不在池里，但显式短路能保证将来 excludeProviders 配置被改坏时
 *      也不会把它弄没）。
 *   2. 若某个 provider 过滤后一个都不剩，就原样返回 —— 让整组消失比列出一个
 *      暂时失效的模型更糟：用户会以为这个模型商没装。
 *   3. 没有条目的模型（池里查不到）保持可见 —— 「不知道」不等于「失效」。
 *
 * @module catalog-filter/visibility
 */
import { AUTOPILOT_PROVIDER } from '../autopilot.js'

/**
 * @param {string} provider
 * @param {readonly any[]} models - 宿主 listModels 的原始结果
 * @param {{ shouldHide: (provider: string, model: string, now?: number) => boolean }} pool
 * @param {{ now?: number, protectedProviders?: Iterable<string> }} [options]
 * @returns {readonly any[]} 过滤后的列表（可能等于入参）
 */
export function filterModels(provider, models, pool, options = {}) {
  if (!Array.isArray(models) || models.length === 0) return models

  const protectedProviders = new Set([AUTOPILOT_PROVIDER, ...(options.protectedProviders ?? [])])
  if (protectedProviders.has(provider)) return models

  const now = options.now ?? Date.now()
  /** @type {any[]} */
  const visible = []
  let hidden = 0

  for (const model of models) {
    const id = typeof model?.id === 'string' ? model.id : ''
    if (id !== '' && pool.shouldHide(provider, id, now)) {
      hidden += 1
      continue
    }
    visible.push(model)
  }

  if (hidden === 0) return models
  // 全隐藏 = 该 provider 目前没有任何可用项：保留原样，避免整组从界面消失。
  if (visible.length === 0) return models
  return visible
}

/**
 * 过滤结果的计数，供日志/面板展示。
 * @param {readonly any[]} before
 * @param {readonly any[]} after
 */
export function hiddenCountOf(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return 0
  return Math.max(0, before.length - after.length)
}
