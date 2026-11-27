/**
 * 模型池的词汇表：状态枚举、条目形状、key 规则。
 *
 * 这里只有常量与类型（JSDoc），没有逻辑 —— 状态迁移在 transitions.js，
 * 装载与查询在 pool.js。分开是为了让迁移规则能被单测直接喂输入。
 *
 * @module pool/types
 */

/** 条目健康状态。 */
export const HEALTH = Object.freeze({
  /** 最近一次探测/调用成功。 */
  available: 'available',
  /** 可用但近期有失败（限流、超时），仍可被选中。 */
  degraded: 'degraded',
  /** 暂时不可用，冷却中；冷却到期后以半开身份试一次。 */
  cooling: 'cooling',
  /** 结构性不可用（鉴权失效、地区封锁、provider 已摘除），需要外部修复或长期探测。 */
  dead: 'dead',
  /** 还没探过，不知道。首次启动的合法状态。 */
  unknown: 'unknown'
})

/** 探针判决。 */
export const VERDICT = Object.freeze({
  ok: 'ok',
  throttled: 'throttled',
  auth: 'auth',
  regionBlocked: 'region-blocked',
  /**
   * 模型已下架/退役（end of life、deprecated、discontinued、no longer available）。
   *
   * 为什么要单独一类而不是复用 region-blocked：两者行为完全一致（结构性 dead、
   * 永久屏蔽、不复检），但语义不同 —— 把「模型下架」记成「地区封锁」会让任何
   * 按 verdict 做统计或展示的地方误报原因。
   */
  retired: 'retired',
  unavailable: 'unavailable',
  timeout: 'timeout',
  /**
   * 额度耗尽（余额不足 / 无可用资源包 / 402 / 欠费）。
   *
   * 为什么不复用 throttled：两者的恢复时间差了两个数量级。限流是「等几秒到几分钟」，
   * 余额不足是「等用户充值」，把它按 60s→30min 的指数冷却反复重试，只会让每一轮
   * 都先白打几次必定 402 的请求，把 failCount 顶到 190+，还顺手把整个池子的冷却占满
   * （报障现场：28 个冷却中、0 次尝试、直接失败）。额度类失败进独立的长冷却。
   */
  quota: 'quota',
  /** 流正常结束但没有产出任何 token —— 通道通但模型退化。 */
  empty: 'empty',
  /**
   * 输出被 max_tokens 截断。属于结构性短板（这个通道的输出预算不够），
   * 但不是「模型坏了」：不进冷却、不判死，只降权 + 让位。
   */
  truncated: 'truncated',
  /** 探针自身被取消（宿主关闭/用户取消），不构成对模型的判断。 */
  aborted: 'aborted',
  unknown: 'unknown'
})

export const COST = Object.freeze({ free: 'free', paid: 'paid' })

/**
 * @typedef {'available'|'degraded'|'cooling'|'dead'|'unknown'} EntryHealth
 * @typedef {'ok'|'throttled'|'auth'|'region-blocked'|'unavailable'|'timeout'|'empty'|'aborted'|'unknown'} ProbeVerdict
 * @typedef {'free'|'paid'} CostClass
 */

/**
 * @typedef {object} ModelEntry
 * @property {string} key - `${provider}/${model}`，全局唯一，也是持久化的键
 * @property {string} provider - 真实 provider id
 * @property {string} model - 真实 model id
 * @property {string} name - 展示名
 * @property {CostClass} cost
 * @property {number} priority - 基础优先级（免费条目已含 priorityBonus）
 * @property {number} contextWindow - 0 = 未声明
 * @property {readonly string[]} inputModalities
 * @property {boolean} reasoning - 是否声明了 reasoning effort
 * @property {EntryHealth} health
 * @property {number} failCount - 连续失败计数，成功清零
 * @property {number} cooldownUntil - 冷却截止（ms epoch），0 = 无冷却
 * @property {number} nextProbeAt - 下次允许探测的时间（ms epoch）
 * @property {boolean} halfOpen - 冷却已到期、等待一次试探
 * @property {boolean} hiddenFromPicker - 是否已从模型选择界面屏蔽
 * @property {{ at:number, verdict:ProbeVerdict, latencyMs?:number, detail?:string } | null} lastProbe
 * @property {string | null} providerError - 该条目所属 provider 最近一次枚举失败信息
 */

/**
 * @param {string} provider
 * @param {string} model
 * @returns {string}
 */
export function entryKey(provider, model) {
  return `${provider}/${model}`
}

/**
 * @param {ModelEntry} entry
 * @returns {{ provider: string, model: string, key: string, cost: CostClass }}
 */
export function detailOf(entry) {
  return { provider: entry.provider, model: entry.model, key: entry.key, cost: entry.cost }
}
