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
import { QUOTA_CAUSE, classifyQuotaCause } from '../probe/classify.js'

/** 情报在 pool-state.json 里的命名空间 key。 */
const INTEL_KEY = 'aihot'

/**
 * @param {object} options
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} options.config
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {typeof fetchFreeTokens} [options.fetch] - 测试注入
 * @param {{ intel?: (key: string) => any, setIntel?: (key: string, value: any) => void }} [options.store]
 *   - 落盘走 createJsonStore 的 intel 段；不传就是纯内存（测试与降级）
 */
export function createQuotaIntel({ config, logger = console, fetch: fetchImpl = fetchFreeTokens, store = null }) {
  /** @type {null | ReturnType<typeof summarize>} */
  let snapshot = null
  /** @type {null | { at: number, error: string }} */
  let lastError = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let running = false

  /**
   * 额度成因台账：`{ [providerId]: { cause, at, detail } }`。
   *
   * 与池条目的 `quotaCause` 分工：条目上记的是「这个模型为什么不能用」，
   * 台账记的是「这个通道为什么不能用」—— 一个通道有 8 个模型，用户要的是
   * 「siliconflow 余额为 0」这一句，而不是 8 条一样的理由。
   */
  /** @type {Record<string, { cause: string, at: number, detail?: string }>} */
  let causes = {}

  /**
   * 从存档恢复：重启后第一次同步之前，排序与面板就有情报可用。
   * 只信任结构正确的值，坏档一律当没有。
   */
  if (store !== null && config.aihot?.quotaPersist !== false) {
    const saved = store.intel?.(INTEL_KEY)
    if (saved && typeof saved === 'object') {
      if (saved.snapshot && typeof saved.snapshot === 'object' && typeof saved.snapshot.total === 'number') {
        snapshot = saved.snapshot
      }
      if (saved.causes && typeof saved.causes === 'object') {
        for (const [id, value] of Object.entries(saved.causes)) {
          if (value && typeof value === 'object' && typeof value.cause === 'string') {
            causes[id] = {
              cause: value.cause,
              at: typeof value.at === 'number' ? value.at : 0,
              ...(typeof value.detail === 'string' ? { detail: value.detail } : {})
            }
          }
        }
      }
      if (snapshot !== null) {
        logger.info?.(`model-autopilot: 额度情报已从存档恢复（${snapshot.total} 条清单，更新于 ${new Date(snapshot.fetchedAt).toLocaleString()}）`)
      }
    }
  }

  /** 把当前快照 + 成因台账写回存档（合并窗口由 store 自己管）。 */
  function persist() {
    if (store === null || config.aihot?.quotaPersist === false) return
    store.setIntel?.(INTEL_KEY, { snapshot, causes, savedAt: Date.now() })
  }

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
      persist()
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
     * 记一条通道级额度成因（探针/真实调用失败时调用）。
     * @param {string} provider
     * @param {string} [detail] - 上游原文
     * @param {{ cause?: string, at?: number }} [options]
     * @returns {string} 认定后的成因标签
     */
    noteCause(provider, detail = '', options = {}) {
      const cause =
        typeof options.cause === 'string' && options.cause !== ''
          ? options.cause
          : classifyQuotaCause(detail)
      causes[provider] = { cause, at: options.at ?? Date.now(), ...(detail === '' ? {} : { detail: detail.slice(0, 300) }) }
      persist()
      return cause
    },
    /** @param {string} provider */
    causeOf(provider) {
      return causes[provider]?.cause ?? null
    },
    /** 全量台账（面板/诊断用）。 */
    causes: () => ({ ...causes }),
    /**
     * 清掉某通道的成因台账 —— 充值/续期/手动「提前恢复」时调用。
     *
     * 不清存档里的额度快照：快照是被抓来的事实，清掉它反而会让排序以为
     * 「这个通道没有情报」。要它立刻反映新额度，同步一次即可（`sync()`）。
     * @param {string} provider
     * @returns {boolean}
     */
    clearCause(provider) {
      const had = Object.hasOwn(causes, provider)
      if (!had) return false
      delete causes[provider]
      persist()
      return true
    },
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
      persisted: store !== null && config.aihot?.quotaPersist !== false,
      causes,
      causeKinds: Object.values(QUOTA_CAUSE),
      sourceUrl: 'https://aihot.news/free-tokens'
    })
  }
}
