/**
 * 验证：预算耗尽后**不能中断任务**，要继续试到拿到有效响应。
 *
 * 用户诉求（原话）：「除非完成任务，否则要无感自动切换模型，不能因为预算耗尽
 * 就直接中断任务，要在剩余预算内尽可能多试候选，直到拿到有效响应。」
 *
 * 场景：
 *   - 前 N 个候选都是慢通道（首帧挂满，吃掉全部预算）；
 *   - 后面还有一个**快通道**（200ms 响应）。
 *   - 期望：预算收手后由 pickFastestHealthy 挑到那个快通道并成功，**不抛错**。
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} }
const tick = (ms) => new Promise((r) => setTimeout(r, ms))

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

let failed = 0
function check(name, ok, detail) {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// ── 场景 1：预算被慢通道吃光，后面有快通道 ───────────────────────────────────
{
  // 4 个慢通道（首帧挂 12s > firstFrameTimeout 10s）+ 1 个快通道
  const ids = ['slow-0', 'slow-1', 'slow-2', 'slow-3', 'fast-ok']
  const models = { 'our-free-model': ids }
  const calls = []

  const llm = {
    listProviders: () => [{ id: 'our-free-model', name: 'free' }],
    listModels: async (p) => (models[p] ?? []).map((id) => ({ provider: p, id, name: id })),
    resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
    stream(options) {
      const key = `${options.provider}/${options.model}`
      calls.push(key)
      const isFast = options.model === 'fast-ok'
      return (async function* () {
        if (isFast) {
          await tick(200)
          yield { type: 'text-delta', text: '快通道接住了' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        // 慢通道：首帧永远不来
        await new Promise(() => {})
      })()
    }
  }

  const config = normalizeConfig({
    failover: {
      maxTotalMs: 5_000, // 预算 5s
      firstFrameTimeoutMs: 2_000, // 单个候选最多等 2s
      maxRetriesPerModel: 0,
      retrySameModel: false,
      terminalFallback: false // 关掉付费兜底，强制走 last-resort
    }
  })
  const store = createStore()
  // 快通道延迟探针数据（让 pickFastestHealthy 能挑到它）
  store.models['our-free-model/fast-ok'] = {
    health: 'available',
    failCount: 0,
    cooldownUntil: 0,
    nextProbeAt: Date.now() + 600_000,
    lastProbe: { at: Date.now(), verdict: 'ok', latencyMs: 200 }
  }
  for (const id of ids.slice(0, 4)) {
    store.models[`our-free-model/${id}`] = {
      health: 'available',
      failCount: 0,
      cooldownUntil: 0,
      nextProbeAt: Date.now() + 600_000,
      lastProbe: { at: Date.now(), verdict: 'ok', latencyMs: 11_000 } // 慢
    }
  }

  const pool = createPool({ ctx: { llm }, config, store, logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config, logger })
  const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })

  const started = Date.now()
  let outcome
  let reason
  let attempts = []
  try {
    const result = await failover.run({ messages: [] })
    outcome = result.model.key
    reason = result.reason
    attempts = result.attempts
  } catch (error) {
    outcome = `ERROR:${error.name}`
    attempts = error.attempts ?? []
  }
  const elapsed = Date.now() - started

  console.log('--- 场景 1：慢通道吃光预算 + 后面有快通道 ---')
  console.log(`  调用链: ${calls.join(' → ')}`)
  console.log(`  尝试数: ${attempts.length}  落点: ${outcome}  reason: ${reason ?? '-'}  耗时: ${elapsed}ms`)
  check('预算耗尽后不中断，落到快通道', outcome === 'our-free-model/fast-ok')
  check('总耗时受控（小于 3 倍预算）', elapsed < 15_000, `${elapsed}ms`)
}

// ── 场景 1b：调度器无法靠延迟区分时（全无探针数据），预算耗尽后靠 last-resort 救 ──
{
  // 5 个候选全部没有 lastProbe（latency 未知 → 调度器无法按延迟排序）；
  // priority 让前 4 个先被挑（它们实际挂死），第 5 个实际快。
  const slow = ['a0', 'a1', 'a2', 'a3']
  const fast = 'z-fast-ok'
  const models = { 'our-free-model': [...slow, fast] }
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'our-free-model', name: 'free' }],
    listModels: async (p) => (models[p] ?? []).map((id) => ({ provider: p, id, name: id })),
    resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
    stream(options) {
      const key = `${options.provider}/${options.model}`
      calls.push(key)
      const isFast = options.model === fast
      return (async function* () {
        if (isFast) {
          await tick(150)
          yield { type: 'text-delta', text: '快通道接住了' }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        await new Promise(() => {}) // 挂死
      })()
    }
  }
  const config = normalizeConfig({
    failover: {
      maxTotalMs: 4_000,
      firstFrameTimeoutMs: 1_000,
      maxRetriesPerModel: 0,
      retrySameModel: false,
      terminalFallback: false
    }
  })
  const store = createStore()
  // 前 4 个 priority 高（先被挑），但没有 lastProbe（延迟未知）
  for (const id of slow) {
    store.models[`our-free-model/${id}`] = {
      health: 'available',
      failCount: 0,
      cooldownUntil: 0,
      nextProbeAt: Date.now() + 600_000,
      hiddenFromPicker: false,
      lastProbe: null
    }
  }
  store.models[`our-free-model/${fast}`] = {
    health: 'available',
    failCount: 0,
    cooldownUntil: 0,
    nextProbeAt: Date.now() + 600_000,
    hiddenFromPicker: false,
    lastProbe: null
  }

  const pool = createPool({ ctx: { llm }, config, store, logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config, logger })
  const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })

  const started = Date.now()
  let outcome
  let reason
  let attempts = []
  try {
    const result = await failover.run({ messages: [] })
    outcome = result.model.key
    reason = result.reason
    attempts = result.attempts
  } catch (error) {
    outcome = `ERROR:${error.name}`
    attempts = error.attempts ?? []
  }
  const elapsed = Date.now() - started

  console.log('--- 场景 1b：延迟数据缺失，前 4 个挂死吃光预算 ---')
  console.log(`  调用链: ${calls.join(' → ')}`)
  console.log(`  尝试数: ${attempts.length}  落点: ${outcome}  reason: ${reason ?? '-'}  耗时: ${elapsed}ms`)
  const lastAttempt = attempts[attempts.length - 1] ?? {}
  check('预算耗尽后不中断任务', outcome === 'our-free-model/z-fast-ok', `outcome=${outcome}`)
  check('由 last-resort 接管', lastAttempt.lastResort === true || reason === 'last-resort', `reason=${reason}`)
}

// ── 场景 2：全部候选都失败，才允许抛错 ─────────────────────────────────────
{
  const ids = ['a', 'b']
  const models = { 'our-free-model': ids }
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'our-free-model', name: 'free' }],
    listModels: async (p) => (models[p] ?? []).map((id) => ({ provider: p, id, name: id })),
    resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
    stream(options) {
      calls.push(`${options.provider}/${options.model}`)
      return (async function* () {
        const error = new Error('quota exhausted')
        error.code = 'RATE_LIMIT'
        throw error
      })()
    }
  }
  const config = normalizeConfig({
    failover: { maxTotalMs: 5_000, firstFrameTimeoutMs: 2_000, maxRetriesPerModel: 0, retrySameModel: false, terminalFallback: false }
  })
  const pool = createPool({ ctx: { llm }, config, store: createStore(), logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config, logger })
  const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })

  let outcome
  try {
    const result = await failover.run({ messages: [] })
    outcome = result.model.key
  } catch (error) {
    outcome = `ERROR:${error.name}`
  }
  console.log('--- 场景 2：真的所有候选都失败 ---')
  console.log(`  调用链: ${calls.join(' → ')}`)
  check('全部失败时才抛错', outcome === 'ERROR:AutopilotExhaustedError', `outcome=${outcome}`)
}

console.log()
console.log(failed === 0 ? '全部通过：预算耗尽不再中断任务' : `${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
