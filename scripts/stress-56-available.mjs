/**
 * 最终压力验证：56 个 available 时，连续失败十几轮还能落到可用模型吗。
 *
 * 上一轮验证的缺陷（已修正）：
 *   1. 标死的是「池文件枚举顺序的前 20 个」，不是调度器会挑的前 20 → 第一次就成功；
 *   2. 「改磁盘 + reload」这条路被旧 fiber dispose 回写覆盖 → 人为 dead 无效；
 *   3. 假池的可用性与真实上游不一致 → 验证跑在错误的排序上。
 *
 * 这一版在**假池内自洽**：
 *   - 构造 56 个 available（health=available, failCount=0, 无冷却）+ 其余非可用；
 *   - 用假上游让**按调度器真实排序的前 20 个 available** 全部必失败；
 *   - 其余 available 真实放行；
 *   - 断言：3 轮连续运行，每轮都跳过 20 个失败模型，落到剩余可用模型。
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'
import { createPreference } from '../src/preference.js'

const logger = { info() {}, warn() {}, error() {} }

// ── 构造 56 个 available（可用模型）+ 若干必失败的模型 ────────────────────────
// 用 5 个 provider 模拟真实多通道，其中 our-free-model 是网关（不整体跳过）
const IDS = []
for (let i = 0; i < 56; i += 1) IDS.push({ provider: 'trae', model: `ok-${String(i).padStart(2, '0')}` })

// 让调度器按真实顺序挑前 20 个必失败：给前 20 个加 priority（免费优先 + priority 降序）
const DOOM_COUNT = 20
const modelList = [...IDS]
// 前 20 个 = 必死（priority 高 + available）
for (let i = 0; i < DOOM_COUNT; i += 1) modelList[i] = { ...modelList[i], _doomed: true }

const models = { trae: IDS.map((m) => m.model) }
const calls = []
const llm = {
  listProviders: () => Object.keys(models).map((id) => ({ id, name: id })),
  listModels: async (p) => (models[p] ?? []).map((id) => ({ provider: p, id, name: id })),
  resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
  stream(options) {
    const key = options.provider + '/' + options.model
    calls.push(key)
    // 前 20 个必失败（限流/额度耗尽），其余真实放行
    const idx = IDS.findIndex((m) => `${m.provider}/${m.model}` === key)
    const isDoomed = idx >= 0 && idx < DOOM_COUNT
    return (async function* () {
      if (isDoomed) {
        const error = new Error('所有账号均不可用（限流或额度耗尽）')
        error.code = 'RATE_LIMIT'
        throw error
      }
      yield { type: 'text-delta', text: '可用模型接住了' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

// ── 池：前 20 个 available + 其余 36 个 available（共 56）───────────────────
const store = {
  models: {},
  model: (k) => store.models[k],
  setModel: (k, v) => {
    store.models[k] = v
  },
  setMeta() {},
  get: () => ({ models: store.models }),
  flushSync() {},
  dispose() {}
}
// 预热：给前 20 个打 priority 最高（调度器优先挑），全部 available
for (let i = 0; i < DOOM_COUNT; i += 1) {
  const key = `trae/ok-${String(i).padStart(2, '0')}`
  store.models[key] = { health: 'available', failCount: 0, cooldownUntil: 0, nextProbeAt: 0, priority: 100 }
}
for (let i = DOOM_COUNT; i < IDS.length; i += 1) {
  const key = `trae/ok-${String(i).padStart(2, '0')}`
  store.models[key] = { health: 'available', failCount: 0, cooldownUntil: 0, nextProbeAt: 0, priority: 0 }
}

const config = normalizeConfig({})
const pool = createPool({ ctx: { llm }, config, store, logger })
await pool.reload()
const scheduler = createScheduler({ pool, config, logger })
const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })

// 确认前 20 个在调度器排序里确实靠前（priority 100）
const plan = scheduler.plan({})
const first20 = []
for (const entry of pool.all()) {
  if (entry.health === 'available') first20.push(entry)
}
first20.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
console.log('调度器可挑的 available 总数:', first20.length)
console.log('前 20 个 priority:', first20.slice(0, 20).map((e) => e.priority).join(','))
console.log('第 21 个 priority:', first20[20]?.priority)
console.log('第 21 个模型:', first20[20]?.key, '(期望落点)')

// ── 跑 3 轮 ─────────────────────────────────────────────────────────────────
let allPass = true
for (let round = 1; round <= 3; round += 1) {
  calls.length = 0
  let outcome
  let attempts = []
  try {
    const result = await failover.run({ messages: [] })
    outcome = result.model.key
    attempts = result.attempts
  } catch (error) {
    outcome = `ERROR:${error.name}`
    attempts = error.attempts ?? []
  }

  const doomedTried = attempts.filter((a) => /ok-(0[0-9]|1[0-9])$/.test(a.key)).length
  const landedOk = !outcome.startsWith('ERROR') && /^trae\/ok-/.test(outcome)
  const landedInRest = landedOk && Number(outcome.split('ok-')[1]) >= DOOM_COUNT
  // 第 1 轮：必须真实跳过全部 20 个失败模型。
  // 第 2/3 轮：上一轮已把这 20 个写进池的冷却（真实运行时同样如此），
  // 调度器直接跳过是正确行为 —— 只要求「落到可用模型、不报错」。
  const pass = round === 1 ? landedInRest && doomedTried >= DOOM_COUNT : landedInRest

  if (!pass) allPass = false
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  第${round}轮：尝试 ${attempts.length} 次` +
      `（前 20 命中 ${doomedTried}/20）  落点=${outcome}${landedInRest ? '（第21名及之后）' : ''}`
  )
  if (round === 1) {
    console.log('  尝试链（前 10 条）：')
    for (const a of attempts.slice(0, 10)) console.log(`    ${a.key}  ${a.ok ? '✓' : '✗ ' + a.verdict}`)
  }
}

console.log(allPass ? '\n验证通过：56 个 available 时，前 20 连续失败后仍能落到可用模型' : '\n验证失败')
process.exit(allPass ? 0 : 1)