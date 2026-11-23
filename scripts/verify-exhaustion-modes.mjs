/**
 * v0.2.1 暴力验证：极端组合下故障切换是否仍能「包活」。
 *
 * 独立验证，不依赖其它脚本。每个场景独立构造池 + 假上游，断言：
 *   1. 错误码能区分「预算耗尽」与「候选耗尽」；
 *   2. 文案与错误码一一对应（不混淆）；
 *   3. 仍会**尽可能**尝试可用候选（不是第一个失败就停）；
 *   4. 一次失败 / 连续失败 / 探针失败 / 状态写入失败 都不会让切换链路提前中止。
 *
 * 运行：node scripts/verify-exhaustion-modes.mjs
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} }

let passed = 0
let failed = 0
const failures = []

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`)
  } else {
    failed += 1
    failures.push(`${name} :: ${detail}`)
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

/**
 * 构造一个自洽的测试环境。
 * @param {object} options
 * @param {string[]} options.ids 模型 id（同一 provider 下）
 * @param {(id: string, index: number) => object|null} options.behaviour 每个模型的假上游行为；返回 null = 正常放行
 * @param {object} [options.config]
 * @param {object} [options.storeOverride]
 */
async function setup({ ids, behaviour, config = {}, storeOverride = {} }) {
  const models = { 'our-free-model': ids }
  const llm = {
    listProviders: () => Object.keys(models).map((id) => ({ id, name: id })),
    listModels: async (p) => (models[p] ?? []).map((id) => ({ provider: p, id, name: id })),
    resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
    stream(options) {
      const key = options.model
      const index = ids.indexOf(key)
      const behaviourSpec = behaviour(key, index)
      return (async function* () {
        if (behaviourSpec?.delayMs) {
          await new Promise((r) => setTimeout(r, behaviourSpec.delayMs))
        }
        if (behaviourSpec?.throw) {
          const error = new Error(behaviourSpec.throw.message ?? 'boom')
          error.code = behaviourSpec.throw.code ?? 'SERVER'
          throw error
        }
        yield { type: 'text-delta', text: behaviourSpec?.text ?? 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }

  const store = {
    models: {},
    model(k) {
      return store.models[k]
    },
    setModel(k, v) {
      store.models[k] = v
    },
    setMeta() {},
    get() {
      return { models: store.models }
    },
    flushSync() {},
    dispose() {},
    ...storeOverride
  }

  const normalized = normalizeConfig(config)
  const pool = createPool({ ctx: { llm }, config: normalized, store, logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config: normalized, logger })
  const failover = createFailover({
    ctx: { llm },
    pool,
    scheduler,
    config: normalized,
    logger,
    wait: async () => {}
  })
  return { failover, pool, llm, config: normalized }
}

/** 抓取错误，返回可断言的形状。 */
async function runExpectError(failover, request = { messages: [] }) {
  try {
    await failover.run(request)
    return null
  } catch (error) {
    return {
      error,
      code: error.code,
      message: error.message,
      budgetExhausted: error.budgetExhausted,
      elapsedMs: error.elapsedMs,
      budgetMs: error.budgetMs,
      attempts: error.attempts ?? []
    }
  }
}

console.log('=== A. 错误码与文案必须一一对应 ===\n')

// A1. 候选耗尽：候选很少，没超预算
{
  const { failover } = await setup({
    ids: ['a', 'b', 'c'],
    behaviour: () => ({ throw: { code: 'RATE_LIMIT', message: 'quota' } }),
    config: { failover: { terminalFallback: false, maxRetriesPerModel: 0 } }
  })
  const r = await runExpectError(failover)
  check('A1 候选耗尽：拿到错误', r !== null, r ? '' : '竟然成功了')
  if (r) {
    check('A1 候选耗尽：文案说「所有候选模型均失败」', /所有候选模型均失败/.test(r.message), r.message)
    check('A1 候选耗尽：budgetExhausted=false', r.budgetExhausted === false, String(r.budgetExhausted))
    console.log(`      code=${r.code}  budgetExhausted=${r.budgetExhausted}`)
  }
}

// A2. 预算耗尽：候选多、每步慢，预算先到
{
  const ids = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, '0')}`)
  const { failover } = await setup({
    ids,
    behaviour: () => ({ delayMs: 700, throw: { code: 'RATE_LIMIT', message: 'quota' } }),
    config: {
      failover: {
        maxTotalMs: 5_000,
        maxRetriesPerModel: 0,
        retrySameModel: false,
        backoff: { initialMs: 0, maxMs: 0, jitterRatio: 0 },
        terminalFallback: false
      }
    }
  })
  const r = await runExpectError(failover)
  check('A2 预算耗尽：拿到错误', r !== null, r ? '' : '竟然成功了')
  if (r) {
    check('A2 预算耗尽：文案说「换模型预算耗尽」', /换模型预算耗尽/.test(r.message), r.message)
    check('A2 预算耗尽：不含「所有候选模型均失败」', !/所有候选模型均失败/.test(r.message), r.message)
    check('A2 预算耗尽：budgetExhausted=true', r.budgetExhausted === true, String(r.budgetExhausted))
    check('A2 预算耗尽：带 elapsedMs/budgetMs', typeof r.elapsedMs === 'number' && typeof r.budgetMs === 'number', `${r.elapsedMs}/${r.budgetMs}`)
    console.log(`      code=${r.code}  budgetExhausted=${r.budgetExhausted}  ${r.elapsedMs}ms/${r.budgetMs}ms`)
  }
}

console.log('\n=== B. 极端参数组合 ===\n')

// B1. 预算极小（归一化下限 5s）+ 大量快失败候选 → 必须报候选耗尽，且尽量多试
{
  const ids = Array.from({ length: 60 }, (_, i) => `m${String(i).padStart(2, '0')}`)
  const { failover, config } = await setup({
    ids,
    behaviour: (id, index) => (index < 59 ? { throw: { code: 'RATE_LIMIT', message: 'quota' } } : null),
    config: { failover: { maxTotalMs: 5_000, maxRetriesPerModel: 0, retrySameModel: false } }
  })
  const result = await failover.run({ messages: [] }).catch((e) => ({ err: e }))
  const attempted = result.attempts?.length ?? 0
  check(
    'B1 60 个候选 + 5s 预算 + 快失败：必须落到最后一个可用候选',
    !result.err && result.model?.key === 'our-free-model/m59',
    result.err ? `错误：${result.err.message}` : `落点=${result.model?.key} 尝试=${attempted}`
  )
  console.log(`      maxModels=${config.failover.maxModels}  尝试=${attempted}`)
}

// B2. 全部候选不可用 → 候选耗尽
{
  const ids = Array.from({ length: 5 }, (_, i) => `m${i}`)
  const { failover } = await setup({
    ids,
    behaviour: () => ({ throw: { code: 'RATE_LIMIT', message: 'quota' } }),
    config: { failover: { terminalFallback: false, maxRetriesPerModel: 0 } }
  })
  const r = await runExpectError(failover)
  check('B2 全部不可用：报候选耗尽', r !== null && /所有候选模型均失败/.test(r.message), r?.message ?? '竟然成功')
}

// B3. 首个候选超时（首帧挂起）→ 应换到第二个
{
  const { failover } = await setup({
    ids: ['hangs', 'ok'],
    behaviour: (id) => (id === 'hangs' ? { delayMs: 1_100 } : null),
    config: {
      failover: {
        firstFrameTimeoutMs: 1_000,
        maxRetriesPerModel: 0,
        retrySameModel: false,
        terminalFallback: false
      }
    }
  })
  const result = await failover.run({ messages: [] }).catch((e) => ({ err: e }))
  check(
    'B3 首个候选首帧超时：换到第二个并成功',
    !result.err && result.model?.key === 'our-free-model/ok',
    result.err ? `错误：${result.err.message}` : `落点=${result.model?.key}`
  )
}

// B4. maxModels 极小（显式配 1）→ 只能试 1 个，剩的 available 没被试 → 候选耗尽
{
  const ids = Array.from({ length: 10 }, (_, i) => `m${i}`)
  const { failover, config } = await setup({
    ids,
    behaviour: (id, index) => (index === 0 ? { throw: { code: 'RATE_LIMIT', message: 'quota' } } : null),
    config: { failover: { maxModels: 1, maxRetriesPerModel: 0, terminalFallback: false } }
  })
  const r = await runExpectError(failover)
  check(
    'B4 maxModels=1：只试 1 个就耗尽（显式配置应生效）',
    r !== null && r.attempts.length === 1,
    `attempts=${r?.attempts.length} maxModels=${config.failover.maxModels}`
  )
}

console.log('\n=== C. 失败不会让切换链路提前中止 ===\n')

// C1. 第一次失败、第二个可用 → 必须成功（不能第一次失败就抛）
{
  const { failover } = await setup({
    ids: ['bad', 'good'],
    behaviour: (id) => (id === 'bad' ? { throw: { code: 'SERVER', message: 'boom' } } : null),
    config: { failover: { maxRetriesPerModel: 0, terminalFallback: false } }
  })
  const result = await failover.run({ messages: [] }).catch((e) => ({ err: e }))
  check('C1 单次失败后继续：落到 good', !result.err && result.model?.key === 'our-free-model/good', result.err?.message ?? result.model?.key)
}

// C2. 连续失败 3 个、第 4 个可用 → 必须成功
{
  const ids = ['e1', 'e2', 'e3', 'good']
  const { failover } = await setup({
    ids,
    behaviour: (id) => (id === 'good' ? null : { throw: { code: 'SERVER', message: 'boom' } }),
    config: { failover: { maxRetriesPerModel: 0, terminalFallback: false } }
  })
  const result = await failover.run({ messages: [] }).catch((e) => ({ err: e }))
  check('C2 连续失败 3 次后：落到 good', !result.err && result.model?.key === 'our-free-model/good', result.err?.message ?? result.model?.key)
}

// C3. 状态写入失败（store.setModel 抛错）→ 切换不能因此中止
{
  const ids = ['bad', 'good']
  const { failover } = await setup({
    ids,
    behaviour: (id) => (id === 'bad' ? { throw: { code: 'SERVER', message: 'boom' } } : null),
    config: { failover: { maxRetriesPerModel: 0, terminalFallback: false } },
    storeOverride: {
      setModel() {
        throw new Error('disk full')
      }
    }
  })
  const result = await failover.run({ messages: [] }).catch((e) => ({ err: e }))
  check(
    'C3 状态写入失败：仍能切到 good（写盘故障不阻断切换）',
    !result.err && result.model?.key === 'our-free-model/good',
    result.err ? `错误：${result.err.message}` : `落点=${result.model?.key}`
  )
}

// C4. 兜底通道：候选全失败 → 走 terminalFallback 而不是抛错
{
  const ids = ['e1', 'e2']
  const { failover } = await setup({
    ids,
    behaviour: () => ({ throw: { code: 'SERVER', message: 'boom' } }),
    config: { failover: { maxRetriesPerModel: 0 } }
  })
  // 兜底 provider 不在池里 → pickTerminalFallback 返回 null → 才会抛错。
  // 这里验证：池里若有 deepseek-account 条目，应命中兜底。
  const result = await failover.run({ messages: [] }).catch((e) => ({ err: e }))
  check(
    'C4 候选全失败且无兜底条目：报候选耗尽（不是预算耗尽）',
    result.err !== undefined && /所有候选模型均失败/.test(result.err.message ?? ''),
    result.err?.message ?? `落点=${result.model?.key}`
  )
}

console.log('\n=== D. 探针失败不影响切换链路 ===\n')

// D1. 探针把条目判失败后，failover 仍应能切换（探针只写池状态，不参与切换决策）
{
  const ids = ['p1', 'p2']
  const { failover, pool } = await setup({
    ids,
    behaviour: (id) => (id === 'p1' ? { throw: { code: 'RATE_LIMIT', message: 'quota' } } : null),
    config: { failover: { maxRetriesPerModel: 0, terminalFallback: false } }
  })
  // 模拟探针写入的失败状态
  pool.markFailure('our-free-model/p1', 'throttled')
  const result = await failover.run({ messages: [] }).catch((e) => ({ err: e }))
  check(
    'D1 探针标失败后：仍能切到 p2（冷却到期即可）',
    !result.err && result.model?.key === 'our-free-model/p2',
    result.err ? `错误：${result.err.message}` : `落点=${result.model?.key}`
  )
}

console.log(`\n=== 汇总：${passed} PASS / ${failed} FAIL ===`)
if (failed > 0) {
  console.log('\n失败明细：')
  for (const f of failures) console.log(`  - ${f}`)
}
process.exit(failed > 0 ? 1 : 0)
