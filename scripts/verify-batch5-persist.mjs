/**
 * 批次 5 验收。
 *
 * 1. 热重载：新 fiber 读到 failCount=26 的条目 → **继承** failCount（保留批次 1-4
 *    的复检基础），但旧 fiber dispose 不会用旧快照覆盖新 fiber 已恢复的状态。
 * 2. catalogFilter 关闭：markFailure 后 hiddenFromPicker 仍为 false，
 *    且存档里不出现 hiddenFromPicker:true。
 * 3. catalogFilter 开启：同样操作后 hiddenFromPicker 正确写 true。
 * 4. 存量迁移：存档里已有的 hiddenFromPicker:true，在关闭状态下启动被清为 false。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createJsonStore } from '../src/store.js'
import { createPool } from '../src/pool/pool.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} }
let failed = 0

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch5-'))
  return path.join(dir, 'pool-state.json')
}

const MODELS = { 'our-free-model': ['a', 'b', 'c'] }
function makeLlm() {
  return {
    listProviders: () => [{ id: 'our-free-model', name: 'free' }],
    listModels: async () => MODELS['our-free-model'].map((id) => ({ provider: 'our-free-model', id, name: id })),
    resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m })
  }
}

// ── 验收 1：热重载继承 failCount（不丢），但旧代不覆盖新代 ──────────────────
{
  const file = tmpFile()
  // 预置：一条 failCount=26 / dead 的存档
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: 1,
        updatedAt: Date.now() - 1000,
        models: {
          'our-free-model/a': {
            failCount: 26,
            cooldownUntil: Date.now() + 3600_000,
            nextProbeAt: 0,
            health: 'dead',
            hiddenFromPicker: false,
            lastProbe: { at: Date.now() - 7200_000, verdict: 'throttled', latencyMs: 100 }
          }
        }
      },
      null,
      2
    )
  )

  // 第 1 代：读盘 → 继承 failCount=26
  const store1 = createJsonStore(file, { logger })
  const pool1 = createPool({ ctx: { llm: makeLlm() }, config: normalizeConfig({}), store: store1, logger })
  await pool1.reload()
  const inherited = pool1.get('our-free-model/a')
  const inheritedOk = inherited?.failCount === 26 && inherited?.health === 'dead'

  // 第 2 代（模拟热重载后的新 fiber）：新条目成功 → 恢复 available
  const store2 = createJsonStore(file, { logger })
  const pool2 = createPool({ ctx: { llm: makeLlm() }, config: normalizeConfig({}), store: store2, logger })
  await pool2.reload()
  pool2.markSuccess('our-free-model/a')
  // 新代先落盘（真实场景里 200ms 延迟内会 flush；这里显式同步，避免测试时序干扰）
  store2.flushSync()

  // 第 1 代 dispose：不能把这个旧的 failCount=26 写回去覆盖
  store1.dispose()

  const afterDispose = JSON.parse(fs.readFileSync(file, 'utf8')).models['our-free-model/a']
  const notOverwritten = afterDispose.failCount === 0 && afterDispose.health === 'available'

  if (!(inheritedOk && notOverwritten)) failed += 1
  console.log(
    `${inheritedOk ? 'PASS' : 'FAIL'}  [1a] 热重载继承 failCount：读到 failCount=${inherited?.failCount}, health=${inherited?.health}`
  )
  console.log(
    `${notOverwritten ? 'PASS' : 'FAIL'}  [1b] 旧代 dispose 不覆盖新代：存档里 failCount=${afterDispose.failCount}, health=${afterDispose.health}`
  )
}

// ── 验收 2：catalogFilter 关闭 → 不写 hiddenFromPicker:true ────────────────
{
  const file = tmpFile()
  const config = normalizeConfig({ catalogFilter: { enabled: false } })
  const store = createJsonStore(file, { logger })
  const pool = createPool({ ctx: { llm: makeLlm() }, config, store, logger })
  await pool.reload()
  pool.markFailure('our-free-model/a', 'auth')
  store.flushSync()

  const entry = pool.get('our-free-model/a')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')).models['our-free-model/a']
  const ok = entry.hiddenFromPicker === false && disk?.hiddenFromPicker !== true
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  [2] catalogFilter=off：内存 hidden=${entry.hiddenFromPicker}，存档 hidden=${disk?.hiddenFromPicker}（health=${entry.health}）`
  )
}

// ── 验收 3：catalogFilter 开启 → 正常写 true ───────────────────────────────
{
  const file = tmpFile()
  const config = normalizeConfig({ catalogFilter: { enabled: true } })
  const store = createJsonStore(file, { logger })
  const pool = createPool({ ctx: { llm: makeLlm() }, config, store, logger })
  await pool.reload()
  pool.markFailure('our-free-model/a', 'auth')
  store.flushSync()

  const entry = pool.get('our-free-model/a')
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')).models['our-free-model/a']
  const ok = entry.hiddenFromPicker === true && disk?.hiddenFromPicker === true
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  [3] catalogFilter=on：内存 hidden=${entry.hiddenFromPicker}，存档 hidden=${disk?.hiddenFromPicker}（health=${entry.health}）`
  )
}

// ── 验收 4：存量 hiddenFromPicker:true 在关闭状态下被清掉 ──────────────────
{
  const file = tmpFile()
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: 1,
        updatedAt: Date.now(),
        models: {
          'our-free-model/a': { failCount: 3, cooldownUntil: 0, nextProbeAt: 0, health: 'dead', hiddenFromPicker: true },
          'our-free-model/b': { failCount: 3, cooldownUntil: 0, nextProbeAt: 0, health: 'dead', hiddenFromPicker: true },
          'our-free-model/c': { failCount: 0, cooldownUntil: 0, nextProbeAt: 0, health: 'available', hiddenFromPicker: false }
        }
      },
      null,
      2
    )
  )
  const store = createJsonStore(file, { logger })
  const cleared = store.resetHiddenFromPicker('test')
  store.flushSync()
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')).models
  const ok = cleared === 2 && disk['our-free-model/a'].hiddenFromPicker === false && disk['our-free-model/b'].hiddenFromPicker === false
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  [4] 存量迁移：清理 ${cleared} 条，存档 hidden=${disk['our-free-model/a'].hiddenFromPicker}/${disk['our-free-model/b'].hiddenFromPicker}`)
}

console.log()
console.log(failed === 0 ? '批次 5 验收全部通过' : `${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
