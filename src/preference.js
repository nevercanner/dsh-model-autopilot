/**
 * 首选 provider（锁定）。
 *
 * 为什么需要它：调度器默认「免费优先」是硬规则 —— 但用户可能给某个付费通道
 * 充值了限时额度（比如「5 小时额度」），不用就是纯亏，这时需要**压过免费优先**。
 * 首选锁定就是这个开关：锁定后该 provider 排第一，其余仍按免费优先排队。
 *
 * 锁定是**策略级**的（存在插件自己的存档里，热重载/重启都保持），与会话级
 * 「当前会话用哪个模型」是两件事：前者决定自动选型先挑谁，后者决定这次会话用谁。
 *
 * @module preference
 */
import fs from 'node:fs'
import path from 'node:path'
import { failureOf } from './util.js'

/**
 * @param {object} options
 * @param {string} options.file - 独立存档路径（**不与 pool-state.json 共用**）
 * @param {{ all: () => readonly any[], get: (key: string) => any }} options.pool
 * @param {{ warn?: Function, info?: Function }} [options.logger]
 */
export function createPreference({ file, pool, logger = console }) {
  /** @type {{ provider: string | null, model: string | null }} */
  let state = { provider: null, model: null }

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    state = {
      provider: typeof raw?.provider === 'string' && raw.provider !== '' ? raw.provider : null,
      model: typeof raw?.model === 'string' && raw.model !== '' ? raw.model : null
    }
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ENOENT') {
      logger.warn?.(`model-autopilot: 首选设置读取失败，按未锁定处理 (${failureOf(error).message})`)
    }
  }

  /**
   * 单独写一个文件，不写进 pool-state.json。
   * 原因：热重载时新旧两个 fiber 短暂并存、共用同一个存档文件，旧 fiber 在 dispose 时
   * 会用它内存里的陈旧状态覆盖整个文件，把新 fiber 刚写进去的首选设置抹掉。
   * 分文件之后，两边各写各的，互不干扰。
   */
  function persist() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (error) {
      logger.warn?.(`model-autopilot: 首选设置落盘失败 (${failureOf(error).message})`)
    }
  }

  return {
    /** @returns {{ provider: string | null, model: string | null }} */
    get() {
      return { provider: state.provider, model: state.model }
    },
    /** 是否锁定了某个 provider。 */
    isPinned() {
      return state.provider !== null
    },
    /**
     * 设置/取消首选。provider 为空串或 null 表示取消锁定。
     * @param {string | null} provider
     * @param {string | null} [model]
     * @returns {{ ok: boolean, error?: string, preference?: { provider: string | null, model: string | null } }}
     */
    set(provider, model = null) {
      if (provider === null || provider === undefined || provider === '') {
        state.provider = null
        state.model = null
        persist()
        logger.info?.('model-autopilot: 已取消首选 provider，回到免费优先')
        return { ok: true, preference: this.get() }
      }
      const known = pool.all().some((entry) => entry.provider === provider)
      if (!known) {
        return { ok: false, error: `provider "${provider}" 不在模型池里（可能未装配或已被摘除）` }
      }
      state.provider = provider
      state.model = model === null || model === undefined || model === '' ? null : model
      persist()
      logger.info?.(`model-autopilot: 首选 provider 设为 ${state.provider}${state.model ? `/${state.model}` : ''}`)
      return { ok: true, preference: this.get() }
    }
  }
}
