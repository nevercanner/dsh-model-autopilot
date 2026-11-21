/**
 * 失败 → 探针判决的分类器。
 *
 * 宿主把 adapter 的 throw 归一化成 `{code, message}` 的 LlmFailure 再塞进
 * `finish.reason.failure`（见 dsh-llm 的 adapterFailureChunk）。所以分类先看
 * 稳定的机器码，再看 message 兜底 —— 绝不靠猜文案来决定要不要切换模型。
 *
 * 已知码（来自 @deepseek-ai/dsh-llm）：
 *   RATE_LIMIT / QUOTA / ACCOUNT_QUOTA           → throttled
 *   SERVER / TIMEOUT / TRANSPORT / EMPTY_RESPONSE → timeout|empty（短暂）
 *   INVALID_CREDENTIAL / MISSING_CREDENTIAL / AUTH → auth（结构性）
 *   ABORTED                                       → aborted（不计数）
 *
 * @module probe/classify
 */
import { VERDICT } from '../pool/types.js'
import { failureOf } from '../util.js'

/** 限流/配额：等一会儿能好，但当下不该再打。 */
const THROTTLE_CODES = new Set(['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'RESOURCE_EXHAUSTED'])

/** 传输层短暂故障：冷却后复检。 */
const TRANSIENT_CODES = new Set(['SERVER', 'TIMEOUT', 'TRANSPORT', 'NETWORK', 'OVERLOADED', 'UNAVAILABLE'])

/** 空响应：通道通但模型没产出，按短暂故障处理。 */
const EMPTY_CODES = new Set(['EMPTY_RESPONSE'])

/** 结构性失败：不靠重试解决，需要换模型或修配置。 */
const AUTH_CODES = new Set([
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'AUTH',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'PERMISSION',
  'NO_ADAPTER',
  'INVALID_CATALOG'
])

/** 请求本身超限：不是这个模型的可用性问题（换模型可能有用，但不该拉黑它）。 */
const REQUEST_SCOPE_CODES = new Set(['CONTEXT_WINDOW_EXCEEDED', 'INVALID_ARGS', 'INVALID_MODEL_INFO'])

/**
 * 模型已下架/退役的文案特征。
 *
 * 为什么单独一组并**优先于地区/其它文案匹配**：这类失败是**永久**的
 * （模型被厂商摘除），一次即判死、不復检。混在 unknown 里会被 failCount
 * 次数规则误杀成「反复重试后 dead」，白烧探针预算，也把真实原因埋掉。
 *
 * 运行时证据：our-free-model 的 deepseek-v4.1-flash、openai/gpt-oss-20b
 * 都返回 "has reached its end of life"，早先被判 unknown。
 */
const RETIRED_PATTERNS = [
  /\bend[\s_-]?of[\s_-]?life\b/i,
  /\b(?:deprecated|discontinued|retired|sunset(?:ted)?)\b/i,
  /\bno\s+longer\s+(?:available|supported|served)\b/i,
  /\bmodel[\s_-]?(?:has\s+been\s+)?(?:removed|decommissioned)\b/i,
  /(?:模型|服务)(?:已)?(?:下线|下架|停用|停止服务|退役)/
]

/** 地区封锁的文案特征（英文 + 中文）。 */
const REGION_PATTERNS = [
  /\bnot\s+(?:available|supported|allowed)\s+(?:in|for)\s+(?:your|this|the)\s+(?:region|country|area|location)\b/i,
  /\bregion[\s_-]?(?:blocked|restricted|unsupported|unavailable|not\s+allowed)\b/i,
  /\b(?:geo|country)[\s_-]?(?:block|restrict|fenc)\w*\b/i,
  /(?:地区|区域|所在国家|您所在的)[^。，,]{0,12}(?:不可用|不支持|限制|封锁)/,
  /(?:不可用|不支持|限制)[^。，,]{0,12}(?:地区|区域)/
]

/** HTTP 状态码兜底（部分 adapter 只把状态塞进 message 或 code）。 */
const STATUS_PATTERNS = [
  { re: /\b429\b/, verdict: VERDICT.throttled },
  { re: /\b(?:401|403)\b/, verdict: VERDICT.auth },
  { re: /\b(?:408|504)\b/, verdict: VERDICT.timeout },
  { re: /\b5\d\d\b/, verdict: VERDICT.timeout }
]

/**
 * 中文失败文案特征。
 *
 * 为什么必须补：上游免费通道（our-free-model 的渠道包）大量使用中文报错，
 * 例如「gemini: 模型 X 的所有账号均不可用（限流或额度耗尽），请稍后再试」
 * 「免费额度已用完，请升级套餐」「积分不足」。这些文案不带稳定的机器码，
 * 只按英文模式匹配会把「额度耗尽」判成 unknown → 走错冷却/屏蔽策略。
 */
const CHINESE_PATTERNS = [
  // 限流 / 额度耗尽 / 配额
  {
    re: /(?:限流|流控|请求过于频繁|过于频繁|频率限制|稍后再试|稍后重试)/,
    verdict: VERDICT.throttled
  },
  {
    re: /(?:额度|配额|积分|余额|免费额度|余量)(?:已)?(?:用尽|用完|耗尽|不足|超限|不够)/,
    verdict: VERDICT.throttled
  },
  { re: /(?:所有账号|所有渠道|全部账号)(?:均)?不可用/, verdict: VERDICT.throttled },
  { re: /升级(?:套餐|计划|会员)/, verdict: VERDICT.throttled },
  { re: /(?:超出|超过)(?:上下文|最大)?(?:长度|窗口|限制)/, verdict: VERDICT.unavailable },
  // 账号层面的永久失效：禁用/封禁/冻结 → auth（一次即死，不复检）
  {
    re: /(?:账号|账户)(?:已)?(?:被)?(?:禁用|封禁|停用|限制|冻结)/,
    verdict: VERDICT.auth
  },
  {
    re: /(?:您的|该|当前)账号(?:已)?(?:被禁用|被封禁|异常|限制使用)/,
    verdict: VERDICT.auth
  },
  // 凭据 / 登录
  { re: /(?:未登录|尚未登录|登录已失效|登录过期|需要登录|请先登录|凭据无效|凭据缺失)/, verdict: VERDICT.auth },
  { re: /(?:无(?:可用)?凭据|没有可用凭据|无效的?令牌|令牌无效|授权失败)/, verdict: VERDICT.auth },
  // 网络 / 服务
  { re: /(?:连接失败|连接被拒绝|网络错误|网络异常|无法连接|请求失败)/, verdict: VERDICT.timeout },
  { re: /(?:服务(?:暂时)?不可用|网关错误|内部错误|服务器错误)/, verdict: VERDICT.unavailable },
  { re: /(?:超时|响应超时|读取超时)/, verdict: VERDICT.timeout }
]

/**
 * @param {string} text
 * @returns {import('../pool/types.js').ProbeVerdict | null}
 */
function classifyByText(text) {
  if (text === '') return null
  // 下架/退役优先：这是最确切的永久失效，不能被后面更宽松的模式（地区、限流）
  // 抢先匹配掉 —— 例如「this model is no longer available in your region」既像
  // 地区封锁又像下架，而真相是模型没了。
  for (const pattern of RETIRED_PATTERNS) if (pattern.test(text)) return VERDICT.retired
  for (const pattern of REGION_PATTERNS) if (pattern.test(text)) return VERDICT.regionBlocked
  for (const { re, verdict } of STATUS_PATTERNS) if (re.test(text)) return verdict
  if (/\b(?:rate[\s_-]?limit|too many requests|throttl)/i.test(text)) return VERDICT.throttled
  if (/\b(?:quota|insufficient[\s_-]?(?:quota|balance|credits?))/i.test(text)) return VERDICT.throttled
  if (/\b(?:invalid|missing|expired)[\s_-]?(?:api[\s_-]?key|credential)/i.test(text)) return VERDICT.auth
  // "Invalid bearer token" / "bad access token" 这类：凭据本身不能用，换模型才有意义。
  if (/\b(?:invalid|missing|expired|bad|revoked)\s+(?:bearer\s+|access\s+|api\s+|auth\s+)?token\b/i.test(text)) {
    return VERDICT.auth
  }
  if (/\bunauthori[sz]ed\b|\bforbidden\b/i.test(text)) return VERDICT.auth
  if (/\b(?:econnrefused|enotfound|etimedout|socket hang up|fetch failed)\b/i.test(text)) return VERDICT.timeout
  for (const { re, verdict } of CHINESE_PATTERNS) if (re.test(text)) return verdict
  return null
}

/**
 * 一次 LlmFailure → 判决。
 * @param {{ code?: string, message?: string } | null | undefined} failure
 * @returns {import('../pool/types.js').ProbeVerdict}
 */
export function classifyFailure(failure) {
  if (!failure) return VERDICT.unknown
  const code = typeof failure.code === 'string' ? failure.code.toUpperCase() : 'UNKNOWN'
  const message = typeof failure.message === 'string' ? failure.message : ''

  if (code === 'ABORTED') return VERDICT.aborted
  if (AUTH_CODES.has(code)) return VERDICT.auth
  if (THROTTLE_CODES.has(code)) return VERDICT.throttled
  if (EMPTY_CODES.has(code)) return VERDICT.empty
  if (TRANSIENT_CODES.has(code)) return code === 'TIMEOUT' ? VERDICT.timeout : VERDICT.unavailable
  if (REQUEST_SCOPE_CODES.has(code)) return VERDICT.unavailable

  const byText = classifyByText(`${code} ${message}`.trim())
  if (byText) return byText

  // 归一化后的 UNKNOWN：仍然算一次失败，但保留 unknown 以便面板区分“真不明”与“确知不可用”。
  return VERDICT.unknown
}

/**
 * 一次 throw → 判决。
 * @param {unknown} error
 * @returns {import('../pool/types.js').ProbeVerdict}
 */
export function classifyError(error) {
  const { code, message } = failureOf(error)
  // 输出被截断：宿主用 `finish.reason.kind = "max-tokens"`，部分上游则直接报
  // 「max_tokens 超过上限」「maximum output tokens」这类文案。
  if (
    code === 'MAX_TOKENS' ||
    code === 'MAX_OUTPUT_TOKENS' ||
    /\bmax(?:imum)?[\s_-]?(?:output[\s_-]?)?tokens?\b/i.test(message) ||
    /输出.{0,6}(?:上限|超长|过长)/.test(message)
  ) {
    return 'truncated'
  }
  return classifyFailure({ code, message })
}

/**
 * 判定一次流式结果：只有「正常结束且产出过内容」才算 ok。
 * @param {{ sawContent: boolean, finishKind?: string, failure?: any }} outcome
 * @returns {import('../pool/types.js').ProbeVerdict}
 */
export function classifyOutcome(outcome) {
  if (outcome.failure) return classifyFailure(outcome.failure)
  if (outcome.finishKind === 'aborted') return VERDICT.aborted
  if (outcome.finishKind === 'error') return VERDICT.unknown
  if (!outcome.sawContent) return VERDICT.empty
  return VERDICT.ok
}
