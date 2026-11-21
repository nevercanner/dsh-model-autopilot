/**
 * 浏览器半身的注册自愈。
 *
 * 实测背景：运行时注入的插件，host 半身 active，但 client 半身没进 client-modules
 * 的表，注入器只回一句「已声明 client 但注册失败」。把诊断落盘后看清了两层原因：
 *
 *   1. **Loader entry 短暂处于 `disabled: true`**（防双实例对账 / 卸载重装残留），
 *      而 `client-modules.processOne()` 会跳过 disabled 的 entry —— 那一瞬间扫描
 *      什么都拿不到。它随后会自己翻正，所以这里只安排一次解除，**不 early-return**，
 *      继续往下扫，否则永远停在「等对方翻正」上。
 *   2. **`resolveMeta` 把解析失败缓存成 null**（pkgMeta：sourceKey → null）。宿主
 *      版本不同时 `loader.internal.resolveSync` 的调用签名可能对不上，异常被它自己
 *      catch 成 undefined，于是每次扫描都读到那个 null。所以先清缓存；仍不行就按它
 *      自己的缓存格式补一条（字段与 resolveMeta 返回值一致），再让它走正常流程。
 *
 * 所有异常都被吞掉：最坏结果是左侧栏入口不出现，host 侧的选型/切换不受影响。
 *
 * 为什么可以碰这些字段：`processOne` / `compose` / `notifyGraphChanged` / `table` /
 * `sources` / `pkgMeta` 就是注入器 refreshClientRow / removeClientRow 用的同一组入口；
 * 宿主没有公开的 "re-scan one package" API，这是现有唯一路径。
 *
 * @module client-half
 */
import { failureOf } from './util.js'

/** 与 package.json 的 name 保持一致：client-modules 用包名作 table 的键。 */
export const CLIENT_PACKAGE_NAME = '@dsh-external/dsh-model-autopilot'

/** 同一个进程里只安排一次解除任务，避免热重载反复触发。 */
let repairScheduled = false

/**
 * @param {{ get?: (name: string) => any, logger?: any }} ctx
 * @param {{ packageName?: string, clientPath?: string, onUpdate?: (result: any) => void }} [options]
 * @returns {{ ok: boolean, changed?: boolean, reason?: string, repaired?: boolean, diagnose?: any }}
 */
export function ensureClientHalf(ctx, options = {}) {
  const packageName = options.packageName ?? CLIENT_PACKAGE_NAME
  let cm
  try {
    cm = ctx.get?.('clientModules')
  } catch (error) {
    return { ok: false, reason: `clientModules 不可用: ${failureOf(error).message}` }
  }
  if (!cm || typeof cm.processOne !== 'function') {
    return { ok: false, reason: 'clientModules 服务缺失或没有 processOne' }
  }

  if (hasPathOf(cm, packageName)) return { ok: true, changed: false }

  const rows = loaderRows(cm, packageName)
  const disabledRows = rows.filter((row) => row.disabled)

  // ① 有 disabled 的 entry：安排一次解除，但继续往下扫 ——
  //    它随时会自己翻正，等待它等于永远不干活。
  if (disabledRows.length > 0 && !repairScheduled) {
    repairScheduled = true
    scheduleEnable(cm, packageName, options)
  }

  // ② 清缓存 → 重扫；③ 多 source → 清 source 重扫；④ 仍无行 → 补包元数据再扫。
  const scan = tryScan(cm, packageName, options.clientPath)
  const result = {
    ok: scan.ok,
    changed: scan.changed ?? false,
    repaired: Boolean(scan.repaired || disabledRows.length > 0),
    ...(scan.reason === undefined ? {} : { reason: scan.reason }),
    ...(scan.seeded === undefined ? {} : { seeded: scan.seeded })
  }
  if (!result.ok) result.diagnose = diagnose(cm, packageName)
  return result
}

/**
 * 一次完整尝试：清缓存 → 扫描 → 必要时补元数据再扫。
 * @param {any} cm
 * @param {string} packageName
 * @param {string | undefined} clientPath
 */
function tryScan(cm, packageName, clientPath) {
  const droppedMeta = clearPkgMeta(cm, packageName)

  try {
    const changed = cm.processOne(packageName)
    if (changed) compose(cm, packageName)
    if (hasPathOf(cm, packageName)) {
      return { ok: true, changed, repaired: droppedMeta > 0, droppedMeta }
    }
  } catch (error) {
    const reason = failureOf(error).message
    if (!/multiple active Loader sources/.test(reason)) {
      return { ok: false, reason }
    }
    // 多 source：卸载时只清 table 不清 sources（removeClientRow 的已知缺口）。
    const dropped = dropStaleSources(cm, packageName)
    try {
      const changed = cm.processOne(packageName)
      if (changed) compose(cm, packageName)
      return { ok: hasPathOf(cm, packageName), changed, repaired: true, dropped }
    } catch (retryError) {
      return { ok: false, reason: `${reason} → 清理 ${dropped} 个 source 后仍失败: ${failureOf(retryError).message}` }
    }
  }

  // 补包元数据：字段形状与 resolveMeta 的返回值一致。
  const seeded = seedPkgMeta(cm, packageName, clientPath)
  if (seeded === 0) return { ok: false, reason: '解析不出包元数据，且补写条件不满足' }
  try {
    const changed = cm.processOne(packageName)
    if (changed) compose(cm, packageName)
    return { ok: hasPathOf(cm, packageName), changed, repaired: true, seeded }
  } catch (error) {
    return { ok: false, reason: failureOf(error).message, seeded }
  }
}

/** @param {any} cm @param {string} packageName */
function hasPathOf(cm, packageName) {
  try {
    return typeof cm.clientPath === 'function' ? Boolean(cm.clientPath(packageName)) : false
  } catch {
    return false
  }
}

/**
 * 延迟解除 disabled 并重扫。
 * 延迟是必要的：在 apply 里同步 update 可能让当前 fiber 被重建，后面的代码就不跑了。
 * @param {any} cm
 * @param {string} packageName
 * @param {{ clientPath?: string, onUpdate?: (result: any) => void }} options
 */
function scheduleEnable(cm, packageName, options) {
  const timer = setTimeout(async () => {
    let disabledCleared = 0
    try {
      for (const entry of [...(cm.ctx?.loader?.entries?.() ?? [])]) {
        if (entry?.options?.name !== packageName || !entry.disabled) continue
        try {
          await entry.update({ disabled: false })
          disabledCleared += 1
        } catch (error) {
          cm.ctx?.logger?.warn?.(`model-autopilot: 解除 entry disabled 失败 (${failureOf(error).message})`)
        }
      }
      // 给 loader 一点时间完成装配，再重扫。
      await new Promise((resolve) => setTimeout(resolve, 400))
      const scan = tryScan(cm, packageName, options.clientPath)
      // 字段名不用 `enabled`：它会被读成「client 半身是否启用」，而它实际是
      // 「这一轮解除了几个 disabled entry」的计数。0 是正常值，不代表没工作。
      const result = {
        ok: scan.ok,
        changed: scan.changed ?? false,
        repaired: disabledCleared > 0,
        disabledCleared
      }
      cm.ctx?.logger?.info?.(
        `model-autopilot: client 半身注册${result.ok ? '成功' : '仍失败'} (${JSON.stringify(result)})`
      )
      options.onUpdate?.(result)
    } catch (error) {
      options.onUpdate?.({ ok: false, reason: failureOf(error).message })
    }
  }, 0)
  timer.unref?.()
}

/** @param {any} cm @param {string} packageName */
function compose(cm, packageName) {
  if (typeof cm.compose === 'function') cm.composed = cm.compose()
  if (typeof cm.notifyGraphChanged === 'function') cm.notifyGraphChanged()
  cm.ctx?.logger?.info?.(`model-autopilot: client 半身已注册 ${packageName}`)
}

/**
 * 清掉本包的包元数据缓存（`sourceKey` 形如 `${baseUrl}\0${name}`）。
 * @param {any} cm
 * @param {string} packageName
 * @returns {number} 删除数量
 */
function clearPkgMeta(cm, packageName) {
  const meta = cm.pkgMeta
  if (!(meta instanceof Map)) return 0
  let dropped = 0
  for (const key of [...meta.keys()]) {
    if (String(key).includes(packageName)) {
      meta.delete(key)
      dropped += 1
    }
  }
  return dropped
}

/**
 * 直接写一条包元数据进 client-modules 的缓存。
 * @param {any} cm
 * @param {string} packageName
 * @param {string | undefined} clientPath
 * @returns {number} 写入条数
 */
function seedPkgMeta(cm, packageName, clientPath) {
  if (typeof clientPath !== 'string' || clientPath === '') return 0
  const meta = cm.pkgMeta
  if (!(meta instanceof Map)) return 0
  const entry = [...(cm.ctx?.loader?.entries?.() ?? [])].find((row) => row?.options?.name === packageName)
  const baseUrl = entry?.parent?.tree?.ctx?.baseUrl
  if (typeof baseUrl !== 'string' || baseUrl === '') return 0
  const key = `${baseUrl}\0${packageName}`
  if (meta.get(key)) return 0
  meta.set(key, { packageName, meta: { clientPath, external: [], immediately: false } })
  return 1
}

/**
 * 删除本包在扫描缓存里的条目（按 packageName 匹配）。
 * @param {any} cm
 * @param {string} packageName
 * @returns {number}
 */
function dropStaleSources(cm, packageName) {
  const sources = cm.sources
  if (!(sources instanceof Map)) return 0
  let dropped = 0
  for (const [key, value] of [...sources.entries()]) {
    if (value && value.packageName === packageName) {
      sources.delete(key)
      dropped += 1
    }
  }
  return dropped
}

/** @param {any} cm @param {string} packageName */
function loaderRows(cm, packageName) {
  try {
    const entries = typeof cm.ctx?.loader?.entries === 'function' ? cm.ctx.loader.entries() : []
    return [...entries]
      .filter((entry) => entry?.options?.name === packageName)
      .map((entry) => ({
        name: entry.options.name,
        disabled: entry.disabled === true,
        hasFiber: entry.fiber !== undefined,
        baseUrl: entry.parent?.tree?.ctx?.baseUrl ?? null
      }))
  } catch (error) {
    return [{ error: failureOf(error).message }]
  }
}

/** @param {any} cm @param {string} packageName */
function diagnose(cm, packageName) {
  const out = { rows: loaderRows(cm, packageName) }
  try {
    out.tableKeys = cm.table instanceof Map ? [...cm.table.keys()].length : -1
    out.hasRow = cm.table instanceof Map ? cm.table.has(packageName) : false
  } catch (error) {
    out.tableError = failureOf(error).message
  }
  try {
    out.sourceCount =
      cm.sources instanceof Map
        ? [...cm.sources.values()].filter((value) => value && value.packageName === packageName).length
        : -1
  } catch (error) {
    out.sourcesError = failureOf(error).message
  }
  try {
    out.cachedMeta = cm.pkgMeta instanceof Map ? [...cm.pkgMeta.keys()].filter((key) => String(key).includes(packageName)).length : -1
  } catch (error) {
    out.pkgMetaError = failureOf(error).message
  }
  return out
}
