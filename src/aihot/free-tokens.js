/**
 * AIHOT「Token 羊毛」清单解析。
 *
 * 数据源：https://aihot.news/free-tokens.md
 *   站点提供匿名只读 REST API（/api/v1/*，无需 Key），但羊毛清单目前**只有
 *   Markdown 版**（/api/v1/free-tokens 返回 404，已实测），所以这里解析 Markdown。
 *   页面同时提供 /free-tokens.md 的稳定形状：
 *
 *     ## 每天都能领（16 个）
 *     ### <标题>
 *     - 提供方：<厂商>
 *     - 能领多少：<额度与折算说明>
 *     - 怎么领：<步骤>
 *     - 能用在：<适用模型>
 *     - 门槛：<限制>
 *     - 有效期：<有效期>
 *     - 截止：<截止时间>
 *     - 核实：<核实时间>；<来源>
 *     - 去领：<链接>
 *
 * 用途：这不是「给用户注册账号」，而是**额度情报** —— 告诉调度器某个通道
 * 现在有没有免费额度、什么时候截止、要不要重新领取。它只提供公开的官方
 * 活动信息，不碰灰色渠道（返利/中转/共享账号一律不在清单里，站点自己已过滤）。
 *
 * @module aihot/free-tokens
 */
import { failureOf } from '../util.js'

/** 清单地址（Markdown 版是当前唯一可编程读取的形状）。 */
export const FREE_TOKENS_URL = 'https://aihot.news/free-tokens.md'

/** 请求 UA：站点建议附 aihot-actor 做去重统计，但那是可选项，不加也能用。 */
const USER_AGENT = 'dsh-model-autopilot/0.1 (+local DSH plugin)'

/**
 * @typedef {object} FreeTokenEntry
 * @property {string} id - 稳定 id（提供方 + 标题的 slug）
 * @property {string} title
 * @property {string} provider - 提供方（厂商）原文
 * @property {string} cadence - 分组：每天 / 每月 / 其他
 * @property {string} amount - 能领多少
 * @property {string} how - 怎么领
 * @property {string} usable - 能用在
 * @property {string} threshold - 门槛
 * @property {string} validity - 有效期
 * @property {string} deadline - 截止时间（原文）
 * @property {number} deadlineAt - 截止时间戳（能解析时；0 = 未知）
 * @property {string} verifiedAt - 核实时间（原文）
 * @property {number} verifiedAtMs - 核实时间戳（能解析时；0 = 未知）
 * @property {string} claimUrl - 去领链接
 * @property {boolean} productOnly - 是否仅限产品内使用（不能当通用 API）
 * @property {boolean} expired - 是否已过截止时间
 */

/** 厂商原文 → 宿主 provider id。映射不到的条目只进面板，不参与调度。 */
export const PROVIDER_ALIASES = Object.freeze({
  'MiniMax': 'minimax',
  'minimax': 'minimax',
  '阿里云 Qoder': 'qoder',
  'qoder': 'qoder',
  '字节 TRAE': 'trae',
  'trae': 'trae',
  '腾讯 WorkBuddy': 'workbuddy',
  'workbuddy': 'workbuddy',
  '智谱 ZCode': 'zcode',
  'zcode': 'zcode',
  '智谱 AutoClaw': 'zhipu',
  'Agnes AI': 'agnes',
  'agnes': 'agnes',
  '阿里云百炼': 'bailian',
  'bailian': 'bailian',
  '硅基流动': 'siliconflow',
  '魔搭社区': 'modelscope',
  '七牛云': 'qiniu',
  '面壁智能 MiniCPM': 'minicpm',
  'Cloudflare': 'cloudflare',
  '百度千帆': 'baidu-qianfan',
  '火山方舟': 'volcengine',
  '移动云 MobileClaw': 'mobileclaw',
  '商汤小浣熊': 'xiaohuanxiong',
  '科大讯飞 AStudio': 'astudio',
  'VModel': 'vmodel',
  'DeepSeek 官方搜索': 'deepseek-web'
})

/**
 * @param {string} provider - 厂商原文
 * @returns {string | null} 宿主 provider id；映射不到返回 null
 */
export function resolveProviderId(provider) {
  const key = provider.trim()
  if (PROVIDER_ALIASES[key]) return PROVIDER_ALIASES[key]
  const lower = key.toLowerCase()
  for (const [alias, id] of Object.entries(PROVIDER_ALIASES)) {
    if (alias.toLowerCase() === lower) return id
  }
  return null
}

/**
 * 解析「截止」里的日期。原文格式如「2026-12-05 23:59（北京时间）」。
 * @param {string} text
 * @returns {number} 时间戳；解析不出返回 0
 */
export function parseDeadline(text) {
  if (typeof text !== 'string' || text === '') return 0
  const match = text.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2})?:(\d{2})?/)
  if (!match) return 0
  const [, year, month, day, hour, minute] = match
  // 站点用北京时间；按 +08:00 解释再换算到本地毫秒。
  const iso = `${year}-${month}-${day}T${hour ?? '23'}:${minute ?? '59'}:00+08:00`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

/**
 * 解析「核实」里的时间（格式同上，通常到分钟）。
 * @param {string} text
 * @returns {number}
 */
export function parseVerifiedAt(text) {
  return parseDeadline(text)
}

/**
 * 把 Markdown 解析成条目数组。
 * @param {string} markdown
 * @returns {FreeTokenEntry[]}
 */
export function parseFreeTokens(markdown) {
  if (typeof markdown !== 'string' || markdown === '') return []
  const lines = markdown.split('\n')
  /** @type {FreeTokenEntry[]} */
  const entries = []
  let cadence = 'other'
  /** @type {null | { title: string, fields: Record<string, string> }} */
  let current = null

  const flush = () => {
    if (!current) return
    const fields = current.fields
    const provider = fields['提供方'] ?? ''
    const deadline = fields['截止'] ?? ''
    const deadlineAt = parseDeadline(deadline)
    const verifiedAt = fields['核实'] ?? ''
    const title = current.title.trim()
    entries.push({
      id: `${provider}|${title}`.slice(0, 160),
      title,
      provider,
      cadence,
      amount: fields['能领多少'] ?? '',
      how: fields['怎么领'] ?? '',
      usable: fields['能用在'] ?? '',
      threshold: fields['门槛'] ?? '',
      validity: fields['有效期'] ?? '',
      deadline,
      deadlineAt,
      verifiedAt,
      verifiedAtMs: parseVerifiedAt(verifiedAt),
      claimUrl: fields['去领'] ?? '',
      productOnly: /限产品内使用/.test(fields['门槛'] ?? ''),
      expired: deadlineAt > 0 && deadlineAt < Date.now()
    })
    current = null
  }

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      flush()
      const text = heading[1]
      if (text.includes('每天')) cadence = 'daily'
      else if (text.includes('每周')) cadence = 'weekly'
      else if (text.includes('每月')) cadence = 'monthly'
      else cadence = 'other'
      continue
    }
    if (line.startsWith('### ')) {
      flush()
      current = { title: line.slice(4), fields: {} }
      continue
    }
    const field = line.match(/^-\s+([^：]+)：(.*)$/)
    if (field && current) {
      const key = field[1].trim()
      const value = field[2].trim()
      current.fields[key] = current.fields[key] === undefined ? value : `${current.fields[key]} ${value}`
    }
  }
  flush()
  return entries
}

/**
 * 拉取并解析清单。
 * @param {{ fetch?: typeof fetch, timeoutMs?: number, url?: string }} [options]
 * @returns {Promise<{ entries: FreeTokenEntry[], fetchedAt: number, sourceUrl: string }>}
 */
export async function fetchFreeTokens(options = {}) {
  const doFetch = options.fetch ?? globalThis.fetch
  const url = options.url ?? FREE_TOKENS_URL
  const timeoutMs = options.timeoutMs ?? 15_000
  if (typeof doFetch !== 'function') throw new Error('model-autopilot: 没有可用的 fetch 实现')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  timer.unref?.()
  try {
    const response = await doFetch(url, {
      headers: { accept: 'text/markdown', 'user-agent': USER_AGENT },
      signal: controller.signal
    })
    if (!response.ok) throw new Error(`AIHOT 清单返回 HTTP ${response.status}`)
    const markdown = await response.text()
    return { entries: parseFreeTokens(markdown), fetchedAt: Date.now(), sourceUrl: url }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把清单按宿主 provider id 归拢。
 * @param {FreeTokenEntry[]} entries
 * @returns {Map<string, { provider: string, entries: FreeTokenEntry[], hasUsableQuota: boolean, expired: boolean }>}
 */
export function groupByProvider(entries) {
  /** @type {Map<string, { provider: string, entries: FreeTokenEntry[], hasUsableQuota: boolean, expired: boolean }>} */
  const groups = new Map()
  for (const entry of entries) {
    const id = resolveProviderId(entry.provider)
    if (id === null) continue
    let group = groups.get(id)
    if (!group) {
      group = { provider: id, entries: [], hasUsableQuota: false, expired: false }
      groups.set(id, group)
    }
    group.entries.push(entry)
    // 只限产品内使用的条目不算「可作为 API 用量的免费额度」。
    if (!entry.productOnly && !entry.expired) group.hasUsableQuota = true
    if (entry.expired) group.expired = true
  }
  return groups
}

/**
 * 通道的额度情报摘要（供面板与调度器使用）。
 * @param {FreeTokenEntry[]} entries
 * @param {number} [now]
 */
export function summarize(entries, now = Date.now()) {
  const groups = groupByProvider(entries)
  /** @type {Record<string, any>} */
  const byProvider = {}
  let usable = 0
  let expired = 0
  for (const [id, group] of groups) {
    byProvider[id] = {
      provider: id,
      entries: group.entries.length,
      hasUsableQuota: group.hasUsableQuota,
      expired: group.expired,
      nextDeadline: group.entries
        .map((entry) => entry.deadlineAt)
        .filter((value) => value > 0)
        .sort((a, b) => a - b)[0] ?? 0,
      claimUrls: group.entries.map((entry) => entry.claimUrl).filter(Boolean)
    }
    if (group.hasUsableQuota) usable += 1
    if (group.expired) expired += 1
  }
  return { fetchedAt: now, total: entries.length, providers: byProvider, usableProviders: usable, expiredProviders: expired }
}

/**
 * 失败信息统一走 failureOf，方便调用方记录。
 * @param {unknown} error
 */
export { failureOf }
