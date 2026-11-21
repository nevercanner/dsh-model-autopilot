/**
 * 探针判决与状态迁移的规则表测试。
 * 运行：npm test
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { cooldownFor, transition, transitionSuccess, shouldHide } from '../src/pool/transitions.js'
import { HEALTH, VERDICT } from '../src/pool/types.js'

const CONFIG = {
  cooldown: { baseMs: 1000, maxMs: 60_000, deadFailCount: 3, hideAfterMs: 5_000 },
  probe: { retryProbeMinMs: 100, intervalMs: 10_000 }
}

/** @param {Partial<any>} [patch] */
function entry(patch = {}) {
  return {
    key: 'p/m',
    provider: 'p',
    model: 'm',
    name: 'm',
    cost: 'paid',
    priority: 0,
    contextWindow: 0,
    inputModalities: ['text'],
    reasoning: false,
    health: HEALTH.unknown,
    failCount: 0,
    cooldownUntil: 0,
    nextProbeAt: 0,
    halfOpen: false,
    hiddenFromPicker: false,
    lastProbe: null,
    providerError: null,
    ...patch
  }
}

test('冷却按 2 的幂增长并封顶', () => {
  assert.equal(cooldownFor(1, CONFIG.cooldown), 1000)
  assert.equal(cooldownFor(2, CONFIG.cooldown), 2000)
  assert.equal(cooldownFor(3, CONFIG.cooldown), 4000)
  assert.equal(cooldownFor(20, CONFIG.cooldown), 60_000)
})

test('ok 清零失败计数、冷却与屏蔽', () => {
  const patch = transition(
    entry({ health: HEALTH.dead, failCount: 5, cooldownUntil: 999_999, hiddenFromPicker: true }),
    VERDICT.ok,
    { at: 1_000, latencyMs: 12 },
    CONFIG
  )
  assert.equal(patch.health, HEALTH.available)
  assert.equal(patch.failCount, 0)
  assert.equal(patch.cooldownUntil, 0)
  assert.equal(patch.hiddenFromPicker, false)
  assert.equal(patch.lastProbe.verdict, 'ok')
  assert.equal(patch.nextProbeAt, 1_000 + CONFIG.probe.intervalMs)
})

test('aborted 不改变任何状态（探针被取消不是模型的错）', () => {
  const before = entry({ health: HEALTH.degraded, failCount: 2, cooldownUntil: 5 })
  assert.deepEqual(transition(before, VERDICT.aborted, { at: 1 }, CONFIG), {})
})

test('throttled 降级并进入短冷却，不屏蔽', () => {
  const patch = transition(entry(), VERDICT.throttled, { at: 1_000 }, CONFIG)
  assert.equal(patch.health, HEALTH.degraded)
  assert.equal(patch.failCount, 1)
  assert.equal(patch.cooldownUntil, 2_000)
  assert.equal(patch.hiddenFromPicker, false)
})

test('auth 直接判 dead 并立刻屏蔽', () => {
  const patch = transition(entry(), VERDICT.auth, { at: 1_000 }, CONFIG)
  assert.equal(patch.health, HEALTH.dead)
  assert.equal(patch.hiddenFromPicker, true)
})

test('region-blocked 同样立刻屏蔽', () => {
  const patch = transition(entry(), VERDICT.regionBlocked, { at: 1_000 }, CONFIG)
  assert.equal(patch.health, HEALTH.dead)
  assert.equal(patch.hiddenFromPicker, true)
})

test('瞬时故障不因次数判死：timeout 连续失败仍为 degraded', () => {
  const patch = transition(entry({ failCount: 2 }), VERDICT.timeout, { at: 1_000 }, CONFIG)
  assert.equal(patch.failCount, 3)
  assert.equal(patch.health, HEALTH.degraded)
  assert.equal(patch.hiddenFromPicker, false)
})

test('结构性失败一次即 dead 并立刻屏蔽', () => {
  const patch = transition(entry({ failCount: 0 }), VERDICT.auth, { at: 1_000 }, CONFIG)
  assert.equal(patch.failCount, 1)
  assert.equal(patch.health, HEALTH.dead)
  assert.equal(patch.hiddenFromPicker, true)
})

test('unknown 不计入失败次数、不判死、尽快复检', () => {
  const patch = transition(entry({ failCount: 5, health: HEALTH.dead }), VERDICT.unknown, { at: 1_000 }, CONFIG)
  assert.equal(patch.failCount, 5)
  assert.equal(patch.health, HEALTH.degraded)
  assert.equal(patch.hiddenFromPicker, false)
  assert.equal(patch.lastProbe.verdict, 'unknown')
  assert.ok(patch.nextProbeAt >= 1_000 + CONFIG.probe.retryProbeMinMs)
})

test('冷却超过 hideAfterMs 才屏蔽；瞬时故障冷却到期后不屏蔽', () => {
  // failCount=1 → 冷却 1000ms < hideAfterMs(5000) → 不屏蔽
  assert.equal(transition(entry(), VERDICT.unavailable, { at: 1_000 }, CONFIG).hiddenFromPicker, false)
  // failCount=3 → 冷却 4000ms < 5000 → cooling，不屏蔽
  const third = transition(entry({ failCount: 2 }), VERDICT.unavailable, { at: 1_000 }, CONFIG)
  assert.equal(third.health, HEALTH.cooling)
  assert.equal(third.hiddenFromPicker, false)
  // 冷却已到期 → 直接不屏蔽
  assert.equal(shouldHide(entry({ health: HEALTH.cooling, cooldownUntil: 100 }), 10_000, CONFIG), false)
  // 冷却中且剩余冷却超过 hideAfterMs → 屏蔽
  assert.equal(shouldHide(entry({ health: HEALTH.cooling, cooldownUntil: 10_000 + 6_000 }), 10_000, CONFIG), true)
})

test('真实调用成功同样清零，并保留 lastProbe', () => {
  const lastProbe = { at: 5, verdict: 'throttled' }
  const patch = transitionSuccess(entry({ failCount: 4, lastProbe }), 2_000, CONFIG)
  assert.equal(patch.health, HEALTH.available)
  assert.equal(patch.failCount, 0)
  assert.equal(patch.lastProbe, lastProbe)
})

test('shouldHide 只看结构性失效与超阈值冷却', () => {
  const now = 10_000
  assert.equal(shouldHide(entry({ health: HEALTH.dead }), now, CONFIG), true)
  assert.equal(shouldHide(entry({ health: HEALTH.degraded }), now, CONFIG), false)
  assert.equal(shouldHide(entry({ cooldownUntil: now + 1000 }), now, CONFIG), false)
  assert.equal(shouldHide(entry({ cooldownUntil: now + 6000 }), now, CONFIG), true)
  assert.equal(shouldHide(entry({ cooldownUntil: now - 1 }), now, CONFIG), false)
})
