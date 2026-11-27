/**
 * 选型：给定一次需求，输出「首选 + 候选链」。
 *
 * 规则顺序是硬编码的，配置只能调权重，不能改顺序 —— 「免费优先」是产品约定，
 * 不是可调参数：
 *
 *   1. 过滤：能力不够 / 本轮已失败 / dead / 冷却中（cooldownUntil > now）
 *   2. allowPaid=false 时只剩免费
 *   3. 同成本组内按 score 降序
 *   4. 有可用免费 → 首选取最高分免费；否则（且允许付费）→ 首选取最高分付费
 *   5. 都不行 → primary=null，交给 failover 报错（而不是硬塞一个 dead 条目）
 *
 * @module schedule/scheduler
 */
import { checkCapability } from './capability.js'
import { compareEntries, scoreEntry } from './scoring.js'

/**
 * @typedef {object} ScheduleRequest
 * @property {import('./capability.js').CapabilityRequirement} [requirement]
 * @property {boolean} [allowPaid]
 * @property {string[]} [exclude] - 本次请求里已经失败过的 key
 * @property {number} [now]
 */

/**
 * @typedef {object} ScheduleResult
 * @property {import('../pool/types.js').ModelEntry | null} primary
 * @property {import('../pool/types.js').ModelEntry[]} fallbacks
 * @property {import('../pool/types.js').ModelEntry[]} candidates - 过滤后的完整候选链
 * @property {string} reason
 * @property {{ key: string, reason: string }[]} rejected - 被过滤掉的原因（诊断用）
 */

/**
 * @param {object} options
 * @param {ReturnType<typeof import('../pool/pool.js').createPool>} options.pool
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} options.config
 * @param {{ info?: Function }} [options.logger]
 */
export function createScheduler({ pool, config, logger = console, preference = null, quota = null }) {
  /**
   * 首选 provider 的可用候选（跨成本组，压过免费优先）。
   * plan() 与 explain() 共用，保证「面板显示的顺序」与「实际选型」一致。
   * @param {import('../pool/types.js').ModelEntry[]} candidates
   * @returns {{ primary: import('../pool/types.js').ModelEntry | null, pinned: { provider: string, model: string | null } | null }}
   */
  function pinnedPrimary(candidates) {
    const pinned = preference?.isPinned?.() ? preference.get() : null
    if (!pinned) return { primary: null, pinned: null }
    const matches = candidates.filter(
      (entry) => entry.provider === pinned.provider && (pinned.model === null || entry.model === pinned.model)
    )
    return { primary: matches[0] ?? null, pinned }
  }

  /**
   * @param {ScheduleRequest} [request]
   * @returns {ScheduleResult}
   */
  function plan(request = {}) {
    const now = request.now ?? Date.now()
    const allowPaid = request.allowPaid ?? config.schedule.allowPaidByDefault
    const exclude = new Set(request.exclude ?? [])
    /** @type {{ key: string, reason: string }[]} */
    const rejected = []
    /** 首选被跳过时的说明（面板/日志要能回答「为什么首选没被选」）。 */
    let pinnedSkipped = null

    /** @type {import('../pool/types.js').ModelEntry[]} */
    const candidates = []
    for (const entry of pool.all()) {
      if (exclude.has(entry.key)) {
        rejected.push({ key: entry.key, reason: '本轮已失败' })
        continue
      }
      if (entry.health === 'dead') {
        rejected.push({ key: entry.key, reason: 'dead' })
        continue
      }
      if (entry.cooldownUntil > now) {
        rejected.push({ key: entry.key, reason: `冷却至 +${Math.ceil((entry.cooldownUntil - now) / 1000)}s` })
        continue
      }
      if (!allowPaid && entry.cost === 'paid') {
        rejected.push({ key: entry.key, reason: 'allowPaid=false' })
        continue
      }
      const capability = checkCapability(entry, request.requirement)
      if (!capability.ok) {
        rejected.push({ key: entry.key, reason: capability.reason ?? '能力不足' })
        continue
      }
      candidates.push(entry)
    }

    const context = { now, config, quota }

    // 首选 provider（用户锁定）：压过免费优先。
    // 理由是用户可能给某个通道充了限时额度，不用就是纯亏 —— 「免费优先」是默认
    // 策略，不是不可动摇的教条；锁定是用户显式表达的覆盖。
    const { primary: pinned, pinned: pinnedInfo } = pinnedPrimary(candidates)
    if (pinned) {
      const rest = candidates.filter((entry) => entry !== pinned)
      // 让位顺序恢复「免费优先」：锁定失效时尽快回到免费通道。
      const freeRest = rest.filter((entry) => entry.cost === 'free')
      const paidRest = rest.filter((entry) => entry.cost === 'paid')
      return {
        primary: pinned,
        fallbacks: [...freeRest, ...paidRest],
        candidates,
        reason: `pinned:${pinnedInfo.provider}`,
        rejected
      }
    }
    if (pinnedInfo) {
      // 锁定项此刻不可用（冷却/熔断/未装配）：不阻塞，直接让位给免费通道。
      // 但必须说清「为什么没选它」——否则用户只看到首选被无视，无从排查。
      const why = rejected.filter((item) => item.key.startsWith(`${pinnedInfo.provider}/`))
      const detail = why.length > 0 ? why.map((item) => `${item.key}: ${item.reason}`).join('; ') : '候选集中不存在'
      pinnedSkipped = { provider: pinnedInfo.provider, model: pinnedInfo.model, reason: detail }
      logger.info?.(`model-autopilot: 首选 ${pinnedInfo.provider} 当前不可用，回落到免费优先（${detail}）`)
    }

    candidates.sort((a, b) => compareEntries(a, b, context))

    const free = candidates.filter((entry) => entry.cost === 'free')
    const paid = candidates.filter((entry) => entry.cost === 'paid')

    /** @type {ScheduleResult} */
    if (free.length > 0) {
      return {
        primary: free[0],
        fallbacks: [...free.slice(1), ...paid],
        candidates,
        reason: paid.length > 0 ? 'free:preferred' : 'free:only',
        rejected,
        ...(pinnedSkipped === null ? {} : { pinnedSkipped })
      }
    }

    if (paid.length > 0) {
      // 免费要么全在冷却/dead，要么被 allowPaid 之外的规则筛掉 —— 这不是理想路径，
      // 但比直接失败强。日志里要能看出走了这条路。
      logger.info?.(`model-autopilot: 无可用免费模型，回落到付费 ${paid[0].key}`)
      return {
        primary: paid[0],
        fallbacks: paid.slice(1),
        candidates,
        reason: 'free:none→paid',
        rejected,
        ...(pinnedSkipped === null ? {} : { pinnedSkipped })
      }
    }

    // 全池都在冷却：不能 0 次尝试直接失败。
    //
    // 报障现场：「无可用候选，一次都未尝试（28 个冷却中，5 个付费被 allowPaid=false
    // 挡住）」——用户等 20 秒重试，两轮都这样。冷却时长是从**过去的**失败推出来的
    // 预测，不是「这一刻一定不通」的事实；上游 429/超时大多是瞬时的，把最早到期的
    // 那条捞回来打一次，最坏结果只是多记一次 failCount（然后它继续冷却），
    // 而立刻失败是 100% 拿不到回答。
    if (config.schedule.coolingFallback !== false) {
      const soonest = pool
        .all()
        .filter((entry) => !exclude.has(entry.key))
        .filter((entry) => entry.health !== 'dead')
        .filter((entry) => entry.cooldownUntil > now)
        .filter((entry) => allowPaid || entry.cost !== 'paid')
        .filter((entry) => checkCapability(entry, request.requirement).ok)
        .sort((a, b) => {
          if (a.cost !== b.cost) return a.cost === 'free' ? -1 : 1
          const leftA = a.cooldownUntil - now
          const leftB = b.cooldownUntil - now
          // 先看谁先解冻（差 5 秒内的算同一档，交给分数决定），再看分数。
          if (Math.abs(leftA - leftB) > 5_000) return leftA - leftB
          return compareEntries(a, b, context)
        })
      if (soonest.length > 0) {
        logger.info?.(`model-autopilot: 全池冷却，取最早解冻的 ${soonest[0].key}（+${Math.ceil((soonest[0].cooldownUntil - now) / 1000)}s）试一次`)
        return {
          primary: soonest[0],
          fallbacks: soonest.slice(1),
          candidates: soonest,
          reason: 'free:cooling-last-resort',
          ...(pinnedSkipped === null ? {} : { pinnedSkipped }),
          rejected
        }
      }
    }

    return {
      primary: null,
      fallbacks: [],
      candidates,
      reason: allowPaid ? 'no-candidate' : 'no-candidate:free-only',
      ...(pinnedSkipped === null ? {} : { pinnedSkipped }),
      rejected
    }
  }

  /**
   * 诊断：为什么某个条目排在这个位置。
   * @param {ScheduleRequest} [request]
   * @returns {{ key: string, score: number, cost: string, health: string, cooldownLeft: number }[]}
   */
  function explain(request = {}) {
    const now = request.now ?? Date.now()
    const context = { now, config, quota }
    const candidates = pool
      .all()
      .filter((entry) => entry.health !== 'dead' && entry.cooldownUntil <= now)
      .filter((entry) => checkCapability(entry, request.requirement).ok)

    // 与 plan() 同一口径：首选 provider 排第一，其余按「免费优先 + 分数」。
    const { primary: pinned } = pinnedPrimary(candidates)
    const rest = candidates.filter((entry) => entry !== pinned)
    rest.sort((a, b) => {
      if (a.cost !== b.cost) return a.cost === 'free' ? -1 : 1
      return compareEntries(a, b, context)
    })
    const ordered = pinned ? [pinned, ...rest] : rest

    return ordered.map((entry) => ({
      key: entry.key,
      score: Math.round(scoreEntry(entry, context)),
      cost: entry.cost,
      health: entry.health,
      cooldownLeft: Math.max(0, entry.cooldownUntil - now),
      pinned: pinned !== null && entry.key === pinned.key
    }))
  }

  return { plan, explain }
}
