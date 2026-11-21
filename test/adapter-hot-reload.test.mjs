/**
 * 虚拟 provider 跨热重载存活。
 *
 * 症状：宿主报 `no adapter registered for provider "autopilot"` 并回退默认模型。
 * 病根：热重载时旧 fiber 释放路由、新 fiber 撞名，中间有一段窗口路由不存在；
 *       任何落在这段窗口里的请求都硬失败。
 *
 * 所以这里测的不是「失败后能不能补」，而是「路由从头到尾有没有消失过」——
 * 每销毁一代、启动下一代，都在**同一 tick 内**检查路由是否还在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { installAutopilotProvider } from '../src/index.js'

const logger = { info() {}, warn() {} }
const SLOT = '__DSH_MODEL_AUTOPILOT_ADAPTER__'

/** 假宿主：单例路由表 + adapter 目录事件。 */
function createHost() {
  /** @type {Map<string, any>} */
  const routes = new Map()
  /** @type {Set<Function>} */
  const listeners = new Set()

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

  /**
   * 造一代 fiber。dispose() 触发该代注册的所有清理函数。
   */
  function createFiber() {
    /** @type {Array<() => void>} */
    const disposers = []
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
      dispose() {
        for (const dispose of disposers.splice(0)) dispose()
      }
    }
  }

  return { llm, routes, createFiber }
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

/** 每个用例前清掉跨测试的全局槽位。 */
function resetSlot() {
  const holder = /** @type {any} */ (globalThis)
  const slot = holder[SLOT]
  if (slot?.releaseTimer) clearTimeout(slot.releaseTimer)
  delete holder[SLOT]
}

test('热重载：销毁旧代并启动新代，路由全程不消失', async () => {
  resetSlot()
  const host = createHost()
  const registered = () => host.llm.listProviders().some((p) => p.id === 'autopilot')

  // 第 1 代
  const fiber1 = host.createFiber()
  const control1 = installAutopilotProvider(fiber1.ctx, { id: 'adapter-1' }, logger)
  assert.equal(registered(), true, '第 1 代注册后路由存在')
  assert.equal(control1.isRegistered(), true)

  // 热重载：先销毁旧代，**立刻**启动新代（这是真实时序）
  fiber1.dispose()
  const fiber2 = host.createFiber()
  const control2 = installAutopilotProvider(fiber2.ctx, { id: 'adapter-2' }, logger)

  // 关键断言：中间没有窗口
  assert.equal(registered(), true, '重载后路由必须仍然存在（不能有窗口）')
  assert.equal(control2.isRegistered(), true, '新代应接管而不是重新注册')

  // 等过延迟释放的时限，路由仍然在（说明老 handle 没被误释放）
  await tick(1_700)
  assert.equal(registered(), true, '延迟释放应被继任者取消，路由仍在')

  fiber2.dispose()
})

test('连续多代重载，路由不消失也不撞名', async () => {
  resetSlot()
  const host = createHost()
  const registered = () => host.llm.listProviders().some((p) => p.id === 'autopilot')

  let fiber = host.createFiber()
  installAutopilotProvider(fiber.ctx, { id: 'adapter-0' }, logger)
  assert.equal(registered(), true)

  for (let generation = 1; generation <= 4; generation += 1) {
    fiber.dispose()
    fiber = host.createFiber()
    installAutopilotProvider(fiber.ctx, { id: `adapter-${generation}` }, logger)
    assert.equal(registered(), true, `第 ${generation} 代重载后路由必须还在`)
  }
  fiber.dispose()
})

test('真正卸载（无继任者）时路由被释放', async () => {
  resetSlot()
  const host = createHost()
  const registered = () => host.llm.listProviders().some((p) => p.id === 'autopilot')

  const fiber = host.createFiber()
  installAutopilotProvider(fiber.ctx, { id: 'adapter' }, logger)
  assert.equal(registered(), true)

  // 只销毁、没有下一代 → 延迟释放生效
  fiber.dispose()
  await tick(1_700)
  assert.equal(registered(), false, '无继任者时必须释放，不能泄漏路由')
})

test('卸载后重新安装能正常注册（槽位已清空）', async () => {
  resetSlot()
  const host = createHost()
  const registered = () => host.llm.listProviders().some((p) => p.id === 'autopilot')

  const fiber1 = host.createFiber()
  installAutopilotProvider(fiber1.ctx, { id: 'a1' }, logger)
  fiber1.dispose()
  await tick(1_700)
  assert.equal(registered(), false)

  const fiber2 = host.createFiber()
  const control2 = installAutopilotProvider(fiber2.ctx, { id: 'a2' }, logger)
  assert.equal(registered(), true, '重新安装应能注册')
  assert.equal(control2.isRegistered(), true)
  fiber2.dispose()
})

test('路由被外部占用时会重试接管', async () => {
  resetSlot()
  const host = createHost()
  // 外部先占住
  host.llm.registerAdapter(['autopilot'], { id: 'external' })

  const fiber = host.createFiber()
  const control = installAutopilotProvider(fiber.ctx, { id: 'ours' }, logger)
  assert.equal(control.isRegistered(), false, '被占用时还没注册上')

  // 外部释放
  host.routes.delete('autopilot')
  host.llm.emitAdaptersUpdated()
  await tick(80)
  assert.equal(control.isRegistered(), true, '外部释放后应接管')
  fiber.dispose()
})
