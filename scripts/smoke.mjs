/**
 * 冒烟：用假宿主把 src/index.js 的装配链路完整跑一遍。
 *
 * 覆盖的是真实装配（apply → 建池 → 起探针 → 写盘），不是模块单测：
 *   - 6 家付费 provider + 一个免费模型插件（our-free-model）
 *   - 免费通道里故意放三种结局：ok / RATE_LIMIT / INVALID_CREDENTIAL
 *   - 跑完打印池快照、屏蔽清单、探针轮结果，并回读持久化文件
 *
 * 运行：node scripts/smoke.mjs（npm run smoke）
 * DSH_HOME 被指向临时目录，不碰真实 ~/.dsh。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autopilot-'))
process.env.DSH_HOME = home

const { apply, SERVICE_NAME, currentService } = await import('../src/index.js')

// ── 假宿主 ───────────────────────────────────────────────────────────────────

const LOG = []
const logger = {
  info: (message) => LOG.push(['info', message]),
  warn: (message) => LOG.push(['warn', message]),
  error: (message) => LOG.push(['error', message])
}

/** 六个模型商 + 一个免费通道；工具/多模态标记各不相同。 */
const PROVIDERS = {
  'our-free-model': ['free-alpha', 'free-beta', 'free-gamma'],
  magpie: ['deepseek/deepseek-v4-pro'],
  anthropic: ['claude-x'],
  openai: ['gpt-x'],
  google: ['gemini-x'],
  moonshot: ['kimi-x'],
  zhipu: ['glm-x']
}

/** 免费通道三个模型的探针结局。 */
const FREE_VERDICTS = {
  'our-free-model/free-alpha': [{ type: 'text-delta', text: 'p' }, { type: 'finish', reason: { kind: 'stop' } }],
  'our-free-model/free-beta': [
    { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429 too many requests' } } }
  ],
  'our-free-model/free-gamma': [
    { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_CREDENTIAL', message: 'bad key' } } }
  ]
}

const llm = {
  listProviders: () => Object.keys(PROVIDERS).map((id) => ({ id, name: id })),
  async listModels(provider) {
    // 虚拟 provider 由 adapter 注册，不在 PROVIDERS 表里。
    if (provider === 'autopilot') return [{ provider, id: 'auto', name: 'Autopilot（自动选择）' }]
    if (!PROVIDERS[provider]) {
      throw Object.assign(new Error(`no adapter registered for provider "${provider}"`), { code: 'NO_ADAPTER' })
    }
    return PROVIDERS[provider].map((id) => ({ provider, id, name: `${id} · ${provider}`, inputModalities: ['text'] }))
  },
  async resolveModelInfo(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 131_072 },
      inputModalities: provider === 'anthropic' ? ['text', 'image'] : ['text'],
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }
    }
  },
  stream(options) {
    const key = `${options.provider}/${options.model}`
    const chunks = FREE_VERDICTS[key] ?? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'upstream 500' } } }]
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  },
  /** 记录虚拟 provider 的注册，供下面断言 adapter 契约。 */
  registerAdapter(routes, adapter) {
    registeredAdapter = { routes, adapter }
    const handle = () => {}
    handle.replace = () => {}
    return handle
  },
  emitAdaptersUpdated() {}
}

/** @type {{ routes: string[], adapter: any } | null} */
let registeredAdapter = null

/** 最小 cordis context 替身。 */
const ctx = {
  logger,
  llm,
  effect(fn) {
    return fn()
  },
  on() {
    return () => {}
  },
  /** 冒烟里没有 webServer：mountApi 的回调不该被触发（真实宿主里有服务时才挂路由）。 */
  inject(_deps, callback) {
    return () => {}
  }
}

// ── 跑装配 ───────────────────────────────────────────────────────────────────

await apply(ctx, {
  probe: { intervalMs: 0, firstRoundDelayMs: 0, timeoutMs: 2_000, concurrency: 2, maxPerRound: 10 },
  cooldown: { baseMs: 1_000, maxMs: 60_000, deadFailCount: 3, hideAfterMs: 5_000 },
  // 默认关闭（会破坏宿主的 modelAvailable 校验）；冒烟里显式开启以覆盖该能力。
  catalogFilter: { enabled: true, refreshDebounceMs: 0 }
})

const service = currentService()
if (!service) throw new Error('smoke: apply 之后 currentService() 为空')
if (SERVICE_NAME !== 'modelAutopilot') throw new Error('smoke: 服务名不一致')

// 首轮探针是 fire-and-forget（startup 延迟 0），round() 会合流到那一轮。
await service.prober.round('smoke')
// 状态写回是 200ms 合并窗口，冒烟里手动落盘再回读。
service.store.flushSync()

// ── 报告 ─────────────────────────────────────────────────────────────────────

const entries = service.pool.all()
console.log(`\n模型池：${entries.length} 条（免费 ${service.pool.stats().free} / 付费 ${service.pool.stats().paid}）`)
console.log('─'.repeat(100))
console.log(['cost', 'health', 'fail', 'cooldown(s)', 'hidden', 'probe', 'key'].join(' | '))
for (const entry of entries) {
  const cooldown = entry.cooldownUntil > Date.now() ? Math.round((entry.cooldownUntil - Date.now()) / 1000) : 0
  console.log(
    [
      entry.cost,
      entry.health,
      String(entry.failCount),
      String(cooldown),
      String(service.pool.shouldHide(entry)),
      entry.lastProbe?.verdict ?? '-',
      entry.key
    ].join(' | ')
  )
}

console.log('\n探针轮：', JSON.stringify(service.prober.status().lastRound))
console.log('统计：', JSON.stringify(service.status()))

const stateFile = path.join(home, 'model-autopilot', 'pool-state.json')
const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
console.log(`\n持久化：${stateFile}`)
console.log('  已存条目：', Object.keys(persisted.models).join(', '))
console.log('  free-beta 状态：', JSON.stringify(persisted.models['our-free-model/free-beta']))

// ── 虚拟 provider：注册形状 + 端到端自动选型 ─────────────────────────────────

if (!registeredAdapter) throw new Error('smoke: 没有注册 autopilot adapter')
const { routes, adapter } = registeredAdapter
console.log('\n虚拟 provider：', routes.join(', '))
console.log('  providerInfo：', JSON.stringify(adapter.providerInfo(routes[0])))
console.log('  listModels：', JSON.stringify(await adapter.listModels(routes[0])))

if (routes[0] !== 'autopilot') throw new Error('smoke: provider 名应为 autopilot')
if (adapter.providerInfo('autopilot').id !== 'autopilot') throw new Error('smoke: providerInfo.id 必须等于 provider')
if (service.pool.all().some((item) => item.provider === 'autopilot')) {
  throw new Error('smoke: autopilot 不该进池（会递归）')
}

const chunks = []
for await (const chunk of adapter.stream({
  provider: 'autopilot',
  model: 'auto',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
})) {
  chunks.push(chunk)
}
console.log('  端到端选型输出：', JSON.stringify(chunks.map((item) => item.type)))
console.log('  lastResult：', JSON.stringify(service.autopilot.status().lastResult))

if (chunks[0]?.type !== 'text-delta') throw new Error('smoke: 自动选型应直接产出文本')
if (service.autopilot.status().lastResult.model.key !== 'our-free-model/free-alpha') {
  throw new Error('smoke: 应优先选中健康的免费模型')
}

// ── catalog-filter：选择界面看不到失效模型 ───────────────────────────────────

const filterStatus = service.status().catalogFilter
console.log('\ncatalog-filter：', JSON.stringify(filterStatus))
if (!filterStatus.installed) throw new Error('smoke: catalog-filter 未安装')

const visibleFree = await llm.listModels('our-free-model')
console.log('  选择界面可见的免费模型：', visibleFree.map((item) => item.id).join(', '))
if (visibleFree.some((item) => item.id === 'free-gamma')) {
  throw new Error('smoke: dead 模型不应出现在选择界面')
}
if (!visibleFree.some((item) => item.id === 'free-alpha')) {
  throw new Error('smoke: 健康模型必须仍然可见')
}

const visibleAutopilot = await llm.listModels('autopilot')
if (visibleAutopilot.length !== 1) throw new Error('smoke: autopilot 必须始终可见')

console.log('\n日志：')
for (const [level, message] of LOG) console.log(`  [${level}] ${message}`)

// 断言：这是冒烟不是测试，但关键结论必须成立，否则进程退出码非零。
const alpha = service.pool.get('our-free-model/free-alpha')
const beta = service.pool.get('our-free-model/free-beta')
const gamma = service.pool.get('our-free-model/free-gamma')
const paid = service.pool.get('magpie/deepseek/deepseek-v4-pro')

if (alpha.health !== 'available') throw new Error('smoke: free-alpha 应为 available')
if (beta.health !== 'degraded') throw new Error('smoke: free-beta 应为 degraded（限流）')
if (gamma.health !== 'dead' || service.pool.shouldHide(gamma) !== true) throw new Error('smoke: free-gamma 应判 dead 并屏蔽')
if (paid.lastProbe !== null) throw new Error('smoke: 健康付费模型不该被探测')
if (paid.cost !== 'paid') throw new Error('smoke: magpie 应为付费')

fs.rmSync(home, { recursive: true, force: true })
console.log('\n✔ 冒烟通过')
