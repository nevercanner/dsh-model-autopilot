/**
 * 探测凭据库里各 API Key 的真实可用性（不回显密钥值）。
 *
 * 用途：插件需要知道「用户已经配了哪些通道的 Key、这些 Key 通不通」，
 * 才能正确地把通道分成「已可用 / 已装待配 / 需先装」，而不是让用户重复注册。
 */
import fs from 'node:fs'

/**
 * 凭据库路径。`DSH_HOME` 已经是 `~/.dsh` 本身，不要再拼一层 `.dsh`。
 * @returns {string}
 */
export function credentialsPath() {
  const home = process.env.DSH_HOME
  const base = home && home.trim() !== '' ? home.trim() : process.env.HOME + '/.dsh'
  const normalized = base.replace(/[\\/]+$/, '')
  return /(^|[\\/])\.dsh([\\/]|$)/i.test(normalized)
    ? normalized + '/.credentials.yaml'
    : normalized + '/.dsh/.credentials.yaml'
}

const CRED_FILE = credentialsPath()

/**
 * 从凭据库文本里取出 refs 段的键值（只取 refs，records 里的是 OAuth 账号）。
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseRefs(text) {
  const out = new Map()
  const lines = text.split('\n')
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    // 退出 refs 段：出现新的顶层键（非缩进的行）
    if (inRefs && /^[A-Za-z]/.test(line)) break
    if (!inRefs) continue
    // 键值行：2 空格缩进，键名是 [A-Z0-9_]+
    const match = line.match(/^\s{2}([A-Z][A-Z0-9_]*):\s*(.+?)\s*$/)
    if (match) out.set(match[1], match[2].replace(/^["']|["']$/g, ''))
  }
  return out
}

/** 各平台的 OpenAI 兼容端点（用于探活）。 */
export const PROBE_TARGETS = [
  { env: 'SILICONFLOW_API_KEY', url: 'https://api.siliconflow.cn/v1/models', provider: 'siliconflow' },
  { env: 'ZHIPU_API_KEY', url: 'https://open.bigmodel.cn/api/paas/v4/models', provider: 'zhipu' },
  { env: 'SPARK_API_KEY', url: 'https://maas-api.cn-huabei-1.xf-yun.com/v2/models', provider: 'spark' },
  { env: 'AGNES_API_KEY', url: 'https://apihub.agnes-ai.cn/v1/models', provider: 'agnes' },
  { env: 'MINIMAX_CN_API_KEY', url: 'https://api.minimaxi.com/v1/models', provider: 'minimax-cn' },
  { env: 'BAILIAN_API_KEY', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models', provider: 'bailian' }
]

/**
 * 探活所有已存在的 Key。
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<Array<{ provider: string, env: string, present: boolean, status: number | null, usable: boolean, detail: string }>>}
 */
export async function probeCredentials(options = {}) {
  const timeoutMs = options.timeoutMs ?? 12_000
  let text = ''
  try {
    text = fs.readFileSync(CRED_FILE, 'utf8')
  } catch {
    text = ''
  }
  const refs = parseRefs(text)
  const results = []
  for (const target of PROBE_TARGETS) {
    const key = refs.get(target.env)
    if (!key) {
      results.push({
        provider: target.provider,
        env: target.env,
        present: false,
        status: null,
        usable: false,
        detail: '凭据库里没有这个记录'
      })
      continue
    }
    try {
      const response = await fetch(target.url, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(timeoutMs)
      })
      results.push({
        provider: target.provider,
        env: target.env,
        present: true,
        status: response.status,
        usable: response.status === 200,
        detail: response.status === 200 ? '可用' : `HTTP ${response.status}`
      })
    } catch (error) {
      results.push({
        provider: target.provider,
        env: target.env,
        present: true,
        status: null,
        usable: false,
        detail: /** @type {any} */ (error).message ?? '请求失败'
      })
    }
  }
  return results
}
