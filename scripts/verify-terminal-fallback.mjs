/**
 * 用**真实宿主的池子**验证「免费流转完 → 落到 deepseek-account」。
 *
 * 取自 live 宿主 /models 的 200 个真实条目；上游被替换成「所有免费通道抛
 * 额度耗尽、deepseek-account 正常」，观察最终落点与调用链。
 */
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { normalizeConfig } from '../src/config.js'

const base = process.env.DSH_WEB_URL + '/api/model-autopilot'
const H = {
  origin: process.env.DSH_WEB_URL,
  host: '127.0.0.1:' + new URL(process.env.DSH_WEB_URL).port
}

const live = await (await fetch(base + '/models', { headers: H })).json()
const byProv = {}
for (const m of live.models) (byProv[m.provider] ??= []).push(m.model)

const freeKeys = live.models.filter((m) => m.cost === 'free').map((m) => `${m.provider}/${m.model}`)
console.log(`真实池子：${live.models.length} 条，其中免费 ${freeKeys.length} 条`)
console.log(`deepseek-account 的模型：${JSON.stringify(byProv['deepseek-account'] ?? [])}`)

const calls = []
const llm = {
  listProviders: () => Object.keys(byProv).map((id) => ({ id, name: id })),
  listModels: async (p) => (byProv[p] ?? []).map((id) => ({ provider: p, id, name: id })),
  resolveModelInfo: async (p, m) => ({ provider: p, id: m, name: m }),
  stream(o) {
    const key = o.provider + '/' + o.model
    calls.push(key)
    const isFree = freeKeys.includes(key)
    return (async function* () {
      if (isFree) {
        const e = new Error('所有账号均不可用（限流或额度耗尽）')
        e.code = 'RATE_LIMIT'
        throw e
      }
      yield { type: 'text-delta', text: 'deepseek 接管' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  }
}

const config = normalizeConfig({
  failover: { maxModels: 3, maxRetriesPerModel: 0, terminalFallback: { provider: 'deepseek-account', model: null } }
})

const models = {}
const store = {
  model: (k) => models[k],
  setModel: (k, v) => {
    models[k] = v
  },
  setMeta() {},
  get: () => ({ models }),
  flushSync() {},
  dispose() {}
}

const logger = { info() {}, warn() {}, error() {} }
const pool = createPool({ ctx: { llm }, config, store, logger })
await pool.reload()
const scheduler = createScheduler({ pool, config, logger })
const failover = createFailover({ ctx: { llm }, pool, scheduler, config, logger, wait: async () => {} })

console.log('--- 发起一次请求（所有免费通道都会失败）---')
const result = await failover.run({ messages: [] })

console.log('调用链:')
for (const key of calls) console.log('  ' + key + (freeKeys.includes(key) ? '  (免费·失败)' : '  (deepseek)'))
console.log('最终落点:', result.model.key)
console.log('reason:', result.reason)
console.log('尝试次数:', result.attempts.length)
let text = ''
for await (const chunk of result.stream) if (chunk.type === 'text-delta') text += chunk.text
console.log('下游收到内容:', JSON.stringify(text))
