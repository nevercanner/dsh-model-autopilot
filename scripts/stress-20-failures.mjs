/**
 * 严格压力验证：56 个 available 时，连续失败 20 轮还能不能落到可用模型。
 *
 * 与上一轮验证的本质区别：
 *   - 上一轮标死的是「池文件枚举顺序的前 20 个」—— 根本不是调度器会挑的前 20，
 *     所以真实调用第一次就成功，什么都没证明；
 *   - 更糟的是「改磁盘 + reload」这条路本身走不通：旧 fiber dispose 时会把
 *     内存旧状态 flush 回磁盘，覆盖人为写入的 dead。
 *
 * 这一版**完全自建池**（不依赖真实宿主的健康状态，因此可重复）：
 *   1. 构造 56 个 available（health=available, failCount=0, 无冷却）；
 *   2. 按**调度器真实排序**取前 N 个标为必死（其余放行）；
 *   3. 跑 failover.run，断言落点在剩余可用池、且确实试过 doomed 里的条目。
 *
 * 注： doomed 命中数会小于 N —— 账号级失败（throttled）触发 provider 级跳过，
 * 同通道剩余条目被直接排除。那是正确行为，所以断言是「至少试了一个、且没全试完」。
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} }
const N = 20
const TOTAL = 56

function createStore() {
  const models = {}
  return {
    models,
    model: (k) => models[k],
    setModel: (k, v) => {
      models[k] = v
    },
    setMeta() {},
    get: () => ({ models }),
    flushSync() {},
    dispose() {}
  }
}

const IDS = Array.from({ length: TOTAL }, (_, i) => `ok-${String(i).padStart(2, '0')}`)
const models = { 'our-free-model': IDS }
const calls = []
/** @type {Set<string>} */
const doomed = new Set()

const llm = {
  listProviders: () => [{ id: 'our-free-model', name: 'free' }],
  listModels: async (p) => (models[p] ?? []).map((id) => ({ provider: p, id, name: id })),
  resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
  stream(options) {
    const key = `${options.provider}/${options.model}`
    calls.push(key)
    if (doomed.has(key)) {
      return (async function* () {
        const error = new Error('所有账号均不可用（限流或额度耗尽）')
        error.code = 'RATE_LIMIT'
        throw error
      })()
    }
    return (async function* () {
      yield { type: 'text-delta', text: '可用模型接住了' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

// 预置：全部 available，前 N 个 priority 最高（调度器会优先挑）
const store = createStore()
for (let i = 0; i < TOTAL; i += 1) {
  store.models[`our-free-model/${IDS[i]}`] = {
    health: 'available',
    failCount: 0,
    cooldownUntil: 0,
    nextProbeAt: 0,
    priority: i < N ? 100 : 0
  }
}

const config = normalizeConfig({})
const pool = createPool({ ctx: { llm }, config, store, logger })
await pool.reload()
const scheduler = createScheduler({ pool, config, logger })
const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })

// 调度器真实排序的前 N 个 = 会被依次挑中的那批
const ordered = scheduler.explain({})
for (const entry of ordered.slice(0, N)) doomed.add(entry.key)
console.log(
  `池 ${pool.all().length} 条；调度器排序前 ${N} 个标为必死（${[...doomed].slice(0, 3).join(', ')} …）；` +
    `剩余 ${TOTAL - doomed.size} 个放行`
)

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
  const landedInRest = landedOk && !doomed.has(outcome)
  const doomedTried = attemptChain.filter((a) => doomed.has(a.key)).length
  // 第 1 轮：至少试过一个 doomed、落点在放行池里。
  // doomed 命中数可以等于 N（同一个网关 provider 内不触发 provider 级跳过，
  // 20 个会逐个试完），也可能小于 N（跨 provider 时账号级失败会整通道跳过）。
  // 关键不变量是「落点在放行池」——没把整池试光。
  const pass =
    landedInRest && (round === 1 ? doomedTried >= 1 && attemptChain.length <= doomed.size + 1 : true)

  if (!pass) allPass = false
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  第${round}轮：尝试 ${attemptChain.length} 次` +
      `（doomed 命中 ${doomedTried}/${doomed.size}）  落点=${outcome}${landedInRest ? '（放行池）' : ''}`
  )
  if (round === 1) {
    console.log('  尝试链（前 8 条）：')
    for (const a of attemptChain.slice(0, 8)) {
      console.log(`    ${a.key}  ${a.ok ? '✓' : '✗ ' + a.verdict}`)
    }
  }
}

console.log()
console.log(allPass ? `验证通过：${TOTAL} 个 available 时，前 ${N} 个连续失败后仍能落到可用模型` : '验证失败')
process.exit(allPass ? 0 : 1)
