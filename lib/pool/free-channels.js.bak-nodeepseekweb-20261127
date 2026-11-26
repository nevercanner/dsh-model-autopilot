/**
 * 已知免费通道清单。
 *
 * 为什么需要一份清单：免费与否不是程序能推断出来的事实 —— 它取决于
 * 某个插件用什么渠道拿到的额度。宿主暴露的 provider 元数据只有 id 和 name，
 * 没有“我来自哪个插件”。所以这里维护一份「已确认免费」的通道名单，
 * 并允许用户在 config.free.providers / config.paid.providers 里覆盖。
 *
 * 名单来源（可审计，不是猜的）：
 *   - dsh-our-free-model 2.8.3 的 package 描述：十个账号渠道（2026-11-26 该插件已隔离，
 *     渠道本体仍在，但不再随插件回装；名单里已移除 'our-free-model' 本身）
 *     （LobsterAI / Qoder / TRAE / Cline / Loomy / Raccoon / MiniMax / ZCode / Gemini）
 *     加匿名免费通道与本地转发车道。
 *   - modlens 把免费车道以 `modlens-<渠道>` 再注册一份（modlens vision），
 *     所以前缀剥离后按同一份名单判定。
 *
 * 不在名单里的（spark / bailian / minimax-cn / deepseek-* / workbuddy*）
 * 一律按付费处理：它们依赖用户自己的 API key 或订阅额度，把它当免费会让
 * “免费优先”变成“先烧用户的钱”。需要时用 config.free.providers 显式加入。
 *
 * 例外（2026-11 更新）：下面这批是「用户自己注册 + 实名领到的**厂商免费 API
 * 配额**」——不是订阅付费，用的是厂商白送的新人/每日额度：
 *   - agnes       厂商给免费 API Key，指定 Flash 型号限时免费
 *   - siliconflow 实名认证送通用代金券 + 一批模型定价 0 元
 *   - bailian     阿里云百炼新人额度（各模型各 100 万 Token）
 *   - zhipu       智谱开放平台免费额度
 *   - sensenova   商汤日日新免费额度（凭据库 SENSENOVA_API_KEY）
 *   - spark       讯飞星火免费包（凭据库 SPARK_API_KEY）
 * 判据是「这些通道此刻走的是厂商白送额度」。若某天用户改成了付费订阅，把对应 id
 * 移到 config.paid.providers 即可覆盖。
 *
 * **限时额度必须带到期日**（`DEFAULT_CHANNEL_EXPIRY`）。厂商免费额度是促销，
 * 到期后同一条调用开始按量计费；名单里如果只写"免费"不写期限，到期那天插件会
 * 继续把它当免费候选烧钱——这正是 v0.2.8 修掉的那类账（把付费当免费）。
 * 到期后该通道自动降级为付费（`freeClassOf` 返回 null），即便
 * `free.defaultFree: true` 也不会把它捞回免费队列。
 *
 * @module pool/free-channels
 */

import { FORWARD_PREFIX, providerFamily } from './provider-id.js'

/**
 * 已确认的免费通道 id（小写）。
 */
export const DEFAULT_FREE_CHANNELS = Object.freeze([
  // 十个账号渠道（免费额度，不需要 API key）
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'cline',
  'loomy',
  'raccoon',
  'zcode',
  'gemini',
  'minimax',
  'deepseek-web',
  // 用户自行注册、领厂商免费 API 配额的通道（凭据库里已有对应 Key）
  'agnes',
  'siliconflow',
  'bailian',
  'zhipu',
  'sensenova',
  'spark'
])

/**
 * 限时免费额度的到期日（含当天有效），ISO `YYYY-MM-DD`，按 UTC 日界判定。
 *
 * 只登记**厂商明确给了期限**的促销额度；账号渠道（lobsterai / qoder / trae …）
 * 是账号权益，不在这里。要延长/取消某个通道的期限，改 config.free.channelExpiry
 * （按 family 覆盖，`null` 表示"不设期限"）。
 */
export const DEFAULT_CHANNEL_EXPIRY = Object.freeze({
  agnes: '2026-12-31',
  siliconflow: '2026-12-31',
  bailian: '2026-12-31',
  zhipu: '2026-12-31',
  sensenova: '2026-12-31',
  spark: '2026-12-31',
  openference: '2026-12-31'
})


// modlens 转发前缀的剥离与 family 归一化统一由 pool/provider-id.js 负责：
// 免费名单、付费名单、排除名单必须用**同一套**归一化，否则
// `deepseek-account` 与 `modlens-deepseek-account` 会落在不同判断里（真实事故）。
export { FORWARD_PREFIX as MODLENS_PREFIX }

/**
 * provider id 是否命中免费通道名单（含 modlens 转发前缀剥离）。
 *
 * 只看名单命中，不做子串猜测：子串兜底是 `config.free.patterns` 的职责
 * （`freeClassOf` 里判定依据会标成 'pattern'）。这样「把某个 id 从名单里删掉」
 * 就真的是删掉了，不会被一条隐藏的 includes('free') 悄悄判回免费。
 *
 * @param {string} providerId
 * @param {readonly string[]} [channels]
 * @returns {boolean}
 */
export function matchesFreeChannel(providerId, channels = DEFAULT_FREE_CHANNELS) {
  const family = providerFamily(providerId)
  if (family === '') return false
  for (const channel of channels ?? []) {
    if (providerFamily(channel) === family) return true
  }
  return false
}

/**
 * 某个 provider 的免费额度到期日（ISO `YYYY-MM-DD`），没有登记则 `null`。
 *
 * 按 family 查（`modlens-sensenova` 与 `sensenova` 共用同一份额度、同一个期限）。
 * 显式传 `null` 可表示"该通道不设期限"，因此用 `hasOwnProperty` 区分
 * "没登记"和"登记为无期限"。
 *
 * @param {string} providerId
 * @param {Record<string, string|null>} [expiry]
 * @returns {string|null}
 */
export function channelExpiry(providerId, expiry = DEFAULT_CHANNEL_EXPIRY) {
  const family = providerFamily(providerId)
  if (family === '' || !expiry) return null
  for (const [channel, date] of Object.entries(expiry)) {
    if (providerFamily(channel) !== family) continue
    return typeof date === 'string' && date.trim() !== '' ? date.trim() : null
  }
  return null
}

/**
 * 到期日是否已过（`YYYY-MM-DD` **含当天有效**，按 UTC 日界）。
 *
 * 用日界而不是时间戳，是因为厂商写的是"12月31日前有效"这种日期承诺；
 * 差几个小时的时区边界远比"到期日当天被提前判死"更可接受。
 *
 * @param {string|null|undefined} date
 * @param {number} [now]
 * @returns {boolean}
 */
export function isExpiryPassed(date, now = Date.now()) {
  if (typeof date !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!m) return false
  const endMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999)
  return now > endMs
}

/**
 * 通道的免费状态详解（给调度与诊断面板共用）。
 *
 * 三种结果：
 *  - `{ channel: false }`            不在名单里
 *  - `{ channel: true, expired: false, expiresAt }`  名单内且未到期
 *  - `{ channel: true, expired: true, expiresAt }`   名单内但促销已结束 → 按付费处理
 *
 * @param {string} providerId
 * @param {{ channels?: readonly string[], channelExpiry?: Record<string, string|null> }} [options]
 * @param {number} [now]
 * @returns {{ channel: boolean, expired: boolean, expiresAt: string|null }}
 */
export function freeChannelStatus(providerId, options = {}, now = Date.now()) {
  const channels = options.channels ?? DEFAULT_FREE_CHANNELS
  const expiryMap = options.channelExpiry ?? DEFAULT_CHANNEL_EXPIRY
  if (!matchesFreeChannel(providerId, channels)) {
    return { channel: false, expired: false, expiresAt: null }
  }
  const expiresAt = channelExpiry(providerId, expiryMap)
  return { channel: true, expired: isExpiryPassed(expiresAt, now), expiresAt }
}
