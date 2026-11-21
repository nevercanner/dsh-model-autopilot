/**
 * 配置归一化。
 *
 * 为什么不用 schemastery：本插件对宿主的依赖面只有 `ctx.llm` 与 `ctx.logger`，
 * 引入配置 schema 会把一个纯数据模块变成对 @deepseek-ai/schemastery 的运行时依赖，
 * 而注入器注入的包在 profile node_modules 里不保证能解析到它。手写归一化是可测的，
 * 且失败的输入有明确兜底。
 *
 * @module config
 */
import { DEFAULT_FREE_CHANNELS, matchesFreeChannel } from './pool/free-channels.js'

/** 全部默认值。改动这里等于改行为，测试里逐条断言。 */
export const DEFAULT_CONFIG = Object.freeze({
  probe: Object.freeze({
    /** 周期探测间隔；0 = 关闭周期探测（只按需）。 */
    intervalMs: 10 * 60_000,
    /** 单次探针超时。与 dsh-our-free-model 的探针取值一致，避免免费网关被过早判死。 */
    timeoutMs: 45_000,
    /** 同一轮探测的并发上限。免费网关按 session 计数配额，过高会互相踩踏。 */
    concurrency: 3,
    /**
     * 单轮最多探测多少个模型（防首轮启动打爆上游）。
     *
     * 48 的理由：池里常有 130+ 个失效条目等待复检，24 的预算会被它们吃光，
     * 新加入/刚配好 Key 的通道轮好几轮都探不到（面板一直显示 unknown）。
     * 并发仍是 3，不会打爆上游。
     */
    maxPerRound: 48,
    /** 启动后延迟首轮探测，避开宿主启动争抢。 */
    firstRoundDelayMs: 2_000,
    /** 付费模型在健康时是否也探测（默认否，避免无谓计费）。 */
    paidProbeWhenHealthy: false,
    /** 周期探测只探“到期”的条目；这里是不健康条目的最短复检间隔。 */
    retryProbeMinMs: 60_000
  }),
  cooldown: Object.freeze({
    /** 首次失败的冷却时长；之后按 2^(failCount-1) 指数增长。 */
    baseMs: 60_000,
    /** 冷却上限。 */
    maxMs: 30 * 60_000,
    /** 连续失败多少次判定为 dead（鉴权/地区类失败一次即 dead）。 */
    deadFailCount: 3,
    /** 冷却超过这个时长才从模型选择界面屏蔽（短期抖动不隐藏）。 */
    hideAfterMs: 5 * 60_000
  }),
  free: Object.freeze({
    /** 显式声明的免费模型 provider id（例如 'our-free-model'）。 */
    providers: Object.freeze([]),
    /** 已知免费通道名单；传空数组表示只用 providers + patterns。 */
    channels: Object.freeze([...DEFAULT_FREE_CHANNELS]),
    /** provider id 命中这些片段即视为免费通道（兜底规则）。 */
    patterns: Object.freeze(['free']),
    /** 免费条目的基础优先级加成，保证同成本排序靠前。 */
    priorityBonus: 1_000
  }),
  paid: Object.freeze({
    /** 付费模型商 provider id 清单；为空表示“除免费之外全是付费”。 */
    providers: Object.freeze([]),
    /** 未单列的付费 provider 的默认优先级。 */
    defaultPriority: 0,
    /** 按 provider id 覆盖优先级，值越大越优先。 */
    priorities: Object.freeze({})
  }),
  schedule: Object.freeze({
    /** 全局开关：false = 永不全落到付费（免费全挂时直接报错）。 */
    allowPaidByDefault: true,
    /**
     * 永远不进入模型池的 provider。
     * 默认排除本插件自己注册的虚拟 provider（'autopilot'）—— 它必须出现在
     * 模型选择界面里，但绝不能进入池：否则探针会去探它、调度会选它，
     * 形成 autopilot → autopilot 的递归。
     */
    excludeProviders: Object.freeze(['autopilot']),
    /**
     * provider 置顶顺序（越靠前越优先）。只在**同一成本组内**生效：
     * 「免费优先」是硬规则，置顶项排在免费之后、其他付费之前。
     * minimax-cn 是我们希望优先用掉的付费通道，所以默认置顶。
     * 传 [] 表示不做任何置顶。
     */
    providerOrder: Object.freeze(['minimax-cn']),
    /** 连续失败一次的降权。 */
    failPenalty: 15,
    /** degraded 状态的基础降权（限流/超时仍可用，但排在健康条目后面）。 */
    degradedPenalty: 20,
    /** 每 1s 首帧延迟的降权。 */
    latencyPenaltyPerSecond: 1,
    /** 冷却已到期、等待复检的条目的加分（给恢复中的通道一次机会）。 */
    halfOpenBonus: 10,
    /**
     * 是否允许宿主（dsh-llm-retry）在我们的虚拟 provider 之上再重试整轮。
     * 默认 false：宿主默认重试 5 次，而每次重试都会重新进入 failover
     * （最多 3 个模型 × 2 次尝试），叠加起来是 5×6 次上游请求。切换是我们的
     * 职责，宿主只需要看到最终结果。
     */
    hostRetry: false
  }),
  failover: Object.freeze({
    /**
     * 一次请求最多尝试几个不同模型（含首个）。
     *
     * 语义：**不设硬上限，由 maxTotalMs 兜住**。真实的耗时上界是总时间预算，
     * 池子再大也超不过它。取值由 maxTotalMs / firstFrameTimeoutMs 推导（见
     * normalizeConfig），并作为**下限**：用户显式配更大的值时以用户为准。
     *
     * 推导的意义：预算内能把「本该试完」的候选都试到，不会因为写死的小上限
     * 提前截断（历史 bug：上限 6/20 时，前 N 个恰好全挂就直接报
     * 『所有候选均失败』，而池里还有几十个可用模型）。
     */
    maxModels: 1000,
    /**
     * 一次请求在「换模型」上的总时间预算。超过就停手并如实报耗尽。
     *
     * 30s 的理由：这是交互式聊天，用户盯着屏幕。之前 120s 的预算名义上在，实际
     * 因为检查点放错位置而完全没生效（一次请求跑了 130s、14 个候选）。现在改成
     * 「每次挑候选前都查」，30s 是「先给可用模型机会，但绝不长时间空白」的平衡点。
     */
    maxTotalMs: 30_000,
    /**
     * 多渠道路由网关：同一 provider 下的模型**各自路由到不同上游**，彼此独立。
     *
     * 为什么单独标出来：账号级失败（额度/凭据/地区）通常意味着整条账号路不通，
     * 跳过同 provider 的其它模型能省下宝贵的尝试次数。但网关（如 our-free-model
     * 背后是一批互不相干的免费渠道）里，一个模型挂了不代表别的也挂 —— 整体跳过
     * 会把本来能用的通道砍掉。
     */
    gatewayProviders: Object.freeze(['our-free-model', 'our-free-model-region', 'modlens-our-free-model']),
    /**
     * 终极兜底通道：所有候选都失败后，**再用这个通道继续干**，而不是抛错停住。
     *
     * 为什么必须有：候选耗尽时直接抛错，宿主会把这个错误抛给用户、会话停在那儿
     * （或回退默认模型重发一轮），用户的感受就是「报错了、没切换、不干活」。
     * 有了它，自动选型的承诺才是「一直干活」而不是「免费的全挂了就停」。
     *
     * 设为 null 可关闭；provider 必须是池里真实存在的通道。
     */
    terminalFallback: Object.freeze({ provider: 'deepseek-account', model: null }),
    /** 同一模型内的重试次数（0 = 首帧前失败直接换模型）。 */
    maxRetriesPerModel: 1,
    /** false = 首帧前失败立刻换模型，不在同一模型上重试。 */
    retrySameModel: true,
    /**
     * 等「首个语义帧」的上限。必须存在：provider 可能接受请求却一直不吐数据
     * （上游卡死、连接半开、网关排队），没有这个上限，整条会话会无限挂起
     * —— 表现就是「卡了」，而且宿主的 stream idle 超时管不到首帧之前这段。
     * 超时按 timeout 处理并**直接换模型**（不原地重试，否则又白等一轮）。
     */
    /**
     * 等「首个语义帧」的上限。
     *
     * 10s 的理由：免费/网关通道正常首帧 1-3s；6s 对慢首帧太紧 —— 一个挂死通道
     * 占 6s，30s 预算只能试 5 个挂死通道，其余候选来不及试。10s 给慢首帧余地，
     * 同时不至于让用户长时间空白。
     *
     * 超时按 timeout 处理并**直接换模型**（不原地重试，否则又白等一轮）。
     */
    firstFrameTimeoutMs: 10_000,
    /** 重试退避。 */
    backoff: Object.freeze({ initialMs: 400, maxMs: 4_000, jitterRatio: 0.2 })
  }),
  /** 数据目录；null = 由 paths.js 按 DSH_HOME 推导。 */
  dataDir: null,
  /** AIHOT 额度情报（Token 羊毛清单）。 */
  aihot: Object.freeze({
    /** false = 不拉清单，排序退回纯探针逻辑。 */
    quotaEnabled: true,
    /** 清单同步间隔（默认 6 小时）。 */
    quotaIntervalMs: 6 * 60 * 60_000
  }),
  /** 模型选择界面的动态屏蔽。 */
  catalogFilter: Object.freeze({    /**
     * 默认关闭。原因（实测）：宿主的 `selectModel()` 换模型前会调
     * `modelAvailable()`（dsh-api-session-controller/lib/index.js:618-630），
     * 而它读的正是 `ctx.llm.listModels()`。一旦我们把失效模型从目录里过滤掉，
     * 用户手动选择这些模型就会被判 `session/model-unavailable` → 界面回弹，
     * 表现为「模型一直在跳、根本没法手动切」。
     *
     * 目录是宿主的公共事实，不该被插件改写。失效模型改由面板展示 + 调度器跳过
     * （scheduler 本来就按 health/cooldown 过滤），不占用宿主的可用性判定。
     * 需要恢复旧行为时显式设 enabled: true，但要接受上述副作用。
     */
    enabled: false,
    /** 池状态变化合并成一次界面刷新的窗口。 */
    refreshDebounceMs: 300
  })
})

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
function num(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function strings(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
function priorities(value) {
  if (typeof value !== 'object' || value === null) return {}
  /** @type {Record<string, number>} */
  const out = {}
  for (const [key, raw] of Object.entries(value)) {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) continue
    out[key] = Math.trunc(n)
  }
  return out
}

/**
 * 归一化终极兜底通道。`false` / `null` = 关闭。
 * @param {unknown} value
 * @returns {{ provider: string, model: string | null } | null}
 */
function normalizeTerminalFallback(value) {
  if (value === false || value === null) return null
  if (value === undefined) return DEFAULT_CONFIG.failover.terminalFallback
  if (typeof value !== 'object') return DEFAULT_CONFIG.failover.terminalFallback
  const raw = /** @type {{ provider?: unknown, model?: unknown }} */ (value)
  const provider = typeof raw.provider === 'string' && raw.provider.trim() !== '' ? raw.provider.trim() : ''
  if (provider === '') return null
  const model = typeof raw.model === 'string' && raw.model.trim() !== '' ? raw.model.trim() : null
  return { provider, model }
}

/**
 * 归一化外部配置：缺失取默认，越界截断，类型错误丢弃。
 * @param {unknown} raw - cordis 传入的 entry config
 * @returns {typeof DEFAULT_CONFIG & { dataDir: string | null }}
 */
export function normalizeConfig(raw) {
  const input = typeof raw === 'object' && raw !== null ? /** @type {any} */ (raw) : {}
  const probe = typeof input.probe === 'object' && input.probe !== null ? input.probe : {}
  const cooldown = typeof input.cooldown === 'object' && input.cooldown !== null ? input.cooldown : {}
  const free = typeof input.free === 'object' && input.free !== null ? input.free : {}
  const paid = typeof input.paid === 'object' && input.paid !== null ? input.paid : {}
  const schedule = typeof input.schedule === 'object' && input.schedule !== null ? input.schedule : {}
  const failover = typeof input.failover === 'object' && input.failover !== null ? input.failover : {}
  const backoff = typeof failover.backoff === 'object' && failover.backoff !== null ? failover.backoff : {}
  const catalogFilter =
    typeof input.catalogFilter === 'object' && input.catalogFilter !== null ? input.catalogFilter : {}
  const aihot = typeof input.aihot === 'object' && input.aihot !== null ? input.aihot : {}

  return {
    probe: {
      intervalMs: num(probe.intervalMs, 0, 24 * 60 * 60_000, DEFAULT_CONFIG.probe.intervalMs),
      timeoutMs: num(probe.timeoutMs, 1_000, 10 * 60_000, DEFAULT_CONFIG.probe.timeoutMs),
      concurrency: num(probe.concurrency, 1, 16, DEFAULT_CONFIG.probe.concurrency),
      maxPerRound: num(probe.maxPerRound, 1, 200, DEFAULT_CONFIG.probe.maxPerRound),
      firstRoundDelayMs: num(probe.firstRoundDelayMs, 0, 5 * 60_000, DEFAULT_CONFIG.probe.firstRoundDelayMs),
      paidProbeWhenHealthy: probe.paidProbeWhenHealthy === true,
      retryProbeMinMs: num(probe.retryProbeMinMs, 1_000, 60 * 60_000, DEFAULT_CONFIG.probe.retryProbeMinMs)
    },
    cooldown: {
      baseMs: num(cooldown.baseMs, 1_000, 60 * 60_000, DEFAULT_CONFIG.cooldown.baseMs),
      maxMs: num(cooldown.maxMs, 1_000, 24 * 60 * 60_000, DEFAULT_CONFIG.cooldown.maxMs),
      deadFailCount: num(cooldown.deadFailCount, 1, 100, DEFAULT_CONFIG.cooldown.deadFailCount),
      hideAfterMs: num(cooldown.hideAfterMs, 0, 24 * 60 * 60_000, DEFAULT_CONFIG.cooldown.hideAfterMs)
    },
    free: {
      providers: strings(free.providers),
      channels: Array.isArray(free.channels) ? strings(free.channels) : [...DEFAULT_FREE_CHANNELS],
      patterns: strings(free.patterns).length > 0 ? strings(free.patterns) : [...DEFAULT_CONFIG.free.patterns],
      priorityBonus: num(free.priorityBonus, 0, 100_000, DEFAULT_CONFIG.free.priorityBonus)
    },
    paid: {
      providers: strings(paid.providers),
      defaultPriority: num(paid.defaultPriority, -100_000, 100_000, DEFAULT_CONFIG.paid.defaultPriority),
      priorities: priorities(paid.priorities)
    },
    schedule: {
      allowPaidByDefault: schedule.allowPaidByDefault !== false,
      excludeProviders:
        strings(schedule.excludeProviders).length > 0
          ? strings(schedule.excludeProviders)
          : [...DEFAULT_CONFIG.schedule.excludeProviders],
      // 与 excludeProviders 不同：显式传 [] 表示「不置顶任何 provider」，这是有意义的配置。
      providerOrder: Array.isArray(schedule.providerOrder)
        ? strings(schedule.providerOrder)
        : [...DEFAULT_CONFIG.schedule.providerOrder],
      failPenalty: num(schedule.failPenalty, 0, 100_000, DEFAULT_CONFIG.schedule.failPenalty),
      degradedPenalty: num(schedule.degradedPenalty, 0, 100_000, DEFAULT_CONFIG.schedule.degradedPenalty),
      latencyPenaltyPerSecond: num(
        schedule.latencyPenaltyPerSecond,
        0,
        1_000,
        DEFAULT_CONFIG.schedule.latencyPenaltyPerSecond
      ),
      halfOpenBonus: num(schedule.halfOpenBonus, 0, 100_000, DEFAULT_CONFIG.schedule.halfOpenBonus),
      hostRetry: schedule.hostRetry === true
    },
    failover: {
      maxTotalMs: num(failover.maxTotalMs, 5_000, 30 * 60_000, DEFAULT_CONFIG.failover.maxTotalMs),
      gatewayProviders: Array.isArray(failover.gatewayProviders)
        ? failover.gatewayProviders.filter((id) => typeof id === 'string')
        : [...DEFAULT_CONFIG.failover.gatewayProviders],
      terminalFallback: normalizeTerminalFallback(failover.terminalFallback),
      maxRetriesPerModel: num(failover.maxRetriesPerModel, 0, 10, DEFAULT_CONFIG.failover.maxRetriesPerModel),
      retrySameModel: failover.retrySameModel !== false,
      firstFrameTimeoutMs: num(
        failover.firstFrameTimeoutMs,
        1_000,
        10 * 60_000,
        DEFAULT_CONFIG.failover.firstFrameTimeoutMs
      ),
      // maxModels 由预算推导，并且是**下限**：用户显式配更大的值时以用户为准。
      //
      // 推导不能用「最坏情况」除：maxTotalMs / firstFrameTimeoutMs 假设每个候选
      // 都耗尽满超时。实际绝大多数失败是**秒级甚至毫秒级**（限流、凭据失效、
      // 网关快速 5xx），只有极少数才会挂到首帧超时。用最坏值除会得出 3 这种
      // 数字 —— 前 3 个候选恰好全挂就直接报『所有候选均失败』，而池里还有
      // 几十个可用模型。这正是历史 bug 的形态。
      //
      // 所以按「预算能容纳多少个**典型**失败」推导：取首帧超时的 1/4 作为典型
      // 耗时，并设 8 为绝对下限（再少就失去了在池子里挑的能力）。
      maxModels: (() => {
        const totalMs = num(failover.maxTotalMs, 5_000, 30 * 60_000, DEFAULT_CONFIG.failover.maxTotalMs)
        const frameMs = num(
          failover.firstFrameTimeoutMs,
          1_000,
          10 * 60_000,
          DEFAULT_CONFIG.failover.firstFrameTimeoutMs
        )
        const typicalMs = Math.max(250, Math.floor(frameMs / 4))
        const derived = Math.max(8, Math.min(200, Math.ceil(totalMs / typicalMs)))
        if (failover.maxModels === undefined) return derived
        const explicit = num(failover.maxModels, 1, 10_000, derived)
        return Math.max(derived, explicit)
      })(),
      backoff: {
        initialMs: num(backoff.initialMs, 0, 60_000, DEFAULT_CONFIG.failover.backoff.initialMs),
        maxMs: num(backoff.maxMs, 0, 5 * 60_000, DEFAULT_CONFIG.failover.backoff.maxMs),
        jitterRatio: Math.min(
          1,
          Math.max(0, typeof backoff.jitterRatio === 'number' ? backoff.jitterRatio : DEFAULT_CONFIG.failover.backoff.jitterRatio)
        )
      }
    },
    dataDir: typeof input.dataDir === 'string' && input.dataDir.trim() !== '' ? input.dataDir.trim() : null,
    aihot: {
      quotaEnabled: aihot.quotaEnabled !== false,
      quotaIntervalMs: num(aihot.quotaIntervalMs, 60_000, 7 * 24 * 60 * 60_000, DEFAULT_CONFIG.aihot.quotaIntervalMs)
    },
    catalogFilter: {
      enabled: catalogFilter.enabled === true,
      refreshDebounceMs: num(
        catalogFilter.refreshDebounceMs,
        0,
        60_000,
        DEFAULT_CONFIG.catalogFilter.refreshDebounceMs
      )
    }
  }
}

/**
 * 免费通道判定，带判定依据（写入池快照，便于审计为什么某条算免费）。
 *
 * 优先级：
 *   1. paid.providers 显式排除（用户的账号事实优先于我们的默认名单）
 *   2. free.providers 显式包含
 *   3. free.channels 已知免费通道（含 modlens- 前缀剥离）
 *   4. free.patterns 片段兜底
 *
 * @param {string} provider
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {'config' | 'channel' | 'pattern' | null} 命中来源，null = 付费
 */
export function freeClassOf(provider, config) {
  if (config.paid.providers.includes(provider)) return null
  if (config.free.providers.includes(provider)) return 'config'
  if (matchesFreeChannel(provider, config.free.channels)) return 'channel'
  const lowered = provider.toLowerCase()
  if (config.free.patterns.some((pattern) => lowered.includes(pattern.toLowerCase()))) return 'pattern'
  return null
}

/**
 * 额度情报判定：某个 provider 现在有没有**未过期的免费额度**。
 *
 * 为什么要单独一条：像 `agnes` / `siliconflow` / `bailian` 这种通道，用户是
 * **自己注册 + 实名**领的免费额度（厂商给的是免费 API 配额，不是订阅）。它们在
 * 宿主里既不在免费通道名单里，provider id 里也没有 'free' 字样，于是被算成
 * `paid` —— 结果就是：明明有免费额度，却被排在免费模型之后，而且探针默认跳过
 * 付费条目，永远探不到它们，用户配了 Key 也不知道通没通。
 *
 * @param {string} provider
 * @param {{ providers?: Record<string, any> } | null} quota - 额度情报
 * @returns {boolean}
 */
export function hasFreeQuota(provider, quota) {
  const info = quota?.providers?.[provider]
  return Boolean(info && info.hasUsableQuota)
}

/**
 * 免费通道判定：显式清单 > 已知免费通道 > id 片段。
 * @param {string} provider
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {boolean}
 */
export function isFreeProvider(provider, config) {
  return freeClassOf(provider, config) !== null
}
