/**
 * 故障切换测试：切换、重试、写回、以及「首帧之后不能切换」这条硬约束。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'
import { backoffDelay, isRetryableVerdict, isStructuralVerdict } from '../src/failover/breaker.js'
import { HEALTH } from '../src/pool/types.js'

const logger = { info() {}, warn() {} }

function createFakeStore() {
  const models = {}
  return {
    model: (key) => models[key],
    setModel: (key, value) => {
      models[key] = value
    },
    setMeta() {},
    get: () => ({ models }),
    flushSync() {},
    dispose() {}
  }
}

/**
 * 按 key 生成流的假 llm。`behaviour[key]` 可以是：
 *   'ok' | { throw: {code,message} } | { chunks: [...] } | 'hang'
 */
function createFakeLlm(models, behaviour) {
  const calls = []
  return {
    calls,
    listProviders: () => Object.keys(models).map((id) => ({ id, name: id })),
    listModels: async (provider) => models[provider].map((id) => ({ provider, id, name: id })),
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    stream(options) {
      const key = `${options.provider}/${options.model}`
      calls.push(key)
      const spec = behaviour[key] ?? 'ok'
      if (spec === 'throw') throw Object.assign(new Error('boom'), { code: 'SERVER' })
      if (spec === 'hang') return { async *[Symbol.asyncIterator]() { await new Promise(() => {}) } }
      if (typeof spec === 'object' && spec.throw) {
        return {
          async *[Symbol.asyncIterator]() {
            throw Object.assign(new Error(spec.throw.message), { code: spec.throw.code })
          }
        }
      }
      if (typeof spec === 'object' && spec.failAfter) {
        return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of spec.chunks ?? []) yield chunk
            throw Object.assign(new Error('mid-stream'), { code: 'TRANSPORT' })
          }
        }
      }
      const chunks = typeof spec === 'object' && spec.chunks ? spec.chunks : [
        { type: 'text-delta', text: 'hi' },
        { type: 'finish', reason: { kind: 'stop' } }
      ]
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        }
      }
    },
    emitAdaptersUpdated() {}
  }
}

async function setup(behaviour, cfg = {}, modelsOverride = null) {
  const models = modelsOverride ?? {
    'our-free-model': ['free-a', 'free-b'],
    magpie: ['paid-x']
  }
  const llm = createFakeLlm(models, behaviour)
  const config = normalizeConfig({
    failover: { maxModels: 3, maxRetriesPerModel: 1, retrySameModel: true, backoff: { initialMs: 0, maxMs: 0, jitterRatio: 0 } },
    ...cfg
  })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
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
  return { llm, pool, scheduler, failover }
}

test('首选成功：一次尝试，写回成功并清零失败计数', async () => {
  const { pool, failover } = await setup({})
  pool.markFailure('our-free-model/free-a', 'timeout', Date.now() - 1)
  // free-a 现在冷却中，首选应是 free-b
  const result = await failover.run({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0].ok, true)
  assert.equal(pool.get('our-free-model/free-b').failCount, 0)

  const chunks = []
  for await (const chunk of result.stream) chunks.push(chunk)
  assert.equal(chunks[0].type, 'text-delta')
  assert.equal(chunks.at(-1).type, 'finish')
})

test('鉴权失败：不重试，直接换下一个模型', async () => {
  const behaviour = {
    'our-free-model/free-a': { throw: { code: 'INVALID_CREDENTIAL', message: 'bad key' } }
  }
  const { llm, pool, failover } = await setup(behaviour)

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.equal(llm.calls[0], 'our-free-model/free-a')
  assert.equal(llm.calls[1], 'our-free-model/free-b', 'auth 不该在 free-a 上重试')
  assert.equal(pool.get('our-free-model/free-a').health, HEALTH.dead)
  assert.equal(pool.get('our-free-model/free-a').failCount, 1)
})

test('限流：不在同一模型上重试，直接换下一个候选', async () => {
  const behaviour = {
    'our-free-model/free-a': { throw: { code: 'RATE_LIMIT', message: '429' } }
  }
  const { llm, failover } = await setup(behaviour)

  // 免费通道按 session 计配额，原地重试往往只是再吃一次 429；
  // 而且上游/宿主也可能在重试，叠加后是 N×M 次请求。所以限流直接换模型。
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.deepEqual(llm.calls, ['our-free-model/free-a', 'our-free-model/free-b'])
  assert.equal(result.attempts[0].verdict, 'throttled')
})

test('全部失败：抛出 AutopilotExhaustedError，并带上映射后的错误码与尝试记录', async () => {
  const behaviour = {
    'our-free-model/free-a': { throw: { code: 'SERVER', message: '500' } },
    'our-free-model/free-b': { throw: { code: 'SERVER', message: '500' } },
    'magpie/paid-x': { throw: { code: 'SERVER', message: '500' } }
  }
  // 批次 4 起 maxModels 由预算推导且有下限（默认 12），显式配更小的值会被抬到
  // 下限 —— 这是刻意设计：不允许把候选数压到「前几个挂了就报耗尽」。
  // 所以这里不再断言「只试 2 个」，而是断言「3 个候选全部试过且都失败」。
  const { failover } = await setup(behaviour, { failover: { maxRetriesPerModel: 0 } })

  await assert.rejects(
    () => failover.run({ messages: [] }),
    (error) => {
      assert.equal(error.name, 'AutopilotExhaustedError')
      assert.equal(error.code, 'SERVER')
      assert.equal(error.attempts.length, 3, '三个候选都要被试过（不能提前截断）')
      assert.ok(error.attempts.every((item) => item.ok === false))
      return true
    }
  )
})

test('取消：signal 已中断时立刻抛出，且不写回失败', async () => {
  const { pool, failover } = await setup({})
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => failover.run({ messages: [], signal: controller.signal }), /aborted|取消|所有候选/)
  assert.equal(pool.get('our-free-model/free-a').failCount, 0)
})

test('首帧之后失败：不再切换，写回一次失败并上抛', async () => {
  const { pool, failover } = await setup({
    'our-free-model/free-a': { chunks: [{ type: 'text-delta', text: 'partial' }], failAfter: true }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-a')

  const seen = []
  await assert.rejects(async () => {
    for await (const chunk of result.stream) seen.push(chunk)
  }, /mid-stream/)

  assert.equal(seen.length, 1, '应拿到首帧后才失败')
  const entry = pool.get('our-free-model/free-a')
  assert.equal(entry.failCount, 1, '流内失败要写回一次')
  assert.notEqual(entry.health, HEALTH.available)
})

test('首块就是错误 finish：按失败处理并切换', async () => {  const { failover } = await setup({
    'our-free-model/free-a': {
      chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } } }]
    }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.equal(result.attempts[0].ok, false)
  assert.equal(result.attempts[0].verdict, 'throttled')
})

test('minimax-cn 额度耗尽：不重试，直接切下一个候选', async () => {
  const behaviour = {
    'minimax-cn/m1': { throw: { code: 'QUOTA', message: 'quota exhausted' } }
  }
  const { llm, pool, failover } = await setup(
    behaviour,
    {
      failover: {
        maxModels: 3,
        maxRetriesPerModel: 1,
        retrySameModel: true,
        backoff: { initialMs: 0, maxMs: 0, jitterRatio: 0 }
      }
    },
    {
      'our-free-model': ['free-a', 'free-b'],
      'minimax-cn': ['m1'],
      magpie: ['paid-x']
    }
  )

  // 免费全部结构性失效，确保落到付费组（minimax-cn 置顶）。
  pool.markProbe('our-free-model/free-a', 'auth', Date.now())
  pool.markProbe('our-free-model/free-b', 'auth', Date.now())

  const result = await failover.run({ messages: [] })

  assert.equal(result.model.key, 'magpie/paid-x', '应切换到下一个候选')
  // 额度类失败（QUOTA → throttled）不重试：minimax-cn 只被调用一次。
  assert.deepEqual(llm.calls, ['minimax-cn/m1', 'magpie/paid-x'])
  assert.equal(result.attempts[0].key, 'minimax-cn/m1')
  assert.equal(result.attempts[0].verdict, 'throttled')
  assert.equal(result.attempts[0].retry, 0)
  assert.equal(result.attempts.length, 2, '两次尝试：minimax-cn 一次 + 备用一次')
})

test('首帧是 usage、随后 error finish：必须切换（额度耗尽的真实形态）', async () => {
  const { failover, pool, llm } = await setup({
    'our-free-model/free-a': {
      chunks: [
        { type: 'usage', usage: { outputTokens: 0 } },
        { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'quota exhausted' } } }
      ]
    }
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b', '不能把 usage 当成成功首帧')
  assert.deepEqual(llm.calls, ['our-free-model/free-a', 'our-free-model/free-b'])
  assert.equal(result.attempts[0].verdict, 'throttled')
  assert.equal(pool.get('our-free-model/free-a').failCount, 1)
})

test('正常流：usage 前置帧原样转发，不丢', async () => {
  const { failover } = await setup({
    'our-free-model/free-a': {
      chunks: [
        { type: 'usage', usage: { inputTokens: 4 } },
        { type: 'text-delta', text: 'hi' },
        { type: 'finish', reason: { kind: 'stop' } }
      ]
    }
  })
  const result = await failover.run({ messages: [] })
  const seen = []
  for await (const chunk of result.stream) seen.push(chunk.type)
  assert.deepEqual(seen, ['usage', 'text-delta', 'finish'])
})

test('breaker：可重试判定、结构性判定、退避上限', () => {
  // 限流不重试：直接换模型（见上一测试的注释）。
  assert.equal(isRetryableVerdict('throttled'), false)
  assert.equal(isRetryableVerdict('timeout'), true)
  assert.equal(isRetryableVerdict('unavailable'), true)
  assert.equal(isRetryableVerdict('empty'), true)
  assert.equal(isRetryableVerdict('auth'), false)
  assert.equal(isStructuralVerdict('auth'), true)
  assert.equal(isStructuralVerdict('region-blocked'), true)
  assert.equal(isStructuralVerdict('timeout'), false)

  const backoff = { initialMs: 100, maxMs: 250, jitterRatio: 0 }
  assert.equal(backoffDelay(0, backoff), 100)
  assert.equal(backoffDelay(1, backoff), 200)
  assert.equal(backoffDelay(5, backoff), 250)
  assert.equal(backoffDelay(0, { ...backoff, jitterRatio: 0.5 }, () => 0.5), 100)
})
