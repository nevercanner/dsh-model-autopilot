/**
 * 选型规则测试：免费优先是硬规则，不能被分数盖过。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler } from '../src/schedule/scheduler.js'
import { normalizeConfig } from '../src/config.js'
import { scoreEntry, compareEntries } from '../src/schedule/scoring.js'

const logger = { info() {}, warn() {} }

/** @param {Partial<any>} patch */
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
    health: 'available',
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

function makeScheduler(entries, cfg = {}) {
  const config = normalizeConfig(cfg)
  return createScheduler({ pool: { all: () => entries }, config, logger })
}

test('免费永远先于付费：即使付费优先级高得多', () => {
  const scheduler = makeScheduler([
    entry({ key: 'paid/best', cost: 'paid', priority: 9_999, health: 'available' }),
    entry({ key: 'free/weak', cost: 'free', priority: 0, health: 'degraded', failCount: 3 })
  ])
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'free/weak')
  assert.equal(plan.reason, 'free:preferred')
  assert.deepEqual(plan.fallbacks.map((item) => item.key), ['paid/best'])
})

test('免费全部冷却时才回落到付费，并留下可诊断的 reason', () => {
  const scheduler = makeScheduler([
    entry({ key: 'free/a', cost: 'free', cooldownUntil: 9_000 }),
    entry({ key: 'free/b', cost: 'free', health: 'dead' }),
    entry({ key: 'paid/x', cost: 'paid', priority: 10 })
  ])
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'paid/x')
  assert.equal(plan.reason, 'free:none→paid')
})

test('全池冷却时捞回最早解冻的免费条目试一次，而不是 0 次尝试直接失败', () => {
  // 报障现场：28 个冷却中 + 5 个付费被 allowPaid 挡住 → 一轮请求一次都没打就失败。
  const scheduler = makeScheduler([
    entry({ key: 'free/a', cost: 'free', cooldownUntil: 9_000 }),
    entry({ key: 'paid/x', cost: 'paid' })
  ])
  const plan = scheduler.plan({ now: 1_000, allowPaid: false })
  assert.equal(plan.primary.key, 'free/a')
  assert.equal(plan.reason, 'free:cooling-last-resort')
})

test('coolingFallback=false 时恢复旧行为：没有候选就是没有候选', () => {
  const scheduler = makeScheduler(
    [
      entry({ key: 'free/a', cost: 'free', cooldownUntil: 9_000 }),
      entry({ key: 'paid/x', cost: 'paid' })
    ],
    { schedule: { coolingFallback: false } }
  )
  const plan = scheduler.plan({ now: 1_000, allowPaid: false })
  assert.equal(plan.primary, null)
  assert.equal(plan.reason, 'no-candidate:free-only')
})

test('冷却候选里有可用的付费条目不抢免费（免费优先仍然成立）', () => {
  const scheduler = makeScheduler([
    entry({ key: 'free/a', cost: 'free', cooldownUntil: 9_000 }),
    entry({ key: 'paid/x', cost: 'paid', priority: 99 })
  ])
  const plan = scheduler.plan({ now: 1_000, allowPaid: true })
  assert.equal(plan.primary.key, 'paid/x')
  assert.equal(plan.reason, 'free:none→paid')
})

test('dead 与冷却中的条目被排除，并给出原因', () => {
  const scheduler = makeScheduler([
    entry({ key: 'free/dead', cost: 'free', health: 'dead' }),
    entry({ key: 'free/cool', cost: 'free', cooldownUntil: 5_000 }),
    entry({ key: 'free/ok', cost: 'free' })
  ])
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'free/ok')
  const reasons = Object.fromEntries(plan.rejected.map((item) => [item.key, item.reason]))
  assert.equal(reasons['free/dead'], 'dead')
  assert.match(reasons['free/cool'], /冷却/)
})

test('exclude 命中本轮已失败的模型', () => {
  const scheduler = makeScheduler([
    entry({ key: 'free/a', cost: 'free', priority: 100 }),
    entry({ key: 'free/b', cost: 'free', priority: 1 })
  ])
  const plan = scheduler.plan({ now: 1_000, exclude: ['free/a'] })
  assert.equal(plan.primary.key, 'free/b')
})

test('能力过滤：明确不够的被排除，未声明的放行', () => {
  const scheduler = makeScheduler([
    entry({ key: 'free/small', cost: 'free', contextWindow: 8_000 }),
    entry({ key: 'free/unknown', cost: 'free', contextWindow: 0 }),
    entry({ key: 'free/image', cost: 'free', inputModalities: ['text', 'image'], priority: 50 }),
    entry({ key: 'free/text', cost: 'free', inputModalities: ['text'] })
  ])

  const byContext = scheduler.plan({ now: 1_000, requirement: { minContextWindow: 64_000 } })
  assert.ok(!byContext.candidates.some((item) => item.key === 'free/small'))
  assert.ok(byContext.candidates.some((item) => item.key === 'free/unknown'), '未知上下文不该被排除')

  const byImage = scheduler.plan({ now: 1_000, requirement: { input: ['image'] } })
  assert.deepEqual(byImage.candidates.map((item) => item.key), ['free/image'])

  const byReasoning = scheduler.plan({ now: 1_000, requirement: { reasoning: true } })
  assert.equal(byReasoning.primary, null)
})

test('同成本组内：健康的排在 degraded 前，失败多的往后', () => {
  const config = normalizeConfig({})
  const now = 1_000
  const context = { now, config }
  const healthy = entry({ key: 'free/healthy', cost: 'free', health: 'available' })
  const degraded = entry({ key: 'free/degraded', cost: 'free', health: 'degraded', failCount: 1 })
  const flaky = entry({ key: 'free/flaky', cost: 'free', health: 'available', failCount: 5 })

  assert.ok(scoreEntry(healthy, context) > scoreEntry(degraded, context))
  assert.ok(scoreEntry(healthy, context) > scoreEntry(flaky, context))
  assert.ok(compareEntries(healthy, degraded, context) < 0)
})

test('explain 输出可读的排序与冷却剩余', () => {
  const scheduler = makeScheduler([
    entry({ key: 'free/a', cost: 'free' }),
    entry({ key: 'free/cool', cost: 'free', cooldownUntil: 3_000 })
  ])
  const rows = scheduler.explain({ now: 1_000 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, 'free/a')
  assert.equal(typeof rows[0].score, 'number')
})

// ── provider 置顶（minimax-cn）───────────────────────────────────────────────

test('付费组内置顶：minimax-cn 压过优先级更高的其他付费 provider', () => {
  const scheduler = makeScheduler([
    entry({ key: 'magpie/paid-best', provider: 'magpie', cost: 'paid', priority: 9_999 }),
    entry({ key: 'minimax-cn/m1', provider: 'minimax-cn', cost: 'paid', priority: 0 })
  ])
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'minimax-cn/m1')
  assert.equal(plan.reason, 'free:none→paid')
  assert.deepEqual(plan.fallbacks.map((item) => item.key), ['magpie/paid-best'])
})

test('免费优先是硬规则：有可用免费时 minimax-cn 不会越过它', () => {
  const scheduler = makeScheduler([
    entry({ key: 'our-free-model/free', provider: 'our-free-model', cost: 'free', priority: 0 }),
    entry({ key: 'minimax-cn/m1', provider: 'minimax-cn', cost: 'paid', priority: 9_999 })
  ])
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'our-free-model/free')
  assert.equal(plan.reason, 'free:preferred')
})

test('minimax-cn 冷却/熔断时自动落到下一个候选', () => {
  const scheduler = makeScheduler([
    entry({ key: 'minimax-cn/m1', provider: 'minimax-cn', cost: 'paid', cooldownUntil: 9_000 }),
    entry({ key: 'minimax-cn/m2', provider: 'minimax-cn', cost: 'paid', health: 'dead' }),
    entry({ key: 'magpie/paid-x', provider: 'magpie', cost: 'paid' })
  ])
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'magpie/paid-x')
})

test('providerOrder 可配置：传 [] 时不再置顶', () => {
  const scheduler = makeScheduler(
    [
      entry({ key: 'magpie/paid-best', provider: 'magpie', cost: 'paid', priority: 9_999 }),
      entry({ key: 'minimax-cn/m1', provider: 'minimax-cn', cost: 'paid', priority: 0 })
    ],
    { schedule: { providerOrder: [] } }
  )
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'magpie/paid-best', '不置顶时按 priority 排')
})

// ── 首选 provider（锁定）─────────────────────────────────────────────────────

/** @param {string | null} provider @param {string | null} [model] */
function fakePreference(provider, model = null) {
  return {
    isPinned: () => provider !== null,
    get: () => ({ provider, model })
  }
}

/**
 * @param {any[]} entries
 * @param {string | null} provider
 */
function makeSchedulerWithPreference(entries, provider, model = null) {
  const config = normalizeConfig({})
  return createScheduler({
    pool: { all: () => entries },
    config,
    logger,
    preference: fakePreference(provider, model)
  })
}

test('首选 provider 压过免费优先（充值通道要先用）', () => {
  const scheduler = makeSchedulerWithPreference(
    [
      entry({ key: 'our-free-model/free', provider: 'our-free-model', cost: 'free', priority: 9_999 }),
      entry({ key: 'minimax-cn/MiniMax-M3', provider: 'minimax-cn', cost: 'paid', priority: 0 })
    ],
    'minimax-cn'
  )
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'minimax-cn/MiniMax-M3')
  assert.equal(plan.reason, 'pinned:minimax-cn')
  // 让位顺序恢复免费优先：免费模型排在其它付费之前
  assert.deepEqual(plan.fallbacks.map((item) => item.key), ['our-free-model/free'])
})

test('首选 provider 失效（冷却）时自动让位给免费模型', () => {
  const scheduler = makeSchedulerWithPreference(
    [
      entry({ key: 'our-free-model/free', provider: 'our-free-model', cost: 'free' }),
      entry({ key: 'minimax-cn/MiniMax-M3', provider: 'minimax-cn', cost: 'paid', cooldownUntil: 9_000 })
    ],
    'minimax-cn'
  )
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'our-free-model/free')
  assert.match(plan.reason, /^free:/, '让位后回到免费分支')
})

test('首选被跳过时给出原因（能回答「为什么锁定���没被选中」）', () => {
  const scheduler = makeSchedulerWithPreference(
    [
      entry({ key: 'our-free-model/free', provider: 'our-free-model', cost: 'free' }),
      entry({ key: 'gemini/gemini-3.8-flash', provider: 'gemini', cost: 'paid', health: 'dead' })
    ],
    'gemini'
  )
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'our-free-model/free')
  assert.ok(plan.pinnedSkipped, '必须带上首选被跳过的说明')
  assert.equal(plan.pinnedSkipped.provider, 'gemini')
  assert.match(plan.pinnedSkipped.reason, /gemini\/gemini-3\.8-flash/)
  assert.match(plan.pinnedSkipped.reason, /dead/)
})

test('首选 provider 熔断（dead）时同样让位', () => {
  const scheduler = makeSchedulerWithPreference(
    [
      entry({ key: 'our-free-model/free', provider: 'our-free-model', cost: 'free' }),
      entry({ key: 'minimax-cn/MiniMax-M3', provider: 'minimax-cn', cost: 'paid', health: 'dead' })
    ],
    'minimax-cn'
  )
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'our-free-model/free')
})

test('首选可精确到模型：同 provider 下只认被指定的那个', () => {
  const scheduler = makeSchedulerWithPreference(
    [
      entry({ key: 'minimax-cn/MiniMax-M2.7', model: 'MiniMax-M2.7', provider: 'minimax-cn', cost: 'paid' }),
      entry({ key: 'minimax-cn/MiniMax-M3', model: 'MiniMax-M3', provider: 'minimax-cn', cost: 'paid' })
    ],
    'minimax-cn',
    'MiniMax-M3'
  )
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'minimax-cn/MiniMax-M3')
  assert.equal(plan.primary.model, 'MiniMax-M3')
})

test('未锁定时行为不变（免费优先）', () => {
  const scheduler = makeSchedulerWithPreference(
    [
      entry({ key: 'our-free-model/free', provider: 'our-free-model', cost: 'free' }),
      entry({ key: 'minimax-cn/MiniMax-M3', provider: 'minimax-cn', cost: 'paid' })
    ],
    null
  )
  const plan = scheduler.plan({ now: 1_000 })
  assert.equal(plan.primary.key, 'our-free-model/free')
})

test('explain 与 plan 口径一致：锁定项在两边都是第一', () => {
  const scheduler = makeSchedulerWithPreference(
    [
      entry({ key: 'our-free-model/free', provider: 'our-free-model', cost: 'free', priority: 9_999 }),
      entry({ key: 'minimax-cn/MiniMax-M2.7', model: 'MiniMax-M2.7', provider: 'minimax-cn', cost: 'paid' }),
      entry({ key: 'minimax-cn/MiniMax-M3', model: 'MiniMax-M3', provider: 'minimax-cn', cost: 'paid' })
    ],
    'minimax-cn',
    'MiniMax-M3'
  )
  const plan = scheduler.plan({ now: 1_000 })
  const rows = scheduler.explain({ now: 1_000 })
  assert.equal(plan.primary.key, 'minimax-cn/MiniMax-M3')
  assert.equal(rows[0].key, 'minimax-cn/MiniMax-M3', '面板显示的顺序必须等于实际选型顺序')
  assert.equal(rows[0].pinned, true)
  assert.equal(rows[1].key, 'our-free-model/free', '让位顺序是免费优先')
})
