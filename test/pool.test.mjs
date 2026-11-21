/**
 * 模型池装载与状态写回的测试：用假的 ctx.llm 代替宿主。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPool } from '../src/pool/pool.js'
import { normalizeConfig } from '../src/config.js'
import { HEALTH } from '../src/pool/types.js'

const logger = { info() {}, warn() {} }

/** 内存 store，形状与 src/store.js 一致。 */
function createFakeStore(seed = {}) {
  const models = { ...seed }
  return {
    models,
    model: (key) => models[key],
    setModel: (key, value) => {
      models[key] = value
    },
    get: () => ({ version: 1, updatedAt: 0, models }),
    flushSync() {},
    dispose() {}
  }
}

/**
 * @param {object} spec
 * @param {Record<string, any[]>} spec.models - providerId → listModels 结果
 * @param {(provider: string, model: string) => any} [spec.resolve]
 * @param {(provider: string) => boolean} [spec.failProviders]
 */
function createFakeLlm({ models, resolve, failProviders }) {
  const calls = { listProviders: 0, listModels: 0, resolve: 0 }
  return {
    calls,
    listProviders() {
      calls.listProviders += 1
      return Object.keys(models).map((id) => ({ id, name: id.toUpperCase() }))
    },
    async listModels(provider) {
      calls.listModels += 1
      if (failProviders?.(provider)) throw new Error(`provider ${provider} unreachable`)
      return models[provider].map((id) => ({ provider, id, name: id, inputModalities: ['text'] }))
    },
    async resolveModelInfo(provider, model) {
      calls.resolve += 1
      return resolve ? resolve(provider, model) : { provider, id: model, name: model }
    },
    emitAdaptersUpdated() {}
  }
}

test('统一建池：免费 provider 打 free，付费 provider 打 paid', async () => {
  const llm = createFakeLlm({
    models: {
      'our-free-model': ['free-a', 'free-b'],
      magpie: ['deepseek/deepseek-v4-pro']
    },
    resolve: () => ({ context: { contextWindow: 131_072 }, inputModalities: ['text', 'image'], reasoning: { efforts: [{ id: 'high', name: 'High' }] } })
  })
  const config = normalizeConfig({})
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()

  const entries = pool.all()
  assert.equal(entries.length, 3)

  const freeA = pool.get('our-free-model/free-a')
  assert.equal(freeA.cost, 'free')
  assert.equal(freeA.priority, config.free.priorityBonus)
  assert.equal(freeA.contextWindow, 131_072)
  assert.deepEqual(freeA.inputModalities, ['text', 'image'])
  assert.equal(freeA.reasoning, true)

  const paid = pool.get('magpie/deepseek/deepseek-v4-pro')
  assert.equal(paid.cost, 'paid')
  assert.equal(paid.priority, 0)
})

test('付费优先级可被配置覆盖', async () => {
  const llm = createFakeLlm({ models: { anthropic: ['x'], openai: ['y'] } })
  const config = normalizeConfig({ paid: { priorities: { anthropic: 50 } } })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()
  assert.equal(pool.get('anthropic/x').priority, 50)
  assert.equal(pool.get('openai/y').priority, 0)
})

test('resolveModelInfo 失败不丢条目，只是没有能力信息', async () => {
  const llm = createFakeLlm({
    models: { p: ['m'] },
    resolve: () => {
      throw new Error('no metadata')
    }
  })
  const config = normalizeConfig({})
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()
  const entry = pool.get('p/m')
  assert.ok(entry)
  assert.equal(entry.contextWindow, 0)
  assert.deepEqual(entry.inputModalities, ['text'])
})

test('单个 provider 枚举失败不拖垮整池，并记录失败', async () => {
  const llm = createFakeLlm({
    models: { good: ['a'], broken: ['b'] },
    failProviders: (provider) => provider === 'broken'
  })
  const config = normalizeConfig({})
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()

  assert.equal(pool.all().length, 1)
  assert.equal(pool.get('good/a').key, 'good/a')
  const snapshot = pool.snapshot()
  assert.equal(snapshot.providerErrors.length, 1)
  assert.equal(snapshot.providerErrors[0].id, 'broken')
})

test('持久化状态在重建池后恢复（失败计数 / 冷却 / 屏蔽）', async () => {
  const seed = {
    'p/m': {
      failCount: 2,
      cooldownUntil: 9_999_999_999_999,
      nextProbeAt: 0,
      health: HEALTH.cooling,
      hiddenFromPicker: true,
      lastProbe: { at: 1, verdict: 'throttled' }
    }
  }
  const llm = createFakeLlm({ models: { p: ['m'] } })
  const config = normalizeConfig({})
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(seed), logger })
  await pool.reload()

  const entry = pool.get('p/m')
  assert.equal(entry.failCount, 2)
  assert.equal(entry.health, HEALTH.cooling)
  assert.equal(entry.hiddenFromPicker, true)
  assert.equal(entry.lastProbe.verdict, 'throttled')
})

test('markProbe 写回状态、持久化并通知订阅者', async () => {
  const llm = createFakeLlm({ models: { 'our-free-model': ['a'] } })
  const config = normalizeConfig({})
  const store = createFakeStore()
  const pool = createPool({ ctx: { llm }, config, store, logger })
  await pool.reload()

  /** @type {number} */
  let notified = 0
  const unsubscribe = pool.subscribe(() => {
    notified += 1
  })

  pool.markProbe('our-free-model/a', 'throttled', { at: 1_000, latencyMs: 30 })
  const entry = pool.get('our-free-model/a')
  assert.equal(entry.health, HEALTH.degraded)
  assert.equal(entry.failCount, 1)
  assert.equal(entry.lastProbe.verdict, 'throttled')
  assert.equal(notified, 1)
  assert.equal(store.models['our-free-model/a'].failCount, 1)

  pool.markSuccess('our-free-model/a', 2_000)
  assert.equal(pool.get('our-free-model/a').health, HEALTH.available)
  assert.equal(pool.get('our-free-model/a').failCount, 0)

  unsubscribe()
  pool.markProbe('our-free-model/a', 'timeout', { at: 3_000 })
  assert.equal(notified, 2)
})

test('屏蔽判定与可见计数：结构性失效计入屏蔽，唯一可用项仍可数', async () => {
  const llm = createFakeLlm({ models: { 'our-free-model': ['a', 'b'] } })
  const config = normalizeConfig({ cooldown: { baseMs: 1_000, maxMs: 60_000, hideAfterMs: 5_000, deadFailCount: 3 } })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()

  assert.equal(pool.visibleCountFor('our-free-model'), 2)
  pool.markProbe('our-free-model/a', 'auth', { at: Date.now() })
  assert.equal(pool.shouldHide('our-free-model', 'a'), true)
  assert.equal(pool.visibleCountFor('our-free-model'), 1)
  assert.equal(pool.shouldHide('our-free-model', 'zzz'), false)
})

test('并发 reload 合并为一次宿主枚举', async () => {
  const llm = createFakeLlm({ models: { p: ['a', 'b'] } })
  const config = normalizeConfig({})
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })

  const first = pool.reload()
  const second = pool.reload()
  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(llm.calls.listProviders, 1)
})

test('llm 服务缺失时 reload 明确报错', async () => {
  const config = normalizeConfig({})
  const pool = createPool({ ctx: {}, config, store: createFakeStore(), logger })
  await assert.rejects(() => pool.reload(), /llm\.listProviders 不可用/)
})
