/**
 * 批次 4 验收脚本。
 *
 * 验两件运行时行为：
 *   1. 首帧 11s 才响应的挂死候选，必须被 firstFrameTimeout（10s）换掉，
 *      正常候选命中 —— 而不是把用户晾 11 秒。
 *   2. 所有候选全失败 + terminalFallback 可用时，必须落到兜底，
 *      不抛 AutopilotExhaustedError。
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} }
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createStore() {
  const models = {}
  return {
    model: (k) => models[k],
    setModel: (k, v) => {
      models[k] = v
    },
    setMeta() {},
    get: () => ({ models }),
    flushSync() {},
    dispose() {}
  }
}

/**
 * @param {{ models: Record<string,string[]>, behaviour: Record<string, any>, config?: any }} spec
 */
async function build({ models, behaviour, config }) {
  const calls = []
  const llm = {
    listProviders: () => Object.keys(models).map((id) => ({ id, name: id })),
    listModels: async (p) => (models[p] ?? []).map((id) => ({ provider: p, id, name: id })),
    resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
    stream(options) {
      const key = `${options.provider}/${options.model}`
      calls.push(key)
      const spec = behaviour[key] ?? 'ok'
      if (spec?.slowMs) {
        // 首帧前挂起 slowMs，然后正常产出
        return (async function* () {
          await tick(spec.slowMs)
          yield { type: 'text-delta', text: '慢通道首帧' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
      if (spec?.throw) {
        return (async function* () {
          const error = Object.assign(new Error(spec.throw.message), { code: spec.throw.code })
          throw error
        })()
      }
      return (async function* () {
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
  }
  const cfg = normalizeConfig({ failover: config ?? {} })
  const pool = createPool({ ctx: { llm }, config: cfg, store: createStore(), logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config: cfg, logger })
  const failover = createFailover({ ctx: { llm }, pool, scheduler, config: cfg, logger, wait: async () => {} })
  return { failover, calls, cfg }
}

let failed = 0

// ── 验收 2：挂死候选被超时换掉 ──────────────────────────────────────────────
{
  const { failover, calls, cfg } = await build({
    models: { 'our-free-model': ['hangs', 'normal'] },
    behaviour: { 'our-free-model/hangs': { slowMs: 11_000 } },
    config: { terminalFallback: false, maxRetriesPerModel: 0, retrySameModel: false }
  })
  console.log(`firstFrameTimeoutMs = ${cfg.failover.firstFrameTimeoutMs}ms（期望 10000）`)
  const started = Date.now()
  const result = await failover.run({ messages: [] })
  const elapsed = Date.now() - started

  let text = ''
  for await (const chunk of result.stream) if (chunk.type === 'text-delta') text += chunk.text

  const ok =
    result.model.key === 'our-free-model/normal' &&
    result.attempts[0]?.verdict === 'timeout' &&
    text === 'ok' &&
    elapsed < 11_000
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  [1] 挂死候选 11s → 落点=${result.model.key}  ` +
      `首条判决=${result.attempts[0]?.verdict}  耗时=${elapsed}ms  产出=${JSON.stringify(text)}`
  )
  console.log(`        调用链: ${calls.join(' → ')}`)
}

// ── 验收 3：全失败 → 落到 terminalFallback ─────────────────────────────────
{
  // 关键：必须让 deepseek-account **进不了普通候选**，否则它会在候选循环里
  // 直接成功，reason 就是 free:preferred —— 那验证的是普通选型，不是兜底。
  // 用 allowPaidByDefault: false 把它排除在普通候选外，只剩兜底这一条路。
  const { failover } = await build({
    models: { 'our-free-model': ['a', 'b'], 'deepseek-account': ['ds'] },
    behaviour: {
      'our-free-model/a': { throw: { code: 'RATE_LIMIT', message: 'quota' } },
      'our-free-model/b': { throw: { code: 'RATE_LIMIT', message: 'quota' } }
    },
    config: {
      terminalFallback: { provider: 'deepseek-account', model: null },
      maxRetriesPerModel: 0
    }
  })
  // 用 allowPaid=false 发请求：付费通道不参与普通选型，只能靠兜底
  let outcome
  let reason
  try {
    const result = await failover.run({ messages: [], allowPaid: false })
    outcome = result.model.key
    reason = result.reason
  } catch (error) {
    outcome = `ERROR:${error.name}`
  }
  const ok = outcome === 'deepseek-account/ds' && reason === 'terminal-fallback'
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  [2] 全失败 → 落点=${outcome}  reason=${reason ?? '-'}  （兜底通道不在普通候选中）`)
}

console.log()
console.log(failed === 0 ? '批次 4 验收全部通过' : `${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
