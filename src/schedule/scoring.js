/**
 * 打分：同成本内排序的唯一依据。
 *
 * 硬规则不在分数里 —— 「免费永远先于付费」由 scheduler 单独执行，
 * 因为一旦把成本折成分数，一个优先级很高的付费模型就能在数值上超过一个
 * 状态很差的免费模型，规则会悄悄失效。这里的分数只用于**同成本组内**比较。
 *
 * @module schedule/scoring
 */

/**
 * @typedef {object} ScoreContext
 * @property {number} now
 * @property {ReturnType<typeof import('../config.js').normalizeConfig>} config
 * @property {{ providers?: Record<string, any> } | null} [quota] - 额度情报（AIHOT 羊毛清单）
 */

/**
 * @param {import('../pool/types.js').ModelEntry} entry
 * @param {ScoreContext} context
 * @returns {number}
 */
export function scoreEntry(entry, context) {
  const { now, config, quota } = context
  const rules = config.schedule
  let score = entry.priority

  if (entry.health === 'available') score += 50
  else if (entry.health === 'degraded') score -= rules.degradedPenalty
  else if (entry.health === 'unknown') score += 0
  else if (entry.health === 'cooling') score -= 200
  else if (entry.health === 'dead') score -= 10_000

  score -= Math.min(entry.failCount, 10) * rules.failPenalty

  const latency = entry.lastProbe?.latencyMs
  if (typeof latency === 'number' && latency > 0) {
    score -= Math.min(latency, 60_000) / 1_000 * rules.latencyPenaltyPerSecond
  }

  // 额度情报：现在有免费额度的通道优先消耗；额度已截止的降权。
  score += quotaScore(entry, quota)

  // 免费 flash 通道优先（用户口径：免费的里优先 deepseek v4 flash，
  // 但保底付费通道 deepseek-account 要在最后才用）。
  score += preferFlashScore(entry, config)

  // 输出被 max_tokens 截断过：说明这个通道的输出预算不够用。
  // 不判失败（模型没坏），但让位给能写完整回答的模型。
  const truncated = entry.truncatedCount ?? 0
  if (truncated > 0) score -= Math.min(truncated, 5) * 8

  // 冷却已到期、上一次还不成功的条目：给一次恢复机会，但只加一点点，
  // 不能盖过健康条目的优势。
  if (entry.cooldownUntil > 0 && entry.cooldownUntil <= now && entry.lastProbe && entry.lastProbe.verdict !== 'ok') {
    score += rules.halfOpenBonus
  }

  return score
}

/**
 * provider 置顶排名：`config.schedule.providerOrder` 里越靠前、返回值越小。
 * 未列出的 provider 排在这些之后（返回列表长度）。
 * 语义边界：只在**同一成本组内**比较 —— 「免费优先」由 scheduler 单独执行，
 * 置顶项永远不会越过一个可用的免费模型。
 * @param {string} provider
 * @param {{ schedule: { providerOrder?: readonly string[] } }} config
 * @returns {number}
 */
export function providerRank(provider, config) {
  const order = config.schedule.providerOrder ?? []
  const index = order.indexOf(provider)
  return index === -1 ? order.length : index
}

/**
 * 额度情报带来的加分/减分。
 *
 * 依据 AIHOT「Token 羊毛」清单：某个通道现在有没有**未过期的免费额度**。
 * 有额度 → 该通道值得优先消耗（额度不领就浪费）；额度已截止/没有 → 降权，
 * 避免把请求塞进一个已经没有免费额度的通道。
 *
 * 只在**同一成本组内**生效（不破坏「免费优先」硬规则）。
 *
 * @param {import('../pool/types.js').ModelEntry} entry
 * @param {{ quota?: { providers?: Record<string, any> } | null }} quota
 * @returns {number}
 */
export function quotaScore(entry, quota) {
  const info = quota?.providers?.[entry.provider]
  if (!info) return 0
  if (info.hasUsableQuota) return 30
  if (info.expired) return -30
  return 0
}

/**
 * 是不是「优先用的免费 flash 通道」。
 *
 * 用户口径：「免费的也优先用 deepseek v4 flash 的，然后除了 deepseek-account 的，
 * 其他的都在这个范围内」——
 *   - 必须 `cost === 'free'`（不花钱）
 *   - provider 不能是 `deepseek-account`（那是保底付费通道，要留在最后）
 *   - 模型名命中 deepseek + v4 + flash
 *
 * 为什么要单独一档而不是只调 priority：priority 只影响组内相对顺序，
 * 而这里要的是「免费组里，这批排在其它免费通道之前」—— 用加成实现，
 * 既不动 probe 的优先级配置，也不影响付费组。
 *
 * @param {import('../pool/types.js').ModelEntry} entry
 * @param {{ schedule?: { preferFlash?: { enabled?: boolean, providers?: readonly string[], bonus?: number } } }} config
 * @returns {number} 命中时返回加成值，否则 0
 */
export function preferFlashScore(entry, config) {
  const rule = config?.schedule?.preferFlash
  if (!rule || rule.enabled === false) return 0
  // 保底通道不参与优先：它要在最后才用。
  const blocked = rule.providers ?? []
  if (blocked.includes(entry.provider)) return 0
  if (entry.cost !== 'free') return 0
  const name = `${entry.model ?? ''}`.toLowerCase()
  if (!name.includes('deepseek')) return 0
  if (!/v?4(\.\d+)?/.test(name)) return 0
  if (!name.includes('flash')) return 0
  return typeof rule.bonus === 'number' ? rule.bonus : 0
}

/**
 * 排序用的比较器：先按 provider 置顶顺序，再按分数降序，
 * 同分时免费优先，再按失败次数、key 稳定排序。
 * @param {import('../pool/types.js').ModelEntry} a
 * @param {import('../pool/types.js').ModelEntry} b
 * @param {ScoreContext} context
 * @returns {number}
 */
export function compareEntries(a, b, context) {
  const rankA = providerRank(a.provider, context.config)
  const rankB = providerRank(b.provider, context.config)
  if (rankA !== rankB) return rankA - rankB

  const delta = scoreEntry(b, context) - scoreEntry(a, context)
  if (delta !== 0) return delta
  if (a.cost !== b.cost) return a.cost === 'free' ? -1 : 1
  if (a.failCount !== b.failCount) return a.failCount - b.failCount
  return a.key.localeCompare(b.key)
}
