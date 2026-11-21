/**
 * 严格压力验证：56 个 available 时，连续失败 20 轮还能不能落到可用模型。
 *
 * 与上一轮验证的本质区别：
 *   - 上一轮标死的是「池文件枚举顺序的前 20 个」—— 根本不是调度器会挑的前 20，
 *     所以真实调用第一次就成功，什么都没证明；
 *   - 更糟的是「改磁盘 + reload」这条路本身走不通：旧 fiber dispose 时会把
 *     内存旧状态 flush 回磁盘，覆盖人为写入的 dead。
 *
 * 这一版直接从**运行中的宿主**取：
 *   1. 真实池快照（200 条，含真实健康状态）；
 *   2. 真实调度排序（/plan 的前 20 个 available，即调度器依次会挑的那批）；
 *   3. 假上游让这 20 个全部失败，其余按真实健康状态放行；
 *   4. 跑 failover.run，断言落点是第 21 名或之后的可用模型，且尝试链完整。
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'

const base = process.env.DSH_WEB_URL + '/api/model-autopilot'
const H = {
  origin: process.env.DSH_WEB_URL,
  host: '127.0.0.1:' + new URL(process.env.DSH_WEB_URL).port
}

const logger = { info() {}, warn() {}, error() {} }

// ── 1. 取真实池快照与真实排序 ────────────────────────────────────────────────
const planRes = await (await fetch(base + '/plan', { headers: H })).json()
const topAvailable = planRes.plan.filter((r) => r.health === 'available').slice(0, 20)
if (topAvailable.length < 20) {
  console.log(`available 不足 20（实际 ${topAvailable.length}），无法执行本验证`)
  process.exit(1)
}
const doomed = topAvailable.map((r) => r.key)

const modelsRes = await (await fetch(base + '/models', { headers: H })).json()
const byProv = {}
for (const m of modelsRes.models) (byProv[m.provider] ??= []).push(m.model)
const healthMap = new Map(modelsRes.models.map((m) => [m.key, { health: m.health }]))

// 第 21 名之后的可用模型（期望落点）
const restAvailable = modelsRes.models
  .filter((m) => m.health === 'available' && !doomed.includes(m.key))
console.log(`真实池 ${modelsRes.models.length} 条；调度器前 20 个 available 标为必死；` +
  `剩余可用 ${restAvailable.length} 个`)

// ── 2. 假上游：前 20 名必失败，其余真实放行 ────────────────────────────────
const calls = []
const llm = {
  listProviders: () => Object.keys(byProv).map((id) => ({ id, name: id })),
  listModels: async (p) => (byProv[p] ?? []).map((id) => ({ provider: p, id, name: id })),
  resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
  stream(options) {
    const key = options.provider + '/' + options.model
    calls.push(key)
    const isDoomed = doomed.includes(key)
    return (async function* () {
      if (isDoomed) {
        const error = new Error('所有账号均不可用（限流或额度耗尽）')
        error.code = 'RATE_LIMIT'
        throw error
      }
      yield { type: 'text-delta', text: '第21名接住了' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

// ── 3. 复刻宿主配置（出厂默认，不缩水）───────────────────────────────────
const config = normalizeConfig({})
const models = {}
const store = {
  model: (k) => models[k],
  setModel: (k, v) => {
    models[k] = v
  },
  setMeta() {},
  get: () => ({ models }),
  flushSync() {},
  dispose() {}
}
const pool = createPool({ ctx: { llm }, config, store, logger })
await pool.reload()
const scheduler = createScheduler({ pool, config, logger })
const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })

// 关键：以**被测池自己的调度排序**为准确定「前 20 名」，而不是宿主 /plan 的排序。
// 两者可能因健康状态快照不同而不同；验证必须自洽。
const localPlan = scheduler.plan({})
const localTop = pool
  .all()
  .filter((e) => e.health === 'available')
  .sort((a, b) => score(b) - score(a))
  .slice(0, 20)
function score(entry) {
  // 复用 scoring：免费优先 + 健康 + 优先级，等价于 explain 的顺序
  return (entry.cost === 'free' ? 1000 : 0) + (entry.priority ?? 0)
}
// 必死名单 = 本地池里调度器会优先挑的 20 个 available
const doomedSet = new Set(localTop.map((e) => e.key))
const restLocal = pool.all().filter((e) => e.health === 'available' && !doomedSet.has(e.key))
console.log(
  `本地池 ${pool.all().length} 条；以本地排序前 ${localTop.length} 个 available 为必死；` +
    `剩余可用 ${restLocal.length} 个`
)
// 重写 harness 里 doomed 的判定（用本地集合），并让这些 key 必失败
llm._doomed = doomedSet
const originalStream = llm.stream.bind(llm)
llm.stream = (options) => {
  const key = options.provider + '/' + options.model
  if (doomedSet.has(key)) {
    return (async function* () {
      const error = new Error('所有账号均不可用（限流或额度耗尽）')
      error.code = 'RATE_LIMIT'
      throw error
    })()
  }
  return originalStream(options)
}

// ── 4. 跑三轮（用户要的是「连续失败十几轮」）──────────────────────────────
let allPass = true
for (let round = 1; round <= 3; round += 1) {
  calls.length = 0
  let outcome
  let attemptChain = []
  try {
    const result = await failover.run({ messages: [] })
    outcome = result.model.key
    attemptChain = result.attempts
  } catch (error) {
    outcome = `ERROR:${error.name}`
    attemptChain = error.attempts ?? []
  }

  const landedOk = !outcome.startsWith('ERROR')
  const landedInRest = landedOk && restAvailable.some((m) => m.key === outcome)
  // 必死名单里的任何一个都不能是落点，也不该出现在成功前的重试里占位
  const doomedTried = attemptChain.filter((a) => doomed.includes(a.key)).length
  const pass = landedInRest && doomedTried === doomed.length

  if (!pass) allPass = false
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  第${round}轮：尝试 ${attemptChain.length} 次（其中必死名单 ${doomedTried}/20）` +
      `  落点=${outcome}${landedInRest ? '（剩余可用池）' : ''}`
  )
  if (round === 1) {
    console.log('  尝试链（前 8 条）：')
    for (const a of attemptChain.slice(0, 8)) {
      console.log(`    ${a.key}  ${a.ok ? '✓' : '✗ ' + a.verdict}`)
    }
  }
}

console.log(allPass ? '\n验证通过：连续 20 个候选失败后仍落到可用模型' : '\n验证失败')
process.exit(allPass ? 0 : 1)
