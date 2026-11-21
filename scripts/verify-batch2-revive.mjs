/**
 * 批次 2 验收：造一个 failCount=26、health=dead 的 throttled 条目，
 * 跑一轮探针，确认它能被重新探到并降回 cooling。
 *
 * 背景：旧版 transitions 靠 failCount 判死，一条通道额度用完后会被永久打上
 * dead，之后再也不会被探测，等于「烧掉的额度永远不回来了」。批次 1 改成
 * 「瞬时失效永不靠次数判死」，这个脚本验证它在真实调度里确实生效。
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createProber } from '../src/probe/prober.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} }

const MODELS = ['revivable', 'healthy']
const llm = {
  listProviders: () => [{ id: 'our-free-model', name: 'free' }],
  listModels: async () => MODELS.map((id) => ({ provider: 'our-free-model', id, name: id })),
  resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
  stream() {
    return (async function* () {
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

// 预置：revivable 是 failCount=26 / dead 的旧数据（旧版靠次数判死留下的）
const store = {
  models: {
    'our-free-model/revivable': {
      health: 'dead',
      failCount: 26,
      cooldownUntil: Date.now() + 3600_000,
      nextProbeAt: 0,
      hiddenFromPicker: true,
      lastProbe: { at: Date.now() - 7200_000, verdict: 'throttled', latencyMs: 100 }
    },
    'our-free-model/healthy': {
      health: 'available',
      failCount: 0,
      cooldownUntil: 0,
      nextProbeAt: 0,
      hiddenFromPicker: false,
      lastProbe: { at: Date.now() - 7200_000, verdict: 'ok', latencyMs: 90 }
    }
  },
  model: (k) => store.models[k],
  setModel: (k, v) => {
    store.models[k] = v
  },
  setMeta() {},
  get: () => ({ models: store.models }),
  flushSync() {},
  dispose() {}
}

const config = normalizeConfig({})
const pool = createPool({ ctx: { llm }, config, store, logger })
await pool.reload()

const before = pool.get('our-free-model/revivable')
console.log('=== 探测前 ===')
console.log('  health      =', before.health)
console.log('  failCount   =', before.failCount)
console.log('  hidden      =', pool.shouldHide(before, undefined, Date.now()))
console.log('  nextProbeAt =', before.nextProbeAt, '(0 = 到期可探)')

// 确认它确实进了本轮候选
const prober = createProber({ ctx: { llm }, pool, config, logger })
const due = prober.selectDue(Date.now())
const inRound = due.some((e) => e.key === 'our-free-model/revivable')
console.log('  进入本轮探针候选 =', inRound)

// 跑一轮（上游此时返回 ok，模拟额度恢复）
await prober.round('batch2-test')

const after = pool.get('our-free-model/revivable')
console.log()
console.log('=== 探测后（上游已恢复 ok）===')
console.log('  health      =', after.health)
console.log('  failCount   =', after.failCount)
console.log('  hidden      =', pool.shouldHide(after, undefined, Date.now()))
console.log('  lastProbe   =', JSON.stringify(after.lastProbe))

const pass = after.health === 'available' && after.hiddenFromPicker === false
console.log()
console.log(pass ? 'PASS(1)：failCount=26 的旧死条目已被重新探到并复活' : 'FAIL(1)')

// ── 对照：上游仍然限流时，必须降回 cooling（等冷却后再探），不能继续 dead ──
const llm2 = {
  ...llm,
  stream() {
    return (async function* () {
      const error = Object.assign(new Error('所有账号均不可用（限流或额度耗尽）'), { code: 'RATE_LIMIT' })
      throw error
    })()
  }
}
const store2 = {
  models: {
    'our-free-model/revivable': {
      health: 'dead',
      failCount: 26,
      cooldownUntil: Date.now() + 3600_000,
      nextProbeAt: 0,
      hiddenFromPicker: true,
      lastProbe: { at: Date.now() - 7200_000, verdict: 'throttled', latencyMs: 100 }
    }
  },
  model: (k) => store2.models[k],
  setModel: (k, v) => {
    store2.models[k] = v
  },
  setMeta() {},
  get: () => ({ models: store2.models }),
  flushSync() {},
  dispose() {}
}
const llmOnly = { ...llm2, listModels: async () => [{ provider: 'our-free-model', id: 'revivable', name: 'revivable' }] }
const pool2 = createPool({ ctx: { llm: llmOnly }, config, store: store2, logger })
await pool2.reload()
const prober2 = createProber({ ctx: { llm: llmOnly }, pool: pool2, config, logger })
await prober2.round('batch2-test-still-throttled')
const throttled = pool2.get('our-free-model/revivable')
console.log()
console.log('=== 仍限流时（对照）===')
console.log('  health      =', throttled.health)
console.log('  cooldown剩  =', Math.max(0, throttled.cooldownUntil - Date.now()) + 'ms')
const pass2 = throttled.health !== 'dead'
console.log(pass2 ? 'PASS(2)：仍限流时降回冷却而非永久 dead，冷却到期可再探' : 'FAIL(2)：仍然被永久判死')
console.log()
console.log(pass && pass2 ? '批次 2 验收全部通过' : '存在失败项')
process.exit(pass && pass2 ? 0 : 1)
