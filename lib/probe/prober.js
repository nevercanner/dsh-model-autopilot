/**
 * 探针调度器：决定「这一轮探谁、多久探一次、结果怎么回到池里」。
 *
 * 两条硬规则：
 * 1. 免费模型每轮全量探测 —— 免费通道的失效是常态而不是异常，不探就等于把
 *    请求随机丢给一个已经不响的端点。
 * 2. 付费模型只在状态异常时探测 —— 健康付费模型每 10 分钟探一次等于白烧钱。
 *
 * 探测预算按轮截断（maxPerRound），单轮并发受 concurrency 约束：免费网关按
 * session 计数配额，一轮打 20 个并发会把彼此 429 掉，探出来的判决反而失真。
 *
 * @module probe/prober
 */
import { probeOnce } from './probe.js'
import { HEALTH } from '../pool/types.js'
import { runLimited, failureOf } from '../util.js'

/** 不健康状态的探测紧迫度：数字越小越先探。 */
const URGENCY = {
  // 从没验证过的（unknown）与要复检的（dead/cooling）同档，都排在健康条目前面。
  // 不这样排的话，新加入的通道会被 dead 条目的复检挤掉「探针额度」，
  // 永远探不到 —— 表现是「配好了 Key，但面板一直显示 unknown」。
  [HEALTH.unknown]: 0,
  [HEALTH.dead]: 0,
  [HEALTH.cooling]: 0,
  [HEALTH.degraded]: 1,
  [HEALTH.available]: 2
}

/**
 * @param {object} options
 * @param {{ llm?: any, logger?: any }} options.ctx
 * @param {ReturnType<typeof import('../pool/pool.js').createPool>} options.pool
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} options.config
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {typeof probeOnce} [options.probe] - 测试注入
 */
export function createProber({ ctx, pool, config, logger = console, probe = probeOnce }) {
  /** @type {ReturnType<typeof setInterval> | null} */
  let interval = null
  /** @type {ReturnType<typeof setTimeout> | null} */
  let firstTimer = null
  let running = false
  /** @type {Promise<any> | null} */
  let currentRound = null
  /** @type {number} */
  let lastRoundAt = 0
  /** @type {{ key: string, verdict: string, latencyMs: number }[]} */
  let lastRound = []

  /**
   * 本轮到期且值得探测的条目。
   * @param {number} now
   * @returns {import('../pool/types.js').ModelEntry[]}
   */
  function selectDue(now) {
    const due = []
    for (const entry of pool.all()) {
      if (entry.nextProbeAt > now) continue
      if (entry.cost === 'free') {
        due.push(entry)
        continue
      }
      // 付费：只在“有失败历史”或显式开启时探。
      // health=unknown 的付费条目也不探 —— 付费模型是否可用由真实调用驱动，
      // 首轮把所有付费模型探一遍等于开局就烧一遍钱。
      const troubled =
        entry.health === HEALTH.degraded || entry.health === HEALTH.cooling || entry.health === HEALTH.dead
      if (config.probe.paidProbeWhenHealthy || troubled) due.push(entry)
    }
    due.sort((a, b) => {
      if (a.cost !== b.cost) return a.cost === 'free' ? -1 : 1
      const urgency = (URGENCY[a.health] ?? 9) - (URGENCY[b.health] ?? 9)
      if (urgency !== 0) return urgency
      // 同档内的 tie-break，三档递进：
      //   ① 从未探过（nextProbeAt === 0）最先 —— 新加入/刚配好 Key 的通道
      //      必须马上验证，否则会被老故障条目一直挤掉探针预算。
      //   ② 出过问题要复检的（dead / cooling）其次。
      //   ③ 其余按 nextProbeAt 早的先探。
      const never = (entry) => (entry.nextProbeAt ?? 0) === 0
      if (never(a) !== never(b)) return never(a) ? -1 : 1
      const aTroubled = a.health === HEALTH.dead || a.health === HEALTH.cooling
      const bTroubled = b.health === HEALTH.dead || b.health === HEALTH.cooling
      if (aTroubled !== bTroubled) return aTroubled ? -1 : 1
      return a.nextProbeAt - b.nextProbeAt
    })
    return due.slice(0, config.probe.maxPerRound)
  }
  /**
   * 探一条并写回池。
   * @param {import('../pool/types.js').ModelEntry} entry
   * @param {AbortSignal} [signal]
   */
  async function probeAndWrite(entry, signal) {
    const result = await probe(ctx.llm, entry, { timeoutMs: config.probe.timeoutMs, signal })
    const at = Date.now()
    pool.markProbe(entry.key, result.verdict, { at, latencyMs: result.latencyMs, detail: result.detail })
    if (result.verdict !== 'ok') {
      logger.warn?.(
        `model-autopilot: 探针 ${entry.key} → ${result.verdict}` +
          (result.detail ? `（${truncate(result.detail)}）` : '')
      )
    }
    return { key: entry.key, verdict: result.verdict, latencyMs: result.latencyMs }
  }

  /**
   * 跑一轮。上一轮未结束时返回同一个进行中的 Promise —— 周期探测与手动触发
   * 合流，而不是让手动触发静默跳过（否则面板上点“立刻探测”会像没反应）。
   * @param {string} [reason]
   * @returns {Promise<{ probed: number, skipped: boolean, results: {key:string,verdict:string,latencyMs:number}[] }>}
   */
  function round(reason = 'scheduled') {
    if (currentRound) return currentRound
    currentRound = (async () => {
      running = true
      const started = Date.now()
      const now = started
      try {
        const targets = selectDue(now)
        if (targets.length === 0) {
          lastRoundAt = started
          return { probed: 0, skipped: false, results: [] }
        }
        /** @type {{key:string,verdict:string,latencyMs:number}[]} */
        const results = []
        await runLimited(targets, config.probe.concurrency, async (entry) => {
          try {
            results.push(await probeAndWrite(entry))
          } catch (error) {
            // probeOnce 自己已经吞掉常规失败；能到这里说明是写回或记账层的问题。
            logger.warn?.(`model-autopilot: 探针 ${entry.key} 异常 (${failureOf(error).message})`)
          }
        })
        lastRound = results
        lastRoundAt = Date.now()
        const ok = results.filter((item) => item.verdict === 'ok').length
        logger.info?.(
          `model-autopilot: 探针轮(${reason}) ${results.length}/${targets.length} 完成，ok ${ok} 条，耗时 ${lastRoundAt - started}ms`
        )
        return { probed: results.length, skipped: false, results }
      } finally {
        running = false
      }
    })().finally(() => {
      currentRound = null
    })
    return currentRound
  }

  /**
   * 手动探一条（面板按钮 / 命令）。
   * @param {string} key
   * @returns {Promise<{ key: string, verdict: string, latencyMs: number } | null>}
   */
  async function probeKey(key) {
    const entry = pool.get(key)
    if (!entry) return null
    return probeAndWrite(entry)
  }

  /**
   * 启动周期探测。返回 dispose，随 fiber 释放。
   * @returns {() => void}
   */
  function start() {
    const immediate = () => {
      round('startup').catch((error) => logger.warn?.(`model-autopilot: 启动探测失败 (${failureOf(error).message})`))
    }
    if (config.probe.firstRoundDelayMs > 0) {
      firstTimer = setTimeout(() => {
        firstTimer = null
        immediate()
      }, config.probe.firstRoundDelayMs)
      firstTimer.unref?.()
    } else {
      immediate()
    }

    if (config.probe.intervalMs > 0) {
      interval = setInterval(() => {
        round('scheduled').catch((error) =>
          logger.warn?.(`model-autopilot: 周期探测失败 (${failureOf(error).message})`)
        )
      }, config.probe.intervalMs)
      interval.unref?.()
    }

    return () => {
      if (firstTimer !== null) {
        clearTimeout(firstTimer)
        firstTimer = null
      }
      if (interval !== null) {
        clearInterval(interval)
        interval = null
      }
    }
  }

  return {
    start,
    round,
    probeKey,
    /** @param {number} [now] */
    selectDue,
    status() {
      return {
        running,
        lastRoundAt,
        lastRoundCount: lastRound.length,
        intervalMs: config.probe.intervalMs,
        dueNow: selectDue(Date.now()).length,
        lastRound
      }
    }
  }
}

/** @param {string} text @param {number} [max] */
function truncate(text, max = 160) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
