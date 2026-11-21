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

  const lastProbe = {
    at: now,
    verdict,
    ...(typeof meta.latencyMs === 'number' ? { latencyMs: meta.latencyMs } : {}),
    ...(typeof meta.detail === 'string' ? { detail: meta.detail } : {})
  }

  if (verdict === VERDICT.ok) {
    return {
      health: HEALTH.available,
      failCount: 0,
      cooldownUntil: 0,
      halfOpen: false,
      hiddenFromPicker: false,
      lastProbe,
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
  const cooldown = cooldownFor(failCount, config.cooldown)

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
 * @returns {Partial<import('./types.js').ModelEntry>}
 */
export function transitionFailure(entry, verdict, at, config) {
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
  const cooldown = cooldownFor(failCount, config.cooldown)
  const health = structural ? HEALTH.dead : HEALTH.cooling
  const hide = structural || cooldown >= config.cooldown.hideAfterMs
  return {
    health,
    failCount,
    cooldownUntil: at + cooldown,
    halfOpen: false,
    hiddenFromPicker: hide || entry.hiddenFromPicker,
    lastProbe: { at, verdict },
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
