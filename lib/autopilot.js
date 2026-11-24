/**
 * 对外统一入口。
 *
 * 上层「只提需求」有两种等价用法：
 *
 *   A. 代码里显式调用
 *      const r = await autopilot.run({ messages })
 *      for await (const chunk of r.stream) { ... }
 *
 *   B. 在模型选择界面选 "Autopilot"
 *      —— 我们注册一个虚拟 provider，它的 adapter 把请求交给 A 的流程。
 *      agent / 会话标题 / 压缩等所有走 llm 的地方因此自动获得自动选型，
 *      无需任何上层改动。
 *
 * @module autopilot
 */
import { detailOf } from './pool/types.js'

/** 虚拟 provider id：出现在模型选择界面里的那一项。 */
export const AUTOPILOT_PROVIDER = 'autopilot'

/** 虚拟 provider 下的唯一模型 id。 */
export const AUTOPILOT_MODEL = 'auto'

const DISPLAY_NAME = 'Autopilot（自动选择 / 免费优先）'

/**
 * @param {object} options
 * @param {{ llm: any, logger?: any }} options.ctx
 * @param {ReturnType<typeof import('./pool/pool.js').createPool>} options.pool
 * @param {ReturnType<typeof import('./schedule/scheduler.js').createScheduler>} options.scheduler
 * @param {ReturnType<typeof import('./failover/failover.js').createFailover>} options.failover
 * @param {ReturnType<typeof import('./config.js').normalizeConfig>} options.config
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 */
export function createAutopilot({ ctx, pool, scheduler, failover, config, logger = console }) {
  /** @type {{ at: number, model: any, reason: string, attempts: number } | null} */
  let lastResult = null

  return {
    /**
     * 给定需求，选出模型并返回可迭代的流。
     * 失败会抛 AutopilotExhaustedError（带 attempts 与映射后的错误码）。
     * @param {any} request
     */
    async run(request) {
      const result = await failover.run(request)
      lastResult = {
        at: Date.now(),
        model: result.model,
        reason: result.reason,
        attempts: result.attempts.length
      }
      return result
    },
    /** 只选型，不调用（面板预览 / 测试）。 */
    plan(request = {}) {
      return scheduler.plan(request)
    },
    /** 诊断：当前排序与分数。 */
    explain(request = {}) {
      return scheduler.explain(request)
    },
    status() {
      return {
        ...pool.stats(),
        lastResult,
        allowPaidByDefault: config.schedule.allowPaidByDefault
      }
    }
  }
}

/**
 * 宿主重试策略里用一个永不匹配的错误码占位。
 * 效果：`dsh-llm-retry` 的 `retryableCodes.includes(failure.code)` 恒为 false，
 * 它就不会在我们的虚拟 provider 之上再重试整轮。
 */
export const NO_HOST_RETRY_CODE = '__autopilot_no_host_retry__'

/**
 * 截断长文案，避免把整段上游报错写进「思考中」。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  if (typeof text !== 'string') return ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * 可中断的等待：用户点停止时立刻返回，不空等满整个间隔。
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function sleepAbortable(ms, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, ms)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 构造注册给 `ctx.llm.registerAdapter()` 的 adapter。
 *
 * 宿主对 adapter 的硬性要求只有两条（其余有默认实现）：
 *   - `providerInfo(provider)` 返回的 id 必须等于 provider
 *   - `listModels()` 返回的每一项 provider 必须等于 provider、id/name 非空
 * 这两条不满足会在注册或目录读取时抛 INVALID_ADAPTER / INVALID_CATALOG。
 *
 * @param {object} options
 * @param {ReturnType<typeof createAutopilot>} options.autopilot
 * @param {ReturnType<typeof import('./config.js').normalizeConfig>} [options.config]
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 */
/**
 * 估算一次请求的输入 token 数。
 *
 * 为什么必须有：宿主把整个会话历史一次性传给模型（几百上千条消息），而池里
 * 各通道的上下文窗口天差地别（3 万 / 12.8 万 / 100 万）。不估算就挑一个
 * 3 万窗口的模型去装 8 万 token 的历史，上游必然回 400 context length
 * exceeded —— 而且这个失败会累积成 failCount，把本来能用的通道一个个判死，
 * 最后池里只剩几个超大窗口的模型还活着（实测 dead 139 / available 2）。
 *
 * 系数取 2.5：中文约 1 字 1 token，英文/代码约 4 字符 1 token，混合场景用
 * 2.5 作偏保守的估计（宁可挑大窗口，也不要撞 400）。
 *
 * @param {any[]} [messages]
 * @param {any[]} [tools]
 * @param {unknown} [system]
 * @returns {number}
 */
export function estimatePromptTokens(messages, tools, system) {
  let chars = 0
  /** @param {unknown} value */
  const walk = (value) => {
    if (value == null) return
    if (typeof value === 'string') {
      chars += value.length
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value)) walk(item)
    }
  }
  walk(system)
  walk(messages)
  walk(tools)
  return Math.ceil(chars / 2.5)
}

/**
 * 虚拟 provider 的 adapter：把一次 `llm.stream` 调用转交给自动选型。
 *
 * @param {object} options
 * @param {() => any} options.getAutopilot - 取当前 fiber 的 autopilot 实例
 * @param {any} options.config
 * @param {any} [options.logger]
 */
export function createAutopilotAdapter({ getAutopilot, config, logger = console }) {
  /** 调用统计：证明真实请求确实进入了 autopilot adapter。 */
  const stats = { calls: 0, lastCall: null, lastResult: null }

  /**
   * 每次调用时**动态**取当前 fiber 的 autopilot 实例。
   *
   * 这个 adapter 的注册会跨 fiber 存活（见 index.js 的 globalThis 槽位），
   * 所以它不能闭包住某个具体的 autopilot 对象 —— 热重载后那个对象已经属于
   * 被销毁的旧 fiber，再调用就是操作一堆死服务。
   */
  const resolve = () => {
    const autopilot = typeof getAutopilot === 'function' ? getAutopilot() : getAutopilot
    if (!autopilot || typeof autopilot.run !== 'function') {
      const error = new Error('model-autopilot 正在重载，自动选型暂不可用（请重发一次）')
      /** @type {any} */ (error).code = 'AUTOPILOT_RELOADING'
      throw error
    }
    return autopilot
  }

  /** @type {any} */
  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: DISPLAY_NAME }
    },
    /**
     * 宿主捕获的 provider 重试策略。注意 `registerAdapter` 把这里的返回值**直接**
     * 当作 resolved policy 使用（不再过 resolveRetryPolicy），所以字段形状必须是
     * `{mode, maxRetries, retryableCodes, initialDelayMs, maxDelayMs, jitterRatio}`。
     *
     * 默认 maxRetries: 0 —— 切换是我们的职责。宿主默认 5 次重试会与 failover 的
     * 3 模型 × 2 次尝试叠加成 30 次上游请求，必须在这里切断。
     */
    providerRetryPolicy() {
      if (config?.schedule?.hostRetry) return undefined
      return {
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: [NO_HOST_RETRY_CODE],
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        jitterRatio: 0.1
      }
    },
    async listModels(provider) {
      return [{ provider, id: AUTOPILOT_MODEL, name: DISPLAY_NAME }]
    },
    async resolveModel(provider, model) {
      // 不声明 context/inputModalities：编一个上下文窗口会让宿主的上下文预算
      // 与压缩阈值建立在假数据上。真实能力随每次选中的模型变化，由 failover 决定。
      return { provider, id: model, name: DISPLAY_NAME }
    },
    async prepareCall(provider, model, signal) {
      return {
        model: await adapter.resolveModel(provider, model, signal),
        stream: (options) => adapter.stream(options)
      }
    },
    /**
     * 把一次 llm 调用转交给 failover。返回值必须是 AsyncIterable<StreamChunk>。
     *
     * 注意 options 里 provider/model 是 'autopilot'/'auto'；failover 内部会把它
     * 换成真实候选（openWithPeek 里 `provider: entry.provider` 覆盖），所以这里
     * 不能把它当成真实模型名传下去。
     * @param {any} options - GenerateOptions（provider 为 'autopilot'）
     */
    async *stream(options) {
      // 调用计数与最后一次调用记录：用来证明「真实请求确实进了 autopilot」，
      // 而不是只能从模型名反推。面板与 /api 都能读到。
      stats.calls += 1
      stats.lastCall = {
        at: Date.now(),
        messages: Array.isArray(options?.messages) ? options.messages.length : 0,
        hasTools: Array.isArray(options?.tools) && options.tools.length > 0
      }
      // 估算输入 token，作为「上下文窗口不能小于这个数」的硬需求传下去。
      // 宿主不会传 `require`（那是插件内部约定），所以必须在这里自己算 ——
      // 否则 checkCapability 永远拿到 undefined，等于从不按上下文筛选，
      // 结果就是拿 3 万窗口的模型去装 8 万 token 的历史，一路 400 判死。
      const estimatedTokens = estimatePromptTokens(options?.messages, options?.tools, options?.system)
      stats.lastCall.promptTokens = estimatedTokens
      const request = {
        ...(options ?? {}),
        ...(estimatedTokens > 0 ? { require: { minContextWindow: estimatedTokens } } : {})
      }

      // ── 外层重试循环：直到拿到有效响应，绝不把「失败」交回给用户 ──────────
      //
      // 用户的诉求（原话）：「除非完成任务，否则要无感自动切换模型，不能因为
      // 预算耗尽就直接中断任务」；拷问后明确为「免费池 → deepseek-account →
      // 回免费池」循环、不设时长上限、进度显示在对话的思考区。
      //
      // 为什么这一层必须放在 adapter 而不是 failover：failover.run() 只负责
      // 「一轮内怎么挑候选」，试完就抛错；而「这一轮没成，等一会儿再来一轮」
      // 需要一个能**持续产出帧**的地方 —— adapter 的 stream() 本来就是 async
      // generator，可以直接 yield 进度帧给宿主，宿主的「思考中」区域就能显示。
      const loop = config?.failover?.retryLoop ?? {}
      const maxRounds = Number.isFinite(loop.maxRounds) ? loop.maxRounds : Number.POSITIVE_INFINITY
      const roundDelayMs = typeof loop.roundDelayMs === 'number' ? loop.roundDelayMs : 20_000
      const noticeEvery = typeof loop.noticeAfterRounds === 'number' ? loop.noticeAfterRounds : 10
      const loopStartedAt = Date.now()

      let round = 0
      /** 每轮「首帧之前」失败的尝试记录，供面板诊断。 */
      const roundLog = []

      for (;;) {
        round += 1
        /** @type {any} */
        let result
        try {
          result = await resolve().run(request)
        } catch (error) {
          // 用户取消：立刻停，不要重试。
          if (/** @type {any} */ (options)?.signal?.aborted) throw error
          // 达到配置的轮数上限（默认无限）：如实抛出。
          if (round >= maxRounds) throw error

          const message = error instanceof Error ? error.message : String(error)
          roundLog.push({ round, message, at: Date.now() })
          stats.lastRound = { round, message, elapsedMs: Date.now() - loopStartedAt }

          const elapsedSec = Math.round((Date.now() - loopStartedAt) / 1000)
          const waitSec = Math.round(roundDelayMs / 1000)
          // 进度写进「思考中」：既不让用户以为卡死，也不污染正式回答。
          const isMilestone = round % noticeEvery === 0
          const notice = isMilestone
            ? `\n[已重试 ${round} 轮 / ${elapsedSec}s 仍未成功：${truncate(message, 140)}。` +
              `继续重试 —— 你可以随时点停止。]\n`
            : `\n[第 ${round} 轮未成功：${truncate(message, 100)}；${waitSec}s 后自动重试…]\n`
          yield { type: 'reasoning-delta', text: notice }

          // 轮间等待：让冷却中的通道恢复（throttled 是瞬时的，等一会儿能好）。
          await sleepAbortable(roundDelayMs, /** @type {any} */ (options)?.signal)
          continue
        }

        stats.lastResult = {
          at: Date.now(),
          model: result.model,
          reason: result.reason,
          attempts: result.attempts.length,
          // 尝试链明细：每个候选的成败与判决，用来回答「到底换了几个、为什么换」。
          attemptChain: result.attempts.map((attempt) => ({
            key: attempt.key,
            ok: attempt.ok === true,
            verdict: attempt.verdict ?? null,
            retry: attempt.retry ?? 0,
            latencyMs: attempt.latencyMs ?? null,
            terminal: attempt.terminal === true
          }))
        }
        // 拿到有效响应：把真实内容接上并结束。
        // 注意：**不在这里包 try/catch 重试** —— `result.stream` 首帧之后才失败时
        // 已经产出过内容，重跑整轮会让用户看到重复的答案。
        yield* result.stream
        return
      }
    }
  }
  // 挂在 adapter 上，便于外部读取调用统计。
  adapter.stats = () => ({ ...stats })
  return adapter
}

/** 便于日志/面板展示：一次结果的模型摘要。 */
export function describeModel(entry) {
  return `${detailOf(entry).provider}/${detailOf(entry).model}（${entry.cost}）`
}
