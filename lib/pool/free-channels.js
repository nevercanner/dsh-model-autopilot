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
 * 判据是「这些通道此刻走的是厂商白送额度」。若某天用户改成了付费订阅，把对应 id
 * 移到 config.paid.providers 即可覆盖。
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
  'zhipu'
])

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
