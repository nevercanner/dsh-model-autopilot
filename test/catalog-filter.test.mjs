/**
 * 模型选择界面动态屏蔽的测试。
 *
 * 断言重点是三条容易被后续改动破坏的性质：
 *   - 失效条目不再出现在 listModels 结果里，恢复后自动回来；
 *   - 虚拟 provider `autopilot` 永远不被隐藏（它是入口，不是候选）；
 *   - 池状态变化会触发一次 emitAdaptersUpdated（界面据此重拉目录）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalogFilter } from '../src/catalog-filter/index.js'
import { filterModels } from '../src/catalog-filter/visibility.js'
import { normalizeConfig } from '../src/config.js'
import { AUTOPILOT_PROVIDER } from '../src/autopilot.js'
import { createPool } from '../src/pool/pool.js'

const logger = { info() {}, warn() {} }

/** 可变的屏蔽集合，模拟池的 shouldHide。 */
function createFakePool() {
  const hidden = new Set()
  const listeners = new Set()
  return {
    hidden,
    shouldHide(provider, model) {
      return hidden.has(`${provider}/${model}`)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    trigger() {
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size
  }
}

/** 模拟宿主：未知 provider 抛 NO_ADAPTER（verify 依赖这一点）。 */
function createFakeLlm(modelsByProvider) {
  return {
    emits: 0,
    calls: 0,
    async listModels(provider) {
      this.calls += 1
      const models = modelsByProvider[provider]
      if (!models) throw Object.assign(new Error(`no adapter registered for provider "${provider}"`), {
        code: 'NO_ADAPTER'
      })
      return models.map((id) => ({ provider, id, name: id }))
    },
    emitAdaptersUpdated() {
      this.emits += 1
    }
  }
}

function setup(extraConfig = {}) {
  const llm = createFakeLlm({
    'our-free-model': ['free-ok', 'free-dead', 'free-cooling'],
    [AUTOPILOT_PROVIDER]: ['auto'],
    magpie: ['paid-x']
  })
  const pool = createFakePool()
  const config = normalizeConfig({ catalogFilter: { refreshDebounceMs: 0, ...extraConfig } })
  const filter = createCatalogFilter({ ctx: { llm }, pool, config, logger })
  return { llm, pool, config, filter }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

test('失效条目被隐藏，健康条目保留', async () => {
  const { llm, pool, filter } = setup()
  filter.install()

  pool.hidden.add('our-free-model/free-dead')
  const models = await llm.listModels('our-free-model')

  assert.deepEqual(models.map((item) => item.id), ['free-ok', 'free-cooling'])
  assert.equal(filter.stats().hidden, 1)
  filter.dispose()
})

test('恢复后自动重新可见', async () => {
  const { llm, pool, filter } = setup()
  filter.install()

  pool.hidden.add('our-free-model/free-dead')
  assert.equal((await llm.listModels('our-free-model')).length, 2)

  pool.hidden.delete('our-free-model/free-dead')
  const models = await llm.listModels('our-free-model')
  assert.deepEqual(models.map((item) => item.id), ['free-ok', 'free-dead', 'free-cooling'])
  filter.dispose()
})

test('autopilot 虚拟 provider 永不被隐藏（即使池误判）', async () => {
  const { llm, pool, filter } = setup()
  filter.install()

  // 即使屏蔽集合里有它，也必须原样保留。
  pool.hidden.add(`${AUTOPILOT_PROVIDER}/auto`)
  const models = await llm.listModels(AUTOPILOT_PROVIDER)
  assert.deepEqual(models.map((item) => item.id), ['auto'])

  // 纯函数层同样保证。
  const kept = filterModels(AUTOPILOT_PROVIDER, [{ id: 'auto' }], { shouldHide: () => true })
  assert.equal(kept.length, 1)
  filter.dispose()
})

test('某个 provider 全被隐藏时原样返回，避免整组消失', async () => {
  const { llm, pool, filter } = setup()
  filter.install()

  pool.hidden.add('magpie/paid-x')
  const models = await llm.listModels('magpie')
  assert.deepEqual(models.map((item) => item.id), ['paid-x'])
  assert.equal(filter.stats().hidden, 0, '整组被过滤时不计入隐藏数')
  filter.dispose()
})

test('池状态变化触发一次 emitAdaptersUpdated（并合并多次变化）', async () => {
  const { llm, pool, filter } = setup()
  filter.install()

  pool.trigger()
  pool.trigger()
  pool.trigger()
  await tick()

  assert.equal(llm.emits, 1, '同窗口内的多次变化应合并成一次刷新')
  assert.equal(filter.stats().emits, 1)
  filter.dispose()
})

test('verify 证明实例覆写真的生效', async () => {
  const { llm, filter } = setup()
  filter.install()
  const ok = await filter.verify()
  assert.equal(ok, true)
  // 不存在的 provider 抛 NO_ADAPTER，但 wrapper 已经计数 —— 说明覆写生效。
  assert.ok(filter.stats().calls >= 1)
  filter.dispose()
})

test('重复 install 只包一层，dispose 后恢复原实现', async () => {
  const { llm, pool, filter } = setup()
  filter.install()
  filter.install() // 幂等：热重载可能重复进入

  pool.hidden.add('our-free-model/free-dead')
  assert.equal((await llm.listModels('our-free-model')).length, 2, '仍然只过滤一次')

  filter.dispose()
  filter.dispose() // 计数归零后不重复还原

  pool.hidden.add('our-free-model/free-ok')
  const models = await llm.listModels('our-free-model')
  assert.equal(models.length, 3, '卸载后不再过滤')
  assert.equal(filter.stats().calls, 1, '卸载后的调用不该再经过 wrapper（stats.calls 不再增长）')
  assert.equal(llm.calls, 2, '宿主原函数仍然被调用，说明还原成的是原实现')
  assert.equal(pool.listenerCount(), 0, '订阅要解掉')
})

test('过滤抛错时放行原列表，目录不整体不可用', async () => {
  const { llm, pool, filter } = setup()
  filter.install()

  // 池侧抛错：wrapper 应吞掉异常并返回宿主原始列表。
  pool.shouldHide = () => {
    throw new Error('pool exploded')
  }

  const models = await llm.listModels('our-free-model')
  assert.equal(models.length, 3, '过滤失败时目录必须仍然可用')
  assert.equal(filter.stats().errors, 1)
  filter.dispose()
})

// ── 池的视野必须是全量 ───────────────────────────────────────────────────────

test('池重新枚举走未过滤目录：被隐藏的条目不会从池里消失', async () => {
  const modelsByProvider = { 'our-free-model': ['free-ok', 'free-dead'] }
  const llm = {
    listProviders: () => [{ id: 'our-free-model', name: 'Our Free Model' }],
    async listModels(provider) {
      return (modelsByProvider[provider] ?? []).map((id) => ({ provider, id, name: id }))
    },
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model }
    },
    emitAdaptersUpdated() {}
  }
  const fakeStore = {
    model: () => undefined,
    setModel() {},
    setMeta() {},
    get: () => ({ models: {} }),
    flushSync() {},
    dispose() {}
  }
  const config = normalizeConfig({ catalogFilter: { refreshDebounceMs: 0 } })
  const pool = createPool({ ctx: { llm }, config, store: fakeStore, logger })
  await pool.reload()
  assert.equal(pool.all().length, 2)

  const filter = createCatalogFilter({ ctx: { llm }, pool, config, logger })
  filter.install()
  pool.setRawListModels((provider) => filter.rawListModels(provider))

  // 让一个条目变 dead：界面应当隐藏它，但池必须仍然看得见它。
  pool.markProbe('our-free-model/free-dead', 'auth', { at: Date.now() })
  assert.equal(pool.shouldHide('our-free-model', 'free-dead'), true)

  await pool.reload()
  assert.equal(pool.all().length, 2, '池仍应枚举到被隐藏的条目')
  assert.ok(pool.get('our-free-model/free-dead'), '隐藏不等于从池里删除（否则永远无法恢复）')

  // 界面侧确实看不到它
  const visible = await llm.listModels('our-free-model')
  assert.deepEqual(visible.map((item) => item.id), ['free-ok'])

  filter.dispose()
  assert.equal(pool.all().length, 2)
  await pool.reload()
  assert.equal(pool.all().length, 2, '卸载后池继续正常枚举')
})
