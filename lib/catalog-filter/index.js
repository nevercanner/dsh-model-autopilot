/**
 * 模型选择界面的动态屏蔽。
 *
 * ── 数据源（已核实，不是猜的）──────────────────────────────────────────────
 * 选择界面的目录来自宿主的一次远程调用：
 *
 *   dsh-client-ui-model-selection/lib/client.js:752
 *     this.ctx.remote.session.modelCatalog()
 *   dsh-api-session-controller/lib/index.js:563 buildModelCatalog(ctx)
 *     → ctx.llm.listProviders() / ctx.llm.listModels(provider) / ctx.llm.resolveModelInfo(...)
 *
 * 所以拦住 `ctx.llm.listModels()` 就等于拦住选择界面 —— 不需要碰客户端代码。
 * `ctx.llm` 是 cordis 的 traceable proxy，它的 set 走 Reflect.set 写到服务实例上
 * （cordis/lib/index.js:145-152），因此实例级覆写可行，卸载时必须还原。
 *
 * ── 为什么用实例覆写而不是别的手段 ─────────────────────────────────────────
 * 宿主没有提供「目录过滤」扩展点：registerAdapter 只能增，不能改别人的目录；
 * llm/adapters-updated 只是变更通知，不带数据。所以只能包数据源本身。
 * 代价是必须严格管住安装计数与还原，否则热重载会一层层套 wrapper。
 *
 * @module catalog-filter
 */
import { filterModels, hiddenCountOf } from './visibility.js'
import { failureOf } from '../util.js'
import { providerFamily } from '../pool/provider-id.js'

/**
 * llm 实例 → 当前安装记录。WeakMap 让服务被回收时记录自然消失。
 * @type {WeakMap<object, { original: Function, wrapper: Function, count: number, handle: any }>}
 */
const installs = new WeakMap()

/**
 * @param {object} options
 * @param {{ llm?: any, logger?: any }} options.ctx
 * @param {{ shouldHide: Function }} options.pool
 * @param {ReturnType<typeof import('../config.js').normalizeConfig>} options.config
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @param {(() => number)} [options.now] - 时钟（测试注入）
 * @param {(stats: any) => void} [options.onRefresh] - 每次触发界面刷新后的回调（落盘用）
 */
export function createCatalogFilter({ ctx, pool, config, logger = console, now = Date.now, onRefresh }) {
  const llm = ctx?.llm
  const refreshDebounceMs = config.catalogFilter?.refreshDebounceMs ?? 300

  const stats = {
    /** listModels 被调用次数（界面每次拉目录都会 +1）。 */
    calls: 0,
    /** 累计隐藏的模型条目数。 */
    hidden: 0,
    /** 触发界面刷新的次数。 */
    emits: 0,
    /** wrapper 内部异常次数（异常时放行原列表）。 */
    errors: 0,
    lastCallAt: 0,
    lastEmitAt: 0
  }

  let disposed = false
  /** 正在同步 emit：此时 index 的目录监听应当跳过 pool.reload()。 */
  let refreshing = false
  /** @type {ReturnType<typeof setTimeout> | null} */
  let pendingFlush = null
  /** @type {null | (() => void)} */
  let unsubscribe = null

  /**
   * 装到 llm 实例上。重复调用会复用同一个 wrapper（热重载不会套娃）。
   * @returns {boolean} 是否已安装
   */
  function install() {
    if (!llm || typeof llm.listModels !== 'function') {
      logger.warn?.('model-autopilot: 无 ctx.llm.listModels，catalog-filter 未安装')
      return false
    }

    const existing = installs.get(llm)
    if (existing) {
      existing.count += 1
      return true
    }

    const original = llm.listModels
    // family 归一化：排除 'deepseek-account' 时 modlens 转发变体也必须一起受保护，
    // 否则被排除的 provider 仍会在模型选择界面里被隐藏/误伤。
    const protectedProviders = new Set(
      (config.schedule.excludeProviders ?? []).map((id) => providerFamily(id))
    )

    async function wrapper(provider) {
      stats.calls += 1
      stats.lastCallAt = Date.now()
      const models = await original.call(llm, provider)
      try {
        const filtered = filterModels(provider, models, pool, {
          now: now(),
          protectedProviders
        })
        stats.hidden += hiddenCountOf(models, filtered)
        return filtered
      } catch (error) {
        // 过滤失败不能让目录整体不可用：放行原始列表。
        stats.errors += 1
        logger.warn?.(`model-autopilot: catalog-filter 过滤失败，放行原列表 (${failureOf(error).message})`)
        return models
      }
    }

    try {
      llm.listModels = wrapper
    } catch (error) {
      // 覆写失败（宿主把服务变成只读等）不该让整个插件失败：只是界面不隐藏失效模型。
      logger.warn?.(`model-autopilot: catalog-filter 无法覆写 listModels (${failureOf(error).message})`)
      installs.delete(llm)
      return false
    }
    installs.set(llm, { original, wrapper, count: 1 })

    unsubscribe = pool.subscribe(() => scheduleRefresh())
    return true
  }

  /** 池状态变化 → 合并成一次界面刷新。一轮探测会连改十几条，逐条刷新是浪费。 */
  function scheduleRefresh() {
    if (disposed || pendingFlush !== null) return
    pendingFlush = setTimeout(() => {
      pendingFlush = null
      if (disposed) return
      refreshing = true
      try {
        llm.emitAdaptersUpdated?.()
        stats.emits += 1
        stats.lastEmitAt = Date.now()
      } catch (error) {
        stats.errors += 1
        logger.warn?.(`model-autopilot: emitAdaptersUpdated 失败 (${failureOf(error).message})`)
      } finally {
        refreshing = false
      }
      try {
        onRefresh?.({ ...stats })
      } catch {
        /* 落盘失败不影响刷新 */
      }
    }, refreshDebounceMs)
    pendingFlush.unref?.()
  }

  /**
   * 自检：用一个不存在的 provider 调一次 listModels。
   * wrapper 在调用原函数之前就计数，所以即使抛 NO_ADAPTER 也能证明赋值生效。
   * @returns {Promise<boolean>}
   */
  async function verify() {
    if (!llm || typeof llm.listModels !== 'function') return false
    const before = stats.calls
    try {
      await llm.listModels('__autopilot_catalog_probe__')
    } catch {
      /* 预期就是 NO_ADAPTER */
    }
    return stats.calls > before
  }

  function dispose() {
    disposed = true
    if (pendingFlush !== null) {
      clearTimeout(pendingFlush)
      pendingFlush = null
    }
    unsubscribe?.()
    unsubscribe = null
    // 交还「未过滤目录」口：否则池会一直经由一个已卸载的 filter 读目录。
    try {
      pool.setRawListModels?.(null)
    } catch {
      /* pool 可能是测试替身 */
    }

    if (!llm) return
    const record = installs.get(llm)
    if (!record) return
    record.count -= 1
    if (record.count > 0) return

    // 还原：把记录下来的原函数写回实例。
    // 不用 delete —— 若原实现本来就是实例自有属性（而不是 prototype 方法），
    // delete 会把方法彻底删掉，服务随即不可用。赋回原值对两种情况都正确：
    // prototype 方法会恢复可见，实例属性会回到原值。
    try {
      llm.listModels = record.original
    } catch (error) {
      logger.warn?.(`model-autopilot: catalog-filter 还原失败 (${failureOf(error).message})`)
    }
    installs.delete(llm)
  }

  return {
    install,
    verify,
    dispose,
    /**
     * 未经过滤的原始目录。
     *
     * 为什么必须有这个口子：`pool.reload()` 也调 `ctx.llm.listModels`。一旦它拿到
     * 过滤后的列表，被隐藏的条目就会从池里消失 —— 探针再也探不到它、冷却永远
     * 不会到期、也就永远恢复不了（实测：池条目从 200 掉到 189，正好等于 hidden 数）。
     * 池必须看全量，只有「给界面看的那一份」才过滤。
     *
     * @param {string} provider
     * @returns {Promise<readonly any[]>}
     */
    rawListModels(provider) {
      const record = llm ? installs.get(llm) : undefined
      if (record) return record.original.call(llm, provider)
      return llm.listModels(provider)
    },
    /** index 的目录监听用它跳过自触发的 reload。 */
    isRefreshing: () => refreshing,
    stats: () => ({ ...stats })
  }
}
