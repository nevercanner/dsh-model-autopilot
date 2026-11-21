/**
 * 凭据存在性查询：**只看「配没配」，绝不读取密钥值**。
 *
 * 为什么需要：面板要回答「这个通道我到底配没配 Key」。用户已经配好的通道
 * （AGNES_API_KEY / SILICONFLOW_API_KEY / …）绝不能再让他去注册一遍。
 *
 * 走宿主凭据服务的 `describe(ref)`：它只回 `{configured, source, writable}`，
 * 不回值。这样插件连密钥内容都碰不到。
 *
 * @module registry/credentials
 */
import { PROVIDER_CRED_ENV } from '../onboarding.js'

/**
 * 凭据引用的构造方式。宿主用 `credentialRef(name)` 包装环境变量名；
 * 这里不能 import 宿主包（避免外部依赖），但可以直接传字符串名 ——
 * 凭据服务的 `values` map 就是按名字索引的。
 *
 * @param {string} name
 * @returns {string}
 */
function refOf(name) {
  return name
}

/**
 * 查询各通道的凭据是否已配置。
 *
 * @param {any} ctx - cordis context（用 ctx.get('credentials')）
 * @param {readonly string[]} [providers] - 要查的 provider id 列表
 * @returns {Promise<Record<string, { configured: boolean, source: string | null }>>}
 */
export async function describeCredentials(ctx, providers = Object.keys(PROVIDER_CRED_ENV)) {
  /** @type {Record<string, { configured: boolean, source: string | null }>} */
  const result = {}
  const service = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  if (!service || typeof service.describe !== 'function') {
    // 拿不到凭据服务：全部标成未知，不能谎称「没配」。
    for (const provider of providers) result[provider] = { configured: false, source: null }
    return result
  }
  for (const provider of providers) {
    const env = PROVIDER_CRED_ENV[provider]
    if (!env) {
      result[provider] = { configured: false, source: null }
      continue
    }
    try {
      const info = await service.describe(refOf(env))
      result[provider] = {
        configured: info?.configured === true,
        source: typeof info?.source === 'string' ? info.source : null
      }
    } catch {
      result[provider] = { configured: false, source: null }
    }
  }
  return result
}
