/**
 * 额度情报：AIHOT「Token 羊毛」清单的周期同步与缓存。
 *
 * 定位（重要）：这是**情报**，不是账号接管。清单里的额度都要用户自己去厂商官网
 * 实名/注册才能领，插件不会也不能替用户注册。它提供的是：
 *   - 某个通道现在有没有未过期的免费额度（→ 调度器优先消耗）
 *   - 额度什么时候截止、需不需要重新领（→ 面板提醒）
 *   - 官方领取链接（→ 面板一键跳转）
 *
 * 抓取失败绝不影响调度：情报拿不到就当作没有情报，排序退回原逻辑。
 *
 * @module aihot/quota-intel
 */
import { fetchFreeTokens, summarize } from './free-tokens.js'
import { failureOf } from '../util.js'

/**
 * @param {object} options
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} options.config
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {typeof fetchFreeTokens} [options.fetch] - 测试注入
 */
export function createQuotaIntel({ config, logger = console, fetch: fetchImpl = fetchFreeTokens }) {
  /** @type {null | ReturnType<typeof summarize>} */
  let snapshot = null
  /** @type {null | { at: number, error: string }} */
  let lastError = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let running = false

  const intervalMs = config.aihot?.quotaIntervalMs ?? 6 * 60 * 60_000

  /**
   * 同步一次。失败只记录，不抛。
   * @param {string} [reason]
   * @returns {Promise<{ ok: boolean, entries?: number, error?: string }>}
   */
  async function sync(reason = 'scheduled') {
    if (running) return { ok: false, error: '同步已在进行' }
    running = true
    try {
      const result = await fetchImpl()
      snapshot = summarize(result.entries, result.fetchedAt)
      lastError = null
      logger.info?.(
        `model-autopilot: 额度情报已更新（${reason}）—— ${snapshot.total} 条清单，` +
          `${snapshot.usableProviders} 个通道有可用额度`
      )
      return { ok: true, entries: snapshot.total }
    } catch (error) {
      lastError = { at: Date.now(), error: failureOf(error).message }
      logger.warn?.(`model-autopilot: 额度情报同步失败（${failureOf(error).message}）—— 排序退回原逻辑`)
      return { ok: false, error: lastError.error }
    } finally {
      running = false
    }
  }

  /**
   * 启动周期同步。返回 dispose。
   * @returns {() => void}
   */
  function start() {
    if (config.aihot?.quotaEnabled === false) {
      logger.info?.('model-autopilot: 额度情报已按配置关闭')
      return () => {}
    }
    // 启动后延迟一点再拉：不要和建池抢资源。
    timer = setTimeout(() => {
      timer = null
      sync('startup').catch(() => {})
    }, 5_000)
    timer.unref?.()

    const interval = setInterval(() => {
      sync('scheduled').catch(() => {})
    }, intervalMs)
    interval.unref?.()

    return () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      clearInterval(interval)
    }
  }

  return {
    start,
    sync,
    /**
     * 供调度器消费的情报。`providers` 形如 `{ [providerId]: { hasUsableQuota, expired, ... } }`。
     */
    quota: () => snapshot,
    status: () => ({
      enabled: config.aihot?.quotaEnabled !== false,
      fetchedAt: snapshot?.fetchedAt ?? 0,
      total: snapshot?.total ?? 0,
      usableProviders: snapshot?.usableProviders ?? 0,
      expiredProviders: snapshot?.expiredProviders ?? 0,
      lastError: lastError?.error ?? null,
      sourceUrl: 'https://aihot.news/free-tokens'
    })
  }
}
