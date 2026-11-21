/**
 * 复现「有可用模型却报『所有候选模型均失败』」。
 *
 * 场景：前 K 个候选必然失败，第 K+1 个完全可用。
 * 期望：跳过失败模型、落到可用模型、正常产出。
 * 若 maxModels 把尝试次数掐死在 K，就会误报耗尽 —— 这个脚本用来验证修复。
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} }

function createStore() {
  const models = {}
  return {
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

/**
 */
async function run({ failFirst, total }) {
  const ids = Array.from({ length: total }, (_, i) => `m${String(i).padStart(2, '0')}`)
  const models = { 'our-free-model': ids }
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'our-free-model', name: 'free' }],
    listModels: async (p) => (models[p] ?? []).map((id) => ({ provider: p, id, name: id })),
    resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
    stream(options) {
      const key = `${options.provider}/${options.model}`
      calls.push(key)
      const index = ids.indexOf(options.model)
      return (async function* () {
        if (index < failFirst) {
          const error = new Error('所有账号均不可用（限流或额度耗尽）')
          error.code = 'RATE_LIMIT'
          throw error
        }
        yield { type: 'text-delta', text: 'ok:' + key }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }

  const config = normalizeConfig({
    failover: {
      // 不覆盖 maxModels：要验证的是**出厂默认配置**能不能走到可用模型。
      maxRetriesPerModel: 0,
      retrySameModel: false,
      backoff: { initialMs: 0, maxMs: 0, jitterRatio: 0 },
      terminalFallback: false
    }
  })
  const pool = createPool({ ctx: { llm }, config, store: createStore(), logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config, logger })
  const failover = createFailover({
    ctx: { llm },
    pool,
    scheduler,
    config,
    logger,
    wait: async () => {}
  })
  return { failover, calls }
}

const cases = [
  { failFirst: 1, total: 5, expect: 'm01' },
  { failFirst: 3, total: 8, expect: 'm03' },
  { failFirst: 6, total: 10, expect: 'm06' },
  { failFirst: 8, total: 12, expect: 'm08' }
]

let failed = 0
for (const item of cases) {
  const { failover, calls } = await run(item)
  let outcome
  try {
    const result = await failover.run({ messages: [] })
    outcome = result.model.key
  } catch (error) {
    outcome = `ERROR:${error.name}`
  }
  const want = `our-free-model/${item.expect}`
  const pass = outcome === want
  if (!pass) failed += 1
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  失败前${item.failFirst}/共${item.total} maxModels=${item.maxModels}` +
      `  期望=${want}  实际=${outcome}  尝试${calls.length}次`
  )
}
console.log(failed === 0 ? '\n全部通过：可用模型不会被误判为「所有候选均失败」' : `\n${failed} 个场景失败`)
process.exit(failed === 0 ? 0 : 1)
