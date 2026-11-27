/**
 * 探针判决 → 池状态迁移。
 *
 * 纯函数：输入一个条目（或其可写快照）与一次判决，输出要写回的字段。
 * 把规则集中在这里，是为了“什么算失效、冷却多久、什么时候该屏蔽”都能被单测
 * 用一张表覆盖，而不是散在探测循环里。
 *
 * 核心原则（修复后）：
 *   - 结构性失效（auth / region-blocked / 模型已下架）：一次即 dead，永久屏蔽，不按次数累积。
 *   - 瞬时失效（throttled / timeout / unavailable / empty）：只进冷却，绝不靠 failCount 判死，
 *     冷却到期自动回池，探针继续复检，支持自愈。
 *   - unknown（无法确认原因）：不计入失败次数，不判死，只刷新探针记录并尽快复检。
 *
 * @module pool/transitions
 */
import { HEALTH, VERDICT } from './types.js'
import { classifyQuotaCause } from '../probe/classify.js'

/** 结构性判决：一次即死，永久屏蔽，不复检（由协调层/人工决定是否重试）。 */
const STRUCTURAL_VERDICTS = new Set([VERDICT.auth, VERDICT.regionBlocked, VERDICT.retired])

/** 瞬时判决：网络/配额/服务端短暂故障，绝不靠 failCount 判死。 */
const TRANSIENT_VERDICTS = new Set([
  VERDICT.throttled,
  VERDICT.timeout,
  VERDICT.unavailable,
  VERDICT.empty
])

/**
 * 指数冷却：base * 2^(failCount-1)，封顶 maxMs。
 * @param {number} failCount - 已含本次失败的次数（>=1）
 * @param {{ baseMs: number, maxMs: number }} cfg
 * @returns {number} 冷却毫秒数
 */
export function cooldownFor(failCount, cfg) {
  const exponent = Math.max(0, Math.min(failCount - 1, 20))
  return Math.min(cfg.maxMs, cfg.baseMs * 2 ** exponent)
}

/**
 * 额度类失败的冷却：按**成因**分档，不是一个固定值。
 *
 * 三档语义差别很大，混在一起必然有一头是错的：
 *   - 余额为 0 / 402：只能等充值。用 `cooldown.quotaMs`（默认 6h），
 *     否则每 30 分钟把一个必然 402 的通道捞出来重试，failCount 顶到几百。
 *   - 单窗口限流（tpm/rpm/单日次数）：几十秒到几分钟就回来。用
 *     `cooldown.quotaRateMs`（默认 5min），用 6h 等于把好通道判死。
 *   - 免费额度到期：知道到期时刻就按那一刻算（`expiresAt`），不知道用
 *     `cooldown.quotaExpiredMs`（默认 30min）—— 额度恢复往往由服务端按周期发放，
 *     长冷却只会让用户以为插件坏了。
 *
 * `quotaMs` 键名与默认值保持不变（0.3.1 的配置继续生效）。
 *
 * @param {{ maxMs: number, quotaMs?: number, quotaRateMs?: number, quotaExpiredMs?: number }} cfg
 * @param {import('../probe/classify.js').QUOTA_CAUSE[keyof typeof import('../probe/classify.js').QUOTA_CAUSE]} [cause]
 * @param {{ now?: number, expiresAt?: number }} [context]
 * @returns {number} 毫秒
 */
export function quotaCooldown(cfg, cause = 'balance', context = {}) {
  const now = typeof context.now === 'number' ? context.now : Date.now()
  const expiresAt = typeof context.expiresAt === 'number' && context.expiresAt > 0 ? context.expiresAt : 0
  const balanceMs = Math.max(cfg.maxMs, typeof cfg.quotaMs === 'number' && cfg.quotaMs > 0 ? cfg.quotaMs : 6 * 60 * 60_000)
  const rateMs = positive(cfg.quotaRateMs, 5 * 60_000)
  const expiredMs = positive(cfg.quotaExpiredMs, 30 * 60_000)

  /** @type {number} */
  let picked
  if (cause === 'rate') picked = rateMs
  else if (cause === 'expired') {
    // 已知到期时刻且还在将来：睡到那一刻；否则按短冷却，交给探针复检。
    picked = expiresAt > now ? Math.min(balanceMs, expiresAt - now) : expiredMs
  } else picked = balanceMs

  // 夹到 [60s, 24h]：比 1 分钟更短会让冷却形同虚设，比 24h 更长会让「充值后
  // 提前恢复」的入口成为唯一出路。
  return Math.min(24 * 60 * 60_000, Math.max(60_000, Math.round(picked)))
}

/** @param {unknown} value @param {number} fallback */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 免费通道的生命周期状态。
 *
 * 建模的动机：通道不是布尔值。用户的真实问题是「这个还能白用吗、什么时候到期、
 * 到期后要不要我续」，一个 free/paid 二值回答不了。五个状态对应五个不同动作：
 * 未注册（去注册）/ 待验证（等探针）/ 可用（消耗它）/ 即将到期（提醒续期）/
 * 已过期（别再选它）。
 *
 * @readonly
 */
export const CHANNEL_LIFECYCLE = Object.freeze({
  unregistered: 'unregistered',
  pending: 'pending',
  usable: 'usable',
  expiring: 'expiring',
  expired: 'expired'
})

/** 生命周期的合法推进方向：只能沿着这条链前进，除非显式续期（见 lifecycleTransition）。 */
const LIFECYCLE_ORDER = Object.freeze({
  [CHANNEL_LIFECYCLE.unregistered]: 0,
  [CHANNEL_LIFECYCLE.pending]: 1,
  [CHANNEL_LIFECYCLE.usable]: 2,
  [CHANNEL_LIFECYCLE.expiring]: 3,
  [CHANNEL_LIFECYCLE.expired]: 4
})

/**
 * 从「事实」推出当前生命周期状态（纯函数）。
 *
 * @param {{ registered?: boolean, verified?: boolean, usable?: boolean, expiresAt?: number }} facts
 * @param {{ now?: number, leadMs?: number }} [options] - leadMs = 提前多久算「即将到期」，默认 5 小时
 * @returns {keyof typeof CHANNEL_LIFECYCLE}
 */
export function channelLifecycle(facts = {}, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const leadMs = positive(options.leadMs, 5 * 60 * 60_000)
  if (facts.registered !== true) return CHANNEL_LIFECYCLE.unregistered
  const expiresAt = typeof facts.expiresAt === 'number' ? facts.expiresAt : 0
  if (expiresAt > 0 && expiresAt <= now) return CHANNEL_LIFECYCLE.expired
  if (facts.verified !== true) return CHANNEL_LIFECYCLE.pending
  if (expiresAt > 0 && expiresAt - now <= leadMs) return CHANNEL_LIFECYCLE.expiring
  if (facts.usable === false) return CHANNEL_LIFECYCLE.pending
  return CHANNEL_LIFECYCLE.usable
}

/**
 * 状态迁移：回答「从 from 走到 to 合不合法、该记录什么」。
 *
 * 唯一允许的后退是**续期/充值**（`renewal: true`）：它可以让 expired/expiring/
 * pending 回到 usable。除此之外只允许沿链前进一格或原地不动 —— 这条约束防止
 * 一次探测抖动把「已过期」误改回「可用」，用户会以为额度又活了。
 *
 * @param {string} from
 * @param {string} to
 * @param {{ renewal?: boolean }} [options]
 * @returns {{ from: string, to: string, changed: boolean, allowed: boolean, reason: string }}
 */
export function lifecycleTransition(from, to, options = {}) {
  const fromRank = LIFECYCLE_ORDER[from] ?? -1
  const toRank = LIFECYCLE_ORDER[to] ?? -1
  if (fromRank === -1 || toRank === -1) {
    return { from, to, changed: false, allowed: false, reason: 'unknown-state' }
  }
  if (from === to) return { from, to, changed: false, allowed: true, reason: 'same' }
  const renewal = options.renewal === true
  if (toRank > fromRank) return { from, to, changed: true, allowed: true, reason: 'advance' }
  // 后退只允许续期，且目标是 usable（不能一步跳回 unregistered）。
  if (renewal && to === CHANNEL_LIFECYCLE.usable) {
    return { from, to, changed: true, allowed: true, reason: 'renewal' }
  }
  return { from, to, changed: false, allowed: false, reason: 'backwards-without-renewal' }
}

/**
 * 一次判决要写回的补丁。
 *
 * 规则表：
 * | verdict        | health    | failCount | 冷却           | 屏蔽        |
 * | -------------- | --------- | --------- | -------------- | ----------- |
 * | ok             | available | 0         | 清零           | 否          |
 * | throttled      | degraded  | +1        | 指数           | 仅超阈值    |
 * | timeout        | degraded  | +1        | 指数           | 仅超阈值    |
 * | unavailable    | cooling   | +1        | 指数           | 仅超阈值    |
 * | empty          | degraded  | +1        | 指数           | 仅超阈值    |
 * | auth           | dead      | +1        | 指数（最长档） | 是（永久）  |
 * | region-blocked | dead      | +1        | 指数（最长档） | 是（永久）  |
 * | aborted        | 不变      | 不变      | 不变           | 不变        |
 * | unknown        | 不变*     | 不变      | 不变           | 否          |
 *
 * * unknown 保持原 health，仅刷新 lastProbe 并尽快复检，不计入 failCount，不参与 dead 计数。
 *
 * @param {import('./types.js').ModelEntry} entry
 * @param {import('./types.js').ProbeVerdict} verdict
 * @param {{ at: number, latencyMs?: number, detail?: string }} meta
 * @param {{ cooldown: { baseMs:number, maxMs:number, deadFailCount:number, hideAfterMs:number }, probe: { retryProbeMinMs:number, intervalMs:number } }} config
 * @returns {Partial<import('./types.js').ModelEntry>}
 */
export function transition(entry, verdict, meta, config) {
  const now = meta.at
  if (verdict === VERDICT.aborted) {
    // 探针被取消不是模型的错，什么都不改。
    return {}
  }

  // 额度类失败带上成因标签：冷却分档、面板展示、提前恢复都靠它，
  // 只留一个 verdict=quota 的话下游只能一律按「余额为 0」处理。
  const quotaCause =
    verdict === VERDICT.quota
      ? (typeof meta.cause === 'string' && meta.cause !== '' ? meta.cause : classifyQuotaCause(meta.detail ?? ''))
      : undefined

  const lastProbe = {
    at: now,
    verdict,
    ...(typeof meta.latencyMs === 'number' ? { latencyMs: meta.latencyMs } : {}),
    ...(typeof meta.detail === 'string' ? { detail: meta.detail } : {}),
    ...(quotaCause === undefined ? {} : { cause: quotaCause }),
    ...(typeof meta.grade === 'string' ? { grade: meta.grade } : {})
  }

  /** 探针分级（healthy/slow/fake-ok/failed），调度排序与面板都用它。 */
  const gradePatch = typeof meta.grade === 'string' ? { probeGrade: meta.grade } : {}

  if (verdict === VERDICT.ok) {
    return {
      health: HEALTH.available,
      failCount: 0,
      cooldownUntil: 0,
      halfOpen: false,
      hiddenFromPicker: false,
      lastProbe,
      ...gradePatch,
      ...(quotaCause === undefined ? {} : { quotaCause }),
      nextProbeAt: now + config.probe.intervalMs
    }
  }

  // unknown：无法确认失败原因，不计入失败次数，不判死，只刷新记录并尽快复检。
  if (verdict === VERDICT.unknown) {
    return {
      ...(entry.health !== HEALTH.available ? { health: HEALTH.degraded } : {}),
      failCount: entry.failCount,
      cooldownUntil: entry.cooldownUntil,
      halfOpen: false,
      hiddenFromPicker: entry.hiddenFromPicker,
      lastProbe,
      nextProbeAt: now + Math.max(config.probe.retryProbeMinMs, 5_000)
    }
  }

  const structural = STRUCTURAL_VERDICTS.has(verdict)
  const failCount = entry.failCount + 1
  // 额度耗尽走独立的长冷却：见 quotaCooldown 的注释。
  const cooldown =
    verdict === VERDICT.quota
      ? quotaCooldown(config.cooldown, quotaCause ?? 'unknown', {
          now,
          expiresAt: typeof meta.expiresAt === 'number' ? meta.expiresAt : 0
        })
      : cooldownFor(failCount, config.cooldown)

  // 瞬时判决永不靠次数判死；只有结构性判决才立即 dead。
  /** @type {import('./types.js').EntryHealth} */
  const health = structural
    ? HEALTH.dead
    : verdict === VERDICT.unavailable
      ? HEALTH.cooling
      : HEALTH.degraded

  // 结构性 dead 永久屏蔽；其它瞬时失效只在冷却超过阈值时屏蔽，避免抖动隐藏模型。
  const hide = structural || cooldown >= config.cooldown.hideAfterMs

  return {
    health,
    failCount,
    cooldownUntil: now + cooldown,
    halfOpen: false,
    hiddenFromPicker: hide || entry.hiddenFromPicker,
    lastProbe,
    nextProbeAt: now + Math.max(config.probe.retryProbeMinMs, Math.min(cooldown, config.probe.intervalMs))
  }
}

/**
 * 真实调用成功后清零：比探针更强的一手证据。
 * @param {import('./types.js').ModelEntry} entry
 * @param {number} at
 * @param {{ probe: { intervalMs: number } }} config
 * @returns {Partial<import('./types.js').ModelEntry>}
 */
export function transitionSuccess(entry, at, config) {
  return {
    health: HEALTH.available,
    failCount: 0,
    cooldownUntil: 0,
    halfOpen: false,
    hiddenFromPicker: false,
    nextProbeAt: at + config.probe.intervalMs,
    lastProbe: entry.lastProbe
  }
}

/**
 * 真实调用失败（非探针）时的降级。分类由 probe/classify.js 给出。
 * @param {import('./types.js').ModelEntry} entry
 * @param {import('./types.js').ProbeVerdict} verdict
 * @param {number} at
 * @param {{ cooldown: { baseMs:number, maxMs:number, deadFailCount:number, hideAfterMs:number }, probe: { retryProbeMinMs:number, intervalMs:number } }} config
 * @param {{ cause?: string, detail?: string, expiresAt?: number }} [meta] - 额度成因（真实调用路径也有原文可认）
 * @returns {Partial<import('./types.js').ModelEntry>}
 */
export function transitionFailure(entry, verdict, at, config, meta = {}) {
  const structural = STRUCTURAL_VERDICTS.has(verdict)
  // unknown 在真实调用路径中极罕见；出现时也不计入失败次数、不判死。
  if (verdict === VERDICT.unknown) {
    return {
      ...(entry.health !== HEALTH.available ? { health: HEALTH.degraded } : {}),
      failCount: entry.failCount,
      cooldownUntil: entry.cooldownUntil,
      halfOpen: false,
      hiddenFromPicker: entry.hiddenFromPicker,
      lastProbe: { at, verdict: VERDICT.unknown },
      nextProbeAt: at + Math.max(config.probe.retryProbeMinMs, 5_000)
    }
  }
  const failCount = entry.failCount + 1
  const cause =
    verdict === VERDICT.quota
      ? (typeof meta.cause === 'string' && meta.cause !== '' ? meta.cause : classifyQuotaCause(meta.detail ?? ''))
      : undefined
  const cooldown =
    verdict === VERDICT.quota
      ? quotaCooldown(config.cooldown, cause ?? 'unknown', {
          now: at,
          expiresAt: typeof meta.expiresAt === 'number' ? meta.expiresAt : 0
        })
      : cooldownFor(failCount, config.cooldown)
  const health = structural ? HEALTH.dead : HEALTH.cooling
  const hide = structural || cooldown >= config.cooldown.hideAfterMs
  return {
    health,
    failCount,
    cooldownUntil: at + cooldown,
    halfOpen: false,
    hiddenFromPicker: hide || entry.hiddenFromPicker,
    lastProbe: {
      at,
      verdict,
      ...(typeof meta.detail === 'string' ? { detail: meta.detail } : {}),
      ...(cause === undefined ? {} : { cause })
    },
    ...(cause === undefined ? {} : { quotaCause: cause }),
    nextProbeAt: at + Math.max(config.probe.retryProbeMinMs, Math.min(cooldown, config.probe.intervalMs))
  }
}

/**
 * 是否应当从模型选择界面屏蔽：只屏蔽“暂时失效且会持续一会儿”的条目。
 * 结构性失效（dead）一定屏蔽；冷却中的条目要超过 hideAfterMs 才屏蔽。
 * @param {import('./types.js').ModelEntry} entry
 * @param {number} now
 * @param {{ cooldown: { hideAfterMs: number } }} config
 * @returns {boolean}
 */
export function shouldHide(entry, now, config) {
  if (entry.health === HEALTH.dead) return true
  if (entry.cooldownUntil <= now) return false
  return entry.cooldownUntil - now > config.cooldown.hideAfterMs
}
