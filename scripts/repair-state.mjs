#!/usr/bin/env node
/**
 * 迁移存量池状态：把「批次 1-4 修复之前被误判死」的条目修回来。
 *
 * 背景
 * ────
 * 早期版本靠 failCount 次数判死：一条通道额度用完后被反复计数，最后焊死在
 * dead，之后再也不会被探测 —— 用户看到「明明有 100+ 免费模型，池里只剩 2 个
 * available」。批次 1 改成了「瞬时失败只进冷却、永不靠次数判死」，但**存量数据**
 * 仍带着旧的 failCount / health / hiddenFromPicker 继续生效。
 *
 * 这个脚本按判决类型把旧数据分两类：
 *   - 结构性失效（auth / region-blocked / retired）→ 保持 dead，这是正确的
 *   - 瞬时失效（throttled / timeout / unavailable / empty / unknown）→ 修回 cooling
 *
 * 用法
 * ────
 *   node scripts/repair-state.mjs              # dry-run，只打印将要做什么
 *   node scripts/repair-state.mjs --apply      # 实际写盘（会先备份）
 *   node scripts/repair-state.mjs --file <p>   # 指定存档路径
 *   node scripts/repair-state.mjs --apply --file <p>
 *
 * 环境变量 DSH_HOME 决定默认位置：$DSH_HOME/model-autopilot/pool-state.json
 *
 * 幂等：跑两次结果一致（第二次迁移条数为 0）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 结构性判决：保持 dead，不迁移。 */
const STRUCTURAL = new Set(['auth', 'region-blocked', 'retired'])

/** 瞬时判决：被判 dead 就是误判，修回 cooling。 */
const TRANSIENT = new Set(['throttled', 'timeout', 'unavailable', 'empty', 'unknown'])

/** nextProbeAt 过期多久算「早该复检了」。 */
const STALE_MS = 24 * 60 * 60_000

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ apply: boolean, file: string | null, help: boolean }} */
  const out = { apply: false, file: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') out.apply = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg === '--file') {
      out.file = argv[index + 1] ?? null
      index += 1
    } else if (arg.startsWith('--file=')) {
      out.file = arg.slice('--file='.length)
    }
  }
  return out
}

/** 默认存档位置。 */
function defaultFile() {
  const home = process.env.DSH_HOME
  const base = home && home.trim() !== '' ? home.trim().replace(/[\\/]+$/, '') : path.join(process.env.HOME ?? '.', '.dsh')
  return path.join(base, 'model-autopilot', 'pool-state.json')
}

const USAGE = `用法：
  node scripts/repair-state.mjs                  dry-run（默认，不写盘）
  node scripts/repair-state.mjs --apply          实际写入（先备份）
  node scripts/repair-state.mjs --file <path>    指定存档路径
环境变量：DSH_HOME 决定默认位置`

/**
 * 计算迁移计划（纯函数，便于测试与幂等核对）。
 *
 * @param {Record<string, any>} models
 * @param {number} now
 * @returns {{ changes: Array<{ key: string, from: any, to: any, reason: string }>, stats: any }}
 */
export function planRepair(models, now = Date.now()) {
  /** @type {Array<{ key: string, from: any, to: any, reason: string }>} */
  const changes = []
  /** @type {Record<string, number>} */
  const byVerdict = {}
  let migratedTransient = 0
  let keptStructural = 0
  let unknownDead = 0
  let hiddenCleared = 0
  let staleProbeReset = 0

  for (const [key, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object') continue
    const verdict = model.lastProbe?.verdict ?? null
    const health = model.health
    byVerdict[verdict ?? '(null)'] = (byVerdict[verdict ?? '(null)'] ?? 0) + 1

    /** @type {Record<string, any>} */
    const patch = {}
    /** @type {string[]} */
    const reasons = []

    if (health === 'dead') {
      if (verdict !== null && STRUCTURAL.has(verdict)) {
        // 结构性失效：这是正确状态，保持。
        keptStructural += 1
      } else if (verdict !== null && TRANSIENT.has(verdict)) {
        // 批次 1 之前的误判：瞬时故障被次数规则焊死。
        patch.health = 'cooling'
        patch.failCount = 0
        patch.cooldownUntil = now
        patch.hiddenFromPicker = false
        migratedTransient += 1
        reasons.push(`${verdict} 属瞬时失效，不该判死`)
      } else {
        // 状态不明的死条目（lastProbe 为 null，或探针说 ok 却被判死）：
        // 交给探针重新判定，而不是继续按 dead 处理。
        patch.health = 'unknown'
        patch.failCount = 0
        patch.cooldownUntil = 0
        patch.hiddenFromPicker = false
        unknownDead += 1
        reasons.push(verdict === null ? 'dead 但从未探过' : `dead 但 lastProbe=${verdict}，状态矛盾`)
      }
    }

    // 兜底：存量 hiddenFromPicker=true（批次 5 已有启动迁移，这里处理更早的存档）
    if (patch.hiddenFromPicker === undefined && model.hiddenFromPicker === true) {
      patch.hiddenFromPicker = false
      hiddenCleared += 1
      reasons.push('hiddenFromPicker 存量清理')
    }

    // 早该复检却没排上的
    const nextProbeAt = /** @type {number} */ (model.nextProbeAt ?? 0)
    const effectiveHealth = patch.health ?? health
    if (patch.nextProbeAt === undefined && effectiveHealth !== 'available' && nextProbeAt < now - STALE_MS) {
      patch.nextProbeAt = now
      staleProbeReset += 1
      reasons.push('nextProbeAt 过期超过 24h，立即安排复检')
    }

    if (Object.keys(patch).length > 0) {
      changes.push({
        key,
        from: { health, failCount: model.failCount, cooldownUntil: model.cooldownUntil, hiddenFromPicker: model.hiddenFromPicker },
        to: patch,
        reason: reasons.join('；')
      })
    }
  }

  const after = { ...models }
  for (const change of changes) after[change.key] = { ...after[change.key], ...change.to }

  const count = (map, predicate) => Object.values(map).filter(predicate).length

  return {
    changes,
    stats: {
      total: Object.keys(models).length,
      byVerdict,
      migratedTransient,
      keptStructural,
      unknownDead,
      hiddenCleared,
      staleProbeReset,
      before: {
        available: count(models, (m) => m?.health === 'available'),
        dead: count(models, (m) => m?.health === 'dead'),
        cooling: count(models, (m) => m?.health === 'cooling'),
        unknown: count(models, (m) => m?.health === 'unknown')
      },
      after: {
        available: count(after, (m) => m?.health === 'available'),
        dead: count(after, (m) => m?.health === 'dead'),
        cooling: count(after, (m) => m?.health === 'cooling'),
        unknown: count(after, (m) => m?.health === 'unknown')
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }
  const file = args.file ?? defaultFile()
  if (!fs.existsSync(file)) {
    console.error(`找不到存档：${file}`)
    process.exit(1)
  }

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`存档不是合法 JSON：${/** @type {any} */ (error)?.message}`)
    process.exit(1)
  }
  if (!raw || typeof raw !== 'object' || typeof raw.models !== 'object') {
    console.error('存档结构不符合预期（缺 models 字段）')
    process.exit(1)
  }

  const { changes, stats } = planRepair(raw.models, Date.now())

  console.log(`存档：${file}`)
  console.log(`模式：${args.apply ? 'APPLY（会写盘）' : 'DRY-RUN（不写盘）'}`)
  console.log('')
  console.log(`条目总数：${stats.total}`)
  console.log(`lastProbe.verdict 分布：${JSON.stringify(stats.byVerdict)}`)
  console.log('')
  console.log('迁移计划：')
  console.log(`  瞬时失效被误判死 → cooling/failCount=0：${stats.migratedTransient}`)
  console.log(`  状态不明的 dead → unknown：${stats.unknownDead}`)
  console.log(`  hiddenFromPicker 存量清理：${stats.hiddenCleared}`)
  console.log(`  nextProbeAt 过期重置：${stats.staleProbeReset}`)
  console.log(`  结构性失效保持 dead（正确，不动）：${stats.keptStructural}`)
  console.log('')
  console.log('健康分布对比：')
  console.log(
    `  available  ${stats.before.available} → ${stats.after.available}  (+${stats.after.available - stats.before.available})`
  )
  console.log(`  dead       ${stats.before.dead} → ${stats.after.dead}  (${stats.after.dead - stats.before.dead})`)
  console.log(`  cooling    ${stats.before.cooling} → ${stats.after.cooling}`)
  console.log(`  unknown    ${stats.before.unknown} → ${stats.after.unknown}`)

  if (changes.length === 0) {
    console.log('')
    console.log('无需迁移（幂等：已是最新状态）')
    return
  }

  console.log('')
  console.log(`将要改动 ${changes.length} 条，前 10 条明细：`)
  for (const change of changes.slice(0, 10)) {
    console.log(`  ${change.key}`)
    console.log(`    health ${change.from.health} → ${change.to.health ?? '(不变)'}  |  ${change.reason}`)
  }
  if (changes.length > 10) console.log(`  …另有 ${changes.length - 10} 条`)

  if (!args.apply) {
    console.log('')
    console.log('dry-run 结束，未写盘。加 --apply 实际执行。')
    return
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${file}.bak-${stamp}`
  fs.copyFileSync(file, backup)
  console.log('')
  console.log(`已备份：${backup}`)

  for (const change of changes) {
    raw.models[change.key] = { ...raw.models[change.key], ...change.to, writerAt: Date.now() }
  }
  raw.updatedAt = Date.now()
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8')
  fs.renameSync(tmp, file)
  console.log(`已写入：${file}（${changes.length} 条）`)
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith('repair-state.mjs')
if (isMain) main()
