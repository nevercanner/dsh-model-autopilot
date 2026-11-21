/**
 * 装配冒烟：`apply()` 必须能完整跑完。
 *
 * 为什么单独立一条：所有单测都是直接 import 子模块，**没有一条覆盖 apply 本身**，
 * 所以 apply 里一个语法级错误（例如 ASI 把 `(globalThis)` 当成上一行的函数调用）
 * 就能让插件 fiber 变 failed —— 宿主上表现为面板 404、API 全挂，而测试全绿。
 * 这条用例就是补这个盲区。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, currentService, installAutopilotProvider } from '../src/index.js'

const logger = { info() {}, warn() {}, error() {}, debug() {} }

const PROVIDERS = {
  'our-free-model': ['free-a'],
  magpie: ['paid-x']
}

/** 最小 cordis ctx：够 apply 跑完全部装配步骤。 */
function createCtx() {
  /** @type {Array<{ routes: string[], adapter: any }>} */
  const registrations = []
  const llm = {
    listProviders: () => Object.keys(PROVIDERS).map((id) => ({ id, name: id })),
    listModels: async (provider) =>
      (PROVIDERS[provider] ?? []).map((id) => ({ provider, id, name: `${id} · ${provider}` })),
    async resolveModelInfo(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 128_000 }, inputModalities: ['text'] }
    },
    stream(options) {
      return (async function* () {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    registerAdapter(routes, adapter) {
      const handle = () => {}
      handle.replace = () => {}
      registrations.push({ routes, adapter })
      return handle
    },
    emitAdaptersUpdated() {}
  }

  /** @type {Array<() => void>} */
  const disposers = []
  const ctx = {
    logger,
    llm,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on() {
      return () => {}
    },
    inject(_deps, callback) {
      return () => {}
    },
    get(name) {
      if (name === 'sessionController') {
        return { selectModel: async () => ({ selected: { provider: 'autopilot', model: 'auto' } }) }
      }
      return undefined
    }
  }
  return { ctx, registrations, dispose: () => disposers.splice(0).forEach((fn) => fn()) }
}

test('apply() 能完整装配（回归：装配期语法/引用错误会让面板 404）', async () => {
  // 清掉可能残留的注册槽位
  const holder = /** @type {any} */ (globalThis)
  if (holder.__DSH_MODEL_AUTOPILOT_ADAPTER__?.releaseTimer) {
    clearTimeout(holder.__DSH_MODEL_AUTOPILOT_ADAPTER__.releaseTimer)
  }
  delete holder.__DSH_MODEL_AUTOPILOT_ADAPTER__
  delete holder.__DSH_MODEL_AUTOPILOT_RESOLVE__

  const { ctx, registrations, dispose } = createCtx()

  await apply(ctx, { probe: { startup: false }, aihot: { quotaEnabled: false } })

  const service = currentService()
  assert.ok(service, 'apply 之后应能拿到 service 实例')
  // 虚拟 provider 已注册
  assert.ok(
    registrations.some((item) => item.routes.includes('autopilot')),
    'apply 必须注册 autopilot 虚拟 provider'
  )
  // 核心服务都在
  for (const key of ['pool', 'scheduler', 'failover', 'autopilot', 'prober']) {
    assert.ok(service[key], `service.${key} 应存在`)
  }
  // 池子建好了
  assert.ok(service.pool.all().length > 0, '池里应有模型条目')

  dispose()
})

test('installAutopilotProvider 的返回值可解构，且不会把下一行当成调用', async () => {
  const holder = /** @type {any} */ (globalThis)
  if (holder.__DSH_MODEL_AUTOPILOT_ADAPTER__?.releaseTimer) {
    clearTimeout(holder.__DSH_MODEL_AUTOPILOT_ADAPTER__.releaseTimer)
  }
  delete holder.__DSH_MODEL_AUTOPILOT_ADAPTER__

  /** @type {Map<string, any>} */
  const routes = new Map()
  const llm = {
    listProviders: () => [...routes.keys()].map((id) => ({ id, name: id })),
    registerAdapter(ids, adapter) {
      for (const id of ids) routes.set(id, adapter)
      return () => {
        for (const id of ids) routes.delete(id)
      }
    }
  }
  const ctx = { llm, effect: (fn) => fn(), on: () => () => {} }

  const control = installAutopilotProvider(ctx, { id: 'a' }, logger)
  assert.equal(typeof control.status, 'function', '返回值必须是对象，不能是函数调用结果')
  assert.equal(control.status().registered, true)
})
