/**
 * 模型池状态持久化。
 *
 * 只持久化“跨重启有意义”的东西：失败计数、冷却截止、最近探测结果、屏蔽标记。
 * 探测目标本身（provider/model 清单）每次启动重新枚举，因为它是宿主的事实。
 *
 * 写入用「临时文件 + rename」，避免断电/崩溃留下半截 JSON 把下一次启动带垮。
 *
 * @module store
 */
import fs from 'node:fs'
import path from 'node:path'

/** 存档形状版本；字段语义变化时 +1，读到旧版本按缺失字段兜底。 */
export const STATE_VERSION = 1

/**
 * @typedef {object} PersistedModel
 * @property {number} failCount
 * @property {number} cooldownUntil
 * @property {number} nextProbeAt
 * @property {string} health
 * @property {boolean} hiddenFromPicker
 * @property {{at:number,verdict:string,latencyMs?:number,detail?:string}|null} lastProbe
 *
 * @typedef {object} PersistedState
 * @property {number} version
 * @property {number} updatedAt
 * @property {Record<string, PersistedModel>} models
 */

/**
 * @param {string} file - 存档绝对路径
 * @param {{ logger?: { warn?: Function, info?: Function } }} [options]
 */
export function createJsonStore(file, options = {}) {
  const logger = options.logger ?? console
  /** @type {PersistedState} */
  let state = { version: STATE_VERSION, updatedAt: 0, models: {} }
  let dirty = false
  let flushTimer = null
  /**
   * 本代 fiber 启动时刻。用于热重载隔离：
   * dispose 时只把「本代启动后改过的」条目写回，未改过的写回读盘原值。
   *
   * 为什么不用 generation 比大小：generation 存在内存里，进程重启必为 0，
   * 而磁盘上的数据带着上一个进程的代号 —— 一旦按「磁盘代号 < 内存代号」丢弃，
   * 每次重载/重启都会把 199 条健康状态整份清零，批次 1-4 修出来的
   * 「死条目能被复检复活」就全失效了。时间戳只用来判断「谁写得更晚」，
   * 不做丢弃，因此不丢数据。
   */
  const fiberStartAt = Date.now()
  /** 本代改过的条目 key：只有这些在 dispose 时允许写回。 */
  const dirtyKeys = new Set()

  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object') {
      state = {
        version: STATE_VERSION,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        models: sanitizeModels(parsed.models)
      }
    }
  } catch (error) {
    // 首次启动（ENOENT）是常态；其它错误说明存档坏了，用空状态继续，不让插件起不来。
    if (/** @type {any} */ (error)?.code !== 'ENOENT') {
      logger.warn?.(`model-autopilot: 池状态存档不可读，按空状态启动 (${describe(error)})`)
    }
  }

  /** @param {unknown} input @returns {Record<string, PersistedModel>} */
  function sanitizeModels(input) {
    /** @type {Record<string, PersistedModel>} */
    const out = {}
    if (typeof input !== 'object' || input === null) return out
    for (const [key, value] of Object.entries(/** @type {any} */ (input))) {
      if (typeof value !== 'object' || value === null) continue
      out[key] = {
        failCount: finite(value.failCount, 0),
        cooldownUntil: finite(value.cooldownUntil, 0),
        nextProbeAt: finite(value.nextProbeAt, 0),
        health: typeof value.health === 'string' ? value.health : 'unknown',
        hiddenFromPicker: value.hiddenFromPicker === true,
        lastProbe:
          value.lastProbe && typeof value.lastProbe === 'object'
            ? {
                at: finite(value.lastProbe.at, 0),
                verdict: typeof value.lastProbe.verdict === 'string' ? value.lastProbe.verdict : 'unknown',
                ...(typeof value.lastProbe.latencyMs === 'number' ? { latencyMs: value.lastProbe.latencyMs } : {}),
                ...(typeof value.lastProbe.detail === 'string' ? { detail: value.lastProbe.detail } : {})
              }
            : null
      }
    }
    return out
  }

  /** 立即写盘；异常只告警，不让探测/调度因为磁盘问题中断。 */
  function flushSync() {
    if (!dirty) return
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // ── 热重载覆盖保护 ───────────────────────────────────────────────────
      // 直接写整份 state 会让**旧 fiber** 用它的旧快照覆盖新 fiber 已经写好的
      // 结果（旧 fiber 内存里还是 failCount=26/dead，新 fiber 已恢复 available）。
      //
      // 所以写盘前重新读一次磁盘，只把「本代改过的条目」覆盖上去：
      //   - 本代改过的（dirtyKeys）→ 用内存值，这是新事实
      //   - 本代没碰过的      → 保留磁盘现值（可能是更新的一代写的）
      // 这样进程被杀也不丢状态，热重载也不会互相覆盖。
      /** @type {Record<string, any>} */
      let onDisk
      try {
        const raw = fs.readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw)
        onDisk = parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object' ? parsed.models : {}
      } catch {
        onDisk = {}
      }

      /** @type {Record<string, any>} */
      const merged = {}
      // 先放磁盘现值，再用本代改过的覆盖
      for (const [key, model] of Object.entries(onDisk)) merged[key] = model
      for (const key of dirtyKeys) {
        if (state.models[key] !== undefined) merged[key] = state.models[key]
      }
      // 本代新加、磁盘上还没有、且没标 dirty 的条目（例如首次 reload 建池）也要写，
      // 否则新模型永远不会进存档。判定依据：磁盘没有这个 key。
      for (const [key, model] of Object.entries(state.models)) {
        if (merged[key] === undefined) merged[key] = model
      }

      const toWrite = { ...state, models: merged, updatedAt: Date.now() }
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(toWrite, null, 2), 'utf8')
      fs.renameSync(tmp, file)
      state = { ...toWrite }
      dirty = false
    } catch (error) {
      logger.warn?.(`model-autopilot: 池状态写入失败 (${describe(error)})`)
    }
  }

  /** 200ms 合并窗口：一轮探测会连续改十几条，逐条写盘是浪费。 */
  function scheduleFlush() {
    dirty = true
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushSync()
    }, 200)
    // 不阻止进程退出（探测不是关键路径）
    flushTimer.unref?.()
  }

  return {
    file,
    /** @returns {PersistedState} */
    get() {
      return state
    },
    /** @param {string} key @returns {PersistedModel | undefined} */
    model(key) {
      return state.models[key]
    },
    /** @param {string} key @param {PersistedModel} value */
    setModel(key, value) {
      state.models[key] = { ...value, writerAt: Date.now() }
      dirtyKeys.add(key)
      state.updatedAt = Date.now()
      scheduleFlush()
    },
    /**
     * 顶层元信息（provider 清单、枚举失败）。诊断与面板要靠它回答
     * “为什么某个模型商没进池”。
     * @param {Record<string, unknown>} meta
     */
    setMeta(meta) {
      state = { ...state, ...meta, updatedAt: Date.now() }
      scheduleFlush()
    },
    flushSync,
    /**
     * 本代 fiber 是否改过这个条目。
     * pool 用它决定 dispose 时哪些能写回（防止旧一代覆盖新一代）。
     * @param {string} key
     * @returns {boolean}
     */
    isDirty(key) {
      return dirtyKeys.has(key)
    },
    /** 本代启动时刻（热重载隔离用）。 */
    fiberStartAt,
    /**
     * 一次性迁移：清掉历史写下的 hiddenFromPicker。
     *
     * 背景：早期 catalogFilter 逻辑把 153 条失效条目标成了 hiddenFromPicker=true，
     * 即使后来 catalogFilter 关掉，这些 true 仍留在存档里 —— 用户某天开启
     * catalogFilter 时会一次性消失 153 条模型。这里在 pool 初始化前清一次。
     *
     * @param {string} [reason]
     * @returns {number} 被清理的条目数
     */
    resetHiddenFromPicker(reason = 'catalogFilter disabled') {
      let cleared = 0
      for (const [key, model] of Object.entries(state.models)) {
        if (model?.hiddenFromPicker === true) {
          state.models[key] = { ...model, hiddenFromPicker: false, writerAt: Date.now() }
          dirtyKeys.add(key)
          cleared += 1
        }
      }
      if (cleared > 0) {
        state = { ...state, updatedAt: Date.now() }
        dirty = true
        scheduleFlush()
        logger.info?.(`model-autopilot: 已清理 ${cleared} 条 hiddenFromPicker（${reason}）`)
      }
      return cleared
    },
    dispose() {
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      // 仍然 flush：进程被杀时不丢最新健康状态。
      // 覆盖保护由 pool 侧完成（只有 isDirty 的条目会走 setModel 写回），
      // 所以这里不需要再按代际筛选。
      flushSync()
    }
  }
}

/** @param {unknown} value @param {number} fallback */
function finite(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** @param {unknown} error */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}
