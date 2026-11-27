/**
 * 打分：同成本内排序的唯一依据。
 *
 * 硬规则不在分数里 —— 「免费永远先于付费」由 scheduler 单独执行，
 * 因为一旦把成本折成分数，一个优先级很高的付费模型就能在数值上超过一个
 * 状态很差的免费模型，规则会悄悄失效。这里的分数只用于**同成本组内**比较。
 *
 * @module schedule/scoring
 */

import { familyIndex } from '../pool/provider-id.js'

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
/**
 * deepseek v4 flash 的模型名匹配。
 *
 * 为什么要放宽：不同通道的 v4 flash 命名不一致 ——
 *   our-free-model      : `deepseek-v4-flash`
 *   workbuddy           : `deepseek-v4.1-flash`（带小版本号 .1）
 *   展示名（大小写）      : `Deepseek-V4.1-Flash`
 * 原来的 `/v4[-_.]?flash/` 匹配不到 `v4.1-flash`（中间多了 `.1`），
 * 结果 workbuddy 侧的 v4 flash 一直拿不到加分、排在免费组后面。
 *
 * 现在允许 `v4` 与 `flash` 之间出现任意版本后缀：`v4-flash` / `v4.1-flash` /
 * `v4_2_flash` 都命中；同时排除 `v4-pro` 这类非 flash 型号。
 */
/**
 * deepseek v4 flash 系列的模型名匹配。
 *
 * 为什么要这么宽：不同通道的 v4 flash 命名完全不统一，实测（our-free-model 的
 * registry.json 里有 1000+ 条模型 id）至少存在这些形态：
 *
 *   deepseek-v4-flash              连字符
 *   deepseek-v4.1-flash            带小版本号（workbuddy 用的就是这个）
 *   deepseek-v4-flash-free         带 free 后缀
 *   deepseek-v4.1-flash:cloud      带 :cloud 标签
 *   deepseek/deepseek-v4-flash     带 vendor 前缀路径
 *   deepseek-ai/DeepSeek-V4-Flash  vendor 前缀 + 大写
 *   cline-pass/deepseek-v4-flash   渠道前缀
 *   DeepSeek V4 Flash              **空格**分隔 + 首字母大写
 *   DeepSeek V4.1 Flash            空格 + 点号
 *   DeepSeek V4 Flash 0731         空格 + 数字后缀
 *   DeepSeek V4 Flash (ClinePass)   空格 + 括号后缀
 *   DeepSeek V4 Flash Vision (Exp) 空格 + vision 变体
 *
 * 所以规则是：deepseek 与 v4 之间、v4 与 flash 之间都允许任意分隔符
 * （空格 / 点 / 连字符 / 下划线），v4 之后允许跟版本号。
 *
 * 刻意**不**匹配：
 *   deepseek-v4-pro / V4 Pro      —— pro 不是 flash
 *   deepseek-flash                —— 没有 v4
 *   deepseek-chat / reasoner      —— 其它型号
 *   morph-dsv4flash               —— 那是 Morph 自己的模型，不是 DeepSeek 的
 *   glm-5.3-flash / gemini-*      —— 别的厂商
 */
const V4_FLASH_RE = /deepseek[\s._-]*v4(?:[\s._-]*\d+(?:[\s._-]\d+)*)?[\s._-]*flash/i

export function scoreEntry(entry, context) {
  const { now, config, quota } = context
  const rules = config.schedule
  let score = entry.priority

  // deepseek v4 flash 优先消耗。
  //
  // 分两档：免费渠道拿满额，付费渠道拿一半。
  //
  // 为什么付费渠道也加分：workbuddy 的 deepseek-v4.1-flash 在插件眼里是**付费**
  // 条目（provider 不在免费名单里，走的是订阅/credits 计费），但它是用户想优先
  // 用掉的那一档。而成本分组是 **provider 级**的（pool.js 里 cost 由 provider 决定，
  // 不看单模型 billing.free），所以「免费 v4 flash 置顶」这条规则如果只在免费组
  // 生效，workbuddy 侧的 v4 flash 就永远拿不到加分 —— 这正是之前它排在后面的原因。
  //
  // 免费拿满、付费拿半，是为了不破坏「免费优先于付费」这条硬规则：付费条目的
  // 基础分本来就低（无 priorityBonus），半额加分不足以让它越过任何可用的免费模型。
  if (V4_FLASH_RE.test(entry.model)) {
    score += entry.cost === 'free' ? rules.v4FlashFreeBonus : rules.v4FlashPaidBonus
  }

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
  // family 比对：置顶 'minimax-cn' 时 modlens 转发出来的同渠道也一起置顶，
  // 否则同一个账号会因为前缀不同被排到名单末尾。
  const index = familyIndex(provider, order)
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

  // 探针已经验证过的健康档，压过一切加分。
  //
  // 报障现场：/plan 把 `siliconflow/...V4.1-Flash`（探针判定 degraded，上游原文
  // 402 余额不足）排在 `agnes/agnes-3.0-flash`（available）前面，因为 v4 flash 的
  // +500 加分盖过了健康度差异。结果每一轮都先白白打 4-6 次必定失败的请求，
  // failCount 一路涨到 190+，还把池子的冷却全部占满。
  // 所以：先比健康档，同档内再比分数。
  const tierA = healthTier(a)
  const tierB = healthTier(b)
  if (tierA !== tierB) return tierA - tierB

  const delta = scoreEntry(b, context) - scoreEntry(a, context)
  if (delta !== 0) return delta
  if (a.cost !== b.cost) return a.cost === 'free' ? -1 : 1
  if (a.failCount !== b.failCount) return a.failCount - b.failCount
  return a.key.localeCompare(b.key)
}

/**
 * 健康档：越小越优先。顺序 = 「确定能用」→「不知道」→「有失败记录」→「冷却中」→「死了」。
 * @param {import('../pool/types.js').ModelEntry} entry
 * @returns {number}
 */
export function healthTier(entry) {
  switch (entry.health) {
    case 'available':
      return 0
    case 'unknown':
      return 1
    case 'degraded':
      return 2
    case 'cooling':
      return 3
    default:
      return 4
  }
}
