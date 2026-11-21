/**
 * 虚拟 provider 的注册与自愈。
 *
 * 这条路径的失败症状是用户可见的硬错误：
 *   `no adapter registered for provider "autopilot"`
 * 根因是热重载时旧 fiber 释放路由、新 fiber 撞名，而原来的跨 tick 重试 timer
 * 会随 fiber 一起被清理 → adapter 永久缺失。
 *
 * 所以这里用假的 ctx.llm 精确复现「旧 fiber 占着 → 释放 → 新 fiber 接管」，
 * 断言三道保险都真的起作用。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installAutopilotProvider } from '../src/index.js'

const logger = { info() {}, warn() {} }
const SLOT = '__DSH_MODEL_AUTOPILOT_ADAPTER__'

/** 清掉跨用例残留的注册槽位（同一进程内多个用例共用 globalThis）。 */
function resetSlot() {
  const holder = /** @type {any} */ (globalThis)
  const slot = holder[SLOT]
  if (slot?.releaseTimer) clearTimeout(slot.releaseTimer)
  delete holder[SLOT]
}

/**
 * 假宿主：模拟 registerAdapter 的 DUPLICATE_ADAPTER 与路由释放。
 *
 * `initiallyOccupied: true` = 路由**已被旧 fiber 占用**：注册时直接抛
 * DUPLICATE_ADAPTER，直到调用 releaseOccupied() 才腾出位置。
 * @param {{ initiallyOccupied?: boolean }} [options]
 */
function createFakeHost(options = {}) {
  /** @type {Map<string, any>} */
  const routes = new Map()
  /** @type {Set<Function>} */
  const listeners = new Set()
  /** @type {Array<() => void>} */
  const disposers = []

  if (options.initiallyOccupied === true) {
    routes.set('autopilot', { id: 'old-fiber-adapter' })
  }

  const llm = {
    listProviders: () => [...routes.keys()].map((id) => ({ id, name: id })),
    registerAdapter(ids, adapter) {
      for (const id of ids) {
        if (routes.has(id)) {
          const error = new Error(`an adapter for provider "${id}" is already registered`)
          error.code = 'DUPLICATE_ADAPTER'
          throw error
        }
      }
      for (const id of ids) routes.set(id, adapter)
      let released = false
      return () => {
        if (released) return
        released = true
        for (const id of ids) routes.delete(id)
      }
    },
    emitAdaptersUpdated() {
      for (const listener of listeners) listener()
    }
  }

  const ctx = {
    llm,
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(name, listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }

  return {
    ctx,
    llm,
    routes,
    /** 旧 fiber 释放路由（热重载时的真实动作）。 */
    releaseOccupied() {
      routes.delete('autopilot')
    },
    releaseAll() {
      for (const dispose of disposers.splice(0)) dispose()
    }
  }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

test('首次注册即成功', async () => {
  resetSlot()
  const host = createFakeHost()
  const control = installAutopilotProvider(host.ctx, { id: 'adapter' }, logger)
  await tick(30)
  assert.equal(host.llm.listProviders().some((p) => p.id === 'autopilot'), true)
  assert.equal(control.isRegistered(), true)
  host.releaseAll()
})

test('路由被占用时会重试，占用解除后自动接管', async () => {
  resetSlot()
  const host = createFakeHost({ initiallyOccupied: true })
  const control = installAutopilotProvider(host.ctx, { id: 'adapter' }, logger)

  // 旧 fiber 还占着：注册被拒，路由在，但**不是我们的**
  assert.equal(control.isPresent(), true, '旧 fiber 仍占着路由')
  assert.equal(control.isRegistered(), false, '我们还没注册上')

  // 旧 fiber 释放路由 → 退避重试应自动接管
  host.releaseOccupied()
  await tick(200)
  assert.equal(control.isRegistered(), true, '占用解除后应自动接管')
  host.releaseAll()
})

test('目录变更事件能触发接管（热重载场景）', async () => {
  resetSlot()
  const host = createFakeHost({ initiallyOccupied: true })
  const control = installAutopilotProvider(host.ctx, { id: 'adapter' }, logger)
  await tick(20)
  assert.equal(control.isRegistered(), false, '还没接管')

  // 模拟旧 fiber 释放路由并广播目录变更
  host.releaseOccupied()
  host.llm.emitAdaptersUpdated()
  await tick(60)
  assert.equal(control.isRegistered(), true, '事件应触发立即接管')
  host.releaseAll()
})

test('卸载后路由延迟释放，最终不残留', async () => {
  resetSlot()
  const host = createFakeHost()
  const control = installAutopilotProvider(host.ctx, { id: 'adapter' }, logger)
  await tick(30)
  assert.equal(host.llm.listProviders().some((p) => p.id === 'autopilot'), true)

  host.releaseAll()
  // 延迟释放：给继任者留 1.5s 接管窗口（热重载时路由不能消失）
  assert.equal(host.llm.listProviders().some((p) => p.id === 'autopilot'), true, '销毁瞬间不该立即释放')
  await tick(1_700)
  assert.equal(host.llm.listProviders().some((p) => p.id === 'autopilot'), false, '无人接管时最终要释放')
})
