/**
 * 对外入口测试：虚拟 provider 的 adapter 契约 + 统一入口的返回形状。
 *
 * 这里断言的是宿主真正会校验的东西（providerInfo 的 id、listModels 的 provider 字段、
 * prepareCall 的返回形状）—— 少一个，注册会抛 INVALID_ADAPTER 或目录读取抛 INVALID_CATALOG。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import {
  createAutopilot,
  createAutopilotAdapter,
  AUTOPILOT_PROVIDER,
  AUTOPILOT_MODEL
} from '../src/autopilot.js'
import { normalizeConfig } from '../src/config.js'

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

function createFakeLlm() {
  const calls = []
  return {
    calls,
    listProviders: () => [
      { id: 'our-free-model', name: 'Our Free Model' },
      { id: 'magpie', name: 'Magpie' }
    ],
    listModels: async (provider) =>
      provider === 'our-free-model'
        ? [{ provider, id: 'free-a', name: 'free-a' }]
        : [{ provider, id: 'paid-x', name: 'paid-x' }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    stream(options) {
      calls.push(`${options.provider}/${options.model}`)
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: options.provider === 'our-free-model' ? 'free' : 'paid' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    },
    emitAdaptersUpdated() {}
  }
}

async function setup() {
  const llm = createFakeLlm()
  const config = normalizeConfig({ failover: { backoff: { initialMs: 0, maxMs: 0, jitterRatio: 0 } } })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config, logger })
  const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })
  const autopilot = createAutopilot({ ctx: { llm }, pool, scheduler, failover, config, logger })
  const adapter = createAutopilotAdapter({ getAutopilot: () => autopilot, logger })
  return { llm, pool, scheduler, failover, autopilot, adapter }
}

test('adapter 满足宿主注册校验：providerInfo 的 id 必须等于 provider', async () => {
  const { adapter } = await setup()
  const info = adapter.providerInfo(AUTOPILOT_PROVIDER)
  assert.equal(info.id, AUTOPILOT_PROVIDER)
  assert.ok(typeof info.name === 'string' && info.name.length > 0)
})

test('listModels 返回项的 provider 字段必须等于 provider（否则 INVALID_CATALOG）', async () => {
  const { adapter } = await setup()
  const models = await adapter.listModels(AUTOPILOT_PROVIDER)
  assert.equal(models.length, 1)
  assert.equal(models[0].provider, AUTOPILOT_PROVIDER)
  assert.equal(models[0].id, AUTOPILOT_MODEL)
  assert.ok(models[0].name.length > 0)
})

test('resolveModel 保留 id，且不编造上下文窗口', async () => {
  const { adapter } = await setup()
  const info = await adapter.resolveModel(AUTOPILOT_PROVIDER, AUTOPILOT_MODEL)
  assert.equal(info.provider, AUTOPILOT_PROVIDER)
  assert.equal(info.id, AUTOPILOT_MODEL)
  assert.equal(info.context, undefined)
  assert.equal(info.inputModalities, undefined)
})

test('prepareCall 返回 { model, stream }，stream 是函数', async () => {
  const { adapter } = await setup()
  const prepared = await adapter.prepareCall(AUTOPILOT_PROVIDER, AUTOPILOT_MODEL)
  assert.equal(prepared.model.id, AUTOPILOT_MODEL)
  assert.equal(typeof prepared.stream, 'function')
})

test('adapter.stream 把请求转交给自动选型，并输出真实模型的流', async () => {
  const { llm, adapter } = await setup()
  const stream = adapter.stream({
    provider: AUTOPILOT_PROVIDER,
    model: AUTOPILOT_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  })

  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)

  assert.deepEqual(chunks.map((item) => item.type), ['text-delta', 'finish'])
  assert.equal(chunks[0].text, 'free', '免费模型应被优先选中')
  // 真正打到上游的是免费 provider，而不是 autopilot 自己（不能递归）
  assert.deepEqual(llm.calls, ['our-free-model/free-a'])
})

test('run 返回 model / attempts / fallbacks / reason，并记录 status.lastResult', async () => {
  const { autopilot } = await setup()
  const result = await autopilot.run({
    intent: '单测',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  })

  assert.equal(result.model.key, 'our-free-model/free-a')
  assert.equal(result.model.cost, 'free')
  assert.equal(result.reason, 'free:preferred')
  assert.equal(result.attempts.length, 1)
  assert.equal(result.fallbacks[0].key, 'magpie/paid-x')

  const status = autopilot.status()
  assert.equal(status.lastResult.model.key, 'our-free-model/free-a')
  assert.equal(status.allowPaidByDefault, true)
})

test('providerRetryPolicy 默认禁掉宿主重试（避免 5×N 叠加）', async () => {
  const { adapter } = await setup()
  const policy = adapter.providerRetryPolicy(AUTOPILOT_PROVIDER)
  assert.equal(policy.mode, 'normal')
  assert.equal(policy.maxRetries, 0)
  // 占位码不匹配任何真实错误码 → dsh-llm-retry 的
  // `retryableCodes.includes(failure.code)` 恒为 false。
  assert.ok(!['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'].some((code) =>
    policy.retryableCodes.includes(code)
  ))
  // resolved 形状：宿主直接把它当 resolved policy 使用，展开字段必须齐全。
  assert.equal(typeof policy.initialDelayMs, 'number')
  assert.equal(typeof policy.maxDelayMs, 'number')
  assert.equal(typeof policy.jitterRatio, 'number')
})

test('schedule.hostRetry=true 时把宿主默认策略交回去（显式选择叠加）', async () => {
  const llm = createFakeLlm()
  const config = normalizeConfig({ schedule: { hostRetry: true } })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config, logger })
  const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })
  const autopilot = createAutopilot({ ctx: { llm }, pool, scheduler, failover, config, logger })
  const adapter = createAutopilotAdapter({ getAutopilot: () => autopilot, config, logger })
  assert.equal(adapter.providerRetryPolicy(AUTOPILOT_PROVIDER), undefined)
})

test('allowPaid=false 时只走免费', async () => {
  const { autopilot, pool } = await setup()
  pool.markProbe('our-free-model/free-a', 'auth', { at: Date.now() })

  await assert.rejects(
    () => autopilot.run({ messages: [], allowPaid: false }),
    (error) => error.name === 'AutopilotExhaustedError'
  )
})

test('plan 与 explain 不需要真正调用模型', async () => {
  const { autopilot } = await setup()
  const plan = autopilot.plan()
  assert.equal(plan.primary.key, 'our-free-model/free-a')

  const rows = autopilot.explain()
  assert.equal(rows[0].key, 'our-free-model/free-a')
  assert.equal(typeof rows[0].score, 'number')
})
