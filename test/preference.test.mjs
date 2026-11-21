/**
 * 首选 provider（锁定）的持久化与校验。
 *
 * 这个开关决定「谁排第一」：用户给某条通道充了限时额度时，需要让它压过免费优先。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPreference } from '../src/preference.js'

const logger = { info() {}, warn() {} }

function createTempFile(name = 'preference.json') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pref-'))
  return path.join(dir, name)
}

function createFakePool(providers) {
  return {
    all: () => providers.map((provider) => ({ provider, model: 'm', key: `${provider}/m` }))
  }
}

test('默认没有首选（走免费优先）', () => {
  const preference = createPreference({
    file: createTempFile(),
    pool: createFakePool(['minimax-cn', 'our-free-model']),
    logger
  })
  assert.equal(preference.isPinned(), false)
  assert.deepEqual(preference.get(), { provider: null, model: null })
})

test('设置首选会落盘，重建后仍然生效', () => {
  const file = createTempFile()
  const pool = createFakePool(['minimax-cn', 'our-free-model'])

  const first = createPreference({ file, pool, logger })
  const result = first.set('minimax-cn')
  assert.equal(result.ok, true)
  assert.deepEqual(result.preference, { provider: 'minimax-cn', model: null })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { provider: 'minimax-cn', model: null })

  // 新实例（模拟热重载/重启）：从存档恢复
  const second = createPreference({ file, pool, logger })
  assert.equal(second.isPinned(), true)
  assert.equal(second.get().provider, 'minimax-cn')
})

test('可以精确到模型', () => {
  const preference = createPreference({
    file: createTempFile(),
    pool: createFakePool(['minimax-cn']),
    logger
  })
  preference.set('minimax-cn', 'MiniMax-M3')
  assert.deepEqual(preference.get(), { provider: 'minimax-cn', model: 'MiniMax-M3' })
})

test('拒绝不存在的 provider（拼错名字要有明确反馈）', () => {
  const preference = createPreference({
    file: createTempFile(),
    pool: createFakePool(['minimax-cn']),
    logger
  })
  const result = preference.set('minimax-cn-typo')
  assert.equal(result.ok, false)
  assert.match(result.error, /不在模型池里/)
  assert.equal(preference.isPinned(), false, '失败的设置不能留下半截状态')
})

test('取消首选会清空并落盘', () => {
  const file = createTempFile()
  const preference = createPreference({ file, pool: createFakePool(['minimax-cn']), logger })
  preference.set('minimax-cn')
  const result = preference.set(null)
  assert.equal(result.ok, true)
  assert.deepEqual(preference.get(), { provider: null, model: null })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { provider: null, model: null })
})

test('首选设置独立成文件：不会被 pool-state.json 的旧状态覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pref-'))
  const file = path.join(dir, 'preference.json')
  const pool = createFakePool(['minimax-cn'])
  createPreference({ file, pool, logger }).set('minimax-cn')

  // 模拟另一个实例把 pool-state.json 写成陈旧内容
  const stateFile = path.join(dir, 'pool-state.json')
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, updatedAt: 1, models: {} }))

  const reloaded = createPreference({ file, pool, logger })
  assert.equal(reloaded.get().provider, 'minimax-cn', '首选设置不受池存档影响')
})
