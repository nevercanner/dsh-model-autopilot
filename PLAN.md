# dsh-model-autopilot 规划（只规划，不含实现）

目标：在 DSH 层自动选模型 + 探针 + 故障切换，免费优先；左侧栏入口；模型选择界面动态屏蔽暂时失效模型。

技术栈（按现有约定）：TypeScript + ESM、cordis 插件（`apply(ctx, config)` / `inject`）、`@deepseek-ai/schemastery` 配置、tsdown 构建、React 18 客户端半身、node `^22.19.0 || >=24.0.0`。

---

## 1. 目录结构

```
D:\桌面\建个新插件\                        ← 插件根目录（= npm 包根，包名 dsh-model-autopilot）
├── package.json                           ← 包元数据：main / exports(./client) / dsh.bundle.patch / dsh.client.inject
├── cordis.patch.yml                       ← bundle patch 层：一行 insert 把 host 半身挂进 profile
├── tsconfig.json                          ← host 侧 TS 配置（ESM、node22）
├── tsconfig.client.json                   ← client 侧 TS 配置（jsx、DOM lib）
├── tsdown.config.ts                       ← 双产物构建：host → lib/index.js，client → lib/client.js
├── icon.svg                               ← 左侧栏入口图标
├── README.md                              ← 安装、配置、命令说明
├── PLAN.md                                ← 本文件
├── src/
│   ├── index.ts                           ← host 入口：apply(ctx, config)，装配调度器/探针/适配器/屏蔽
│   ├── config.ts                          ← Schemastery 配置 schema（模型商清单、免费模型、探针、策略）
│   ├── log.ts                             ← 日志封装（复用 ctx.logger / fiber 名）
│   ├── state.ts                           ← 运行时状态容器 + 订阅（池快照、探针结果、上次选择）
│   ├── store.ts                           ← 持久化：原子写 JSON，重启恢复失败计数/冷却/探针历史
│   ├── pool/
│   │   ├── types.ts                       ← ModelEntry / ProbeVerdict / PoolSnapshot 等类型
│   │   ├── pool.ts                        ← 模型池：装载、合并、标记状态、查询候选
│   │   └── builtin-providers.ts           ← 6 家模型商的默认 id / 优先级 / 成本分类
│   ├── adapters/
│   │   ├── index.ts                       ← 适配器注册表（按 provider 前缀路由）
│   │   ├── paid.ts                        ← 付费模型商适配（统一走 ctx.llm.stream）
│   │   ├── free-generic.ts                ← 通用免费模型适配（声明式接入）
│   │   └── our-free-model.ts              ← dsh-our-free-model 专用适配（路由前缀 / 探针入口）
│   ├── probe/
│   │   ├── probe.ts                       ← 单模型探针：最小请求 + verdict 判定
│   │   ├── prober.ts                      ← 周期/按需探测调度、并发限流、结果回写
│   │   └── verdict.ts                     ← verdict → 池状态迁移（冷却、恢复、半开）
│   ├── schedule/
│   │   ├── scheduler.ts                   ← 选择策略：过滤 → 打分 → 排序 → 候选链
│   │   ├── scoring.ts                      ← 打分权重（免费优先、优先级、延迟、失败率、新鲜度）
│   │   └── capability.ts                  ← 需求 → 能力过滤（上下文窗口 / 多模态 / reasoning）
│   ├── failover/
│   │   ├── failover.ts                    ← 重试 / 降级 / 切换主循环
│   │   ├── classify.ts                    ← 错误分类（可重试 / 限流 / 鉴权 / 永久 / 取消）
│   │   └── breaker.ts                     ← 失败计数、指数冷却、半开探测
│   ├── autopilot.ts                       ← 对外统一入口：runAutopilot() + autopilot adapter
│   ├── catalog-filter.ts                  ← 模型选择界面动态屏蔽（包装 ctx.llm.listModels）
│   ├── commands.ts                        ← /autopilot status | probe | reset 斜杠命令
│   └── client/
│       ├── index.tsx                      ← client 半身入口：slots / locale / store 装配
│       ├── entry.tsx                      ← 左侧栏入口行（sidebar.panellist）
│       ├── panel.tsx                      ← 面板：池状态表、探针按钮、屏蔽清单
│       ├── bridge.ts                      ← 客户端 ↔ host 的状态通道
│       └── locale/{zh.json,en.json}       ← 文案
└── test/
    ├── scheduler.test.ts                  ← 选择策略：免费优先 / 冷却 / 回退
    ├── failover.test.ts                   ← 失败分类、重试、切换
    └── probe.test.ts                      ← verdict 判定与状态迁移
```

---

## 2. 入口文件

两条主线分居两处（按 DSH 现有约定）：

- **左侧栏入口** 在 client 半身（`src/client/index.tsx`），由 package.json 的 `dsh.client.inject` 注入、`exports["./client"]` 暴露。
- **host 入口** `src/index.ts` 负责调度器、探针、adapter、catalog 屏蔽。

```ts
// package.json（关键片段）
{
  "name": "dsh-model-autopilot",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

```ts
// src/index.ts —— host 入口骨架
import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config'
import { createPool } from './pool/pool'
import { createStore } from './store'
import { createProber } from './probe/prober'
import { createScheduler } from './schedule/scheduler'
import { createAutopilot, autopilotAdapter } from './autopilot'
import { installCatalogFilter } from './catalog-filter'
import { installCommands } from './commands'

export const name = 'model-autopilot'
export const inject = ['llm']            // 需要 llm 服务；timer 由 cordis-plugin-timer 混入
export { Config }

export function apply(ctx: Context, config: Config) {
  // ① 持久化 + 状态
  const store = ctx.effect(() => createStore(ctx), 'model-autopilot: store')

  // ② 模型池：6 家模型商 + 免费模型统一抽象
  const pool = createPool({ ctx, config, store })

  // ③ 探针（免费模型必选机制；付费模型可选低频探测）
  const prober = createProber({ ctx, pool, config })
  ctx.effect(() => prober.start(), 'model-autopilot: prober')   // 内部用 ctx.interval，随 fiber 释放

  // ④ 调度 + 故障切换
  const scheduler = createScheduler({ pool, config })
  const autopilot = createAutopilot({ ctx, pool, scheduler, prober, config })

  // ⑤ 注册虚拟 provider：模型选择界面出现 "Autopilot" 一项，agent 层零改动
  const reg = ctx.llm.registerAdapter(['autopilot'], autopilotAdapter(autopilot))
  ctx.effect(() => () => reg.dispose?.(), 'model-autopilot: adapter')  // TODO: 按 DSH 实际 API 补齐（返回值的释放方法名）

  // ⑥ 模型选择界面动态屏蔽：包装 listModels，让 buildModelCatalog 自动少列失效模型
  installCatalogFilter({ ctx, pool })

  // ⑦ 命令 + 面板数据
  installCommands({ ctx, pool, prober, scheduler })
  ctx.set?.('modelAutopilot' /* TODO: 按 DSH 实际 API 补齐（是否允许自定义服务名/命名空间） */, { pool, prober, scheduler })
}
```

```ts
// src/client/index.tsx —— 左侧栏入口 + 面板
import type { Context } from '@deepseek-ai/cordis'
import { AutopilotEntry } from './entry'
import { AutopilotBody } from './panel'
import zh from './locale/zh.json'

export const inject = ['slots', 'locale']   // 真实：our-free-model 等插件即以此为最小集合

export function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register('model-autopilot', zh), 'model-autopilot: locale')

  // 左侧栏「面板行」入口：侧栏顶部的导航行
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    key: 'model-autopilot',
    locale: 'model-autopilot',
  }, AutopilotEntry), 'model-autopilot: panellist')

  // 右侧面板主体（点击入口后打开）
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: 'model-autopilot',
    locale: 'model-autopilot',
  }, AutopilotBody), 'model-autopilot: pane')

  // TODO: 按 DSH 实际 API 补齐 —— 入口组件 props 契约（store / inject / locale seat）需对齐
  //       dsh-client-ui-slots 的 contract/slots.ts；当前只写 name/key/locale 三个已知字段。
}
```

```yml
# cordis.patch.yml
- insert:
    - id: model-autopilot
      name: 'dsh-model-autopilot'
      config: {}
```

---

## 3. 核心调度模块

### 3.1 模型池建模

```ts
// src/pool/types.ts
export type CostClass = 'free' | 'paid'
export type EntryHealth = 'available' | 'degraded' | 'cooling' | 'dead' | 'unknown'

export interface ModelEntry {
  key: string                  // `${provider}/${model}`，全局唯一
  provider: string             // 真实 provider id（6 家模型商之一，或免费通道如 our-free-model）
  model: string
  name: string
  cost: CostClass
  priority: number             // 配置给定的基础优先级，越大越优先
  capabilities: {
    contextWindow?: number
    input?: ('text' | 'image')[]
    reasoning?: boolean
  }
  health: EntryHealth
  lastProbe?: { at: number; verdict: ProbeVerdict; latencyMs?: number; detail?: string }
  failCount: number            // 连续失败计数（成功即清零）
  cooldownUntil: number        // 冷却截止时间戳，0 = 无冷却
  halfOpen: boolean            // 冷却到期后允许一次试探调用
  hiddenFromPicker: boolean    // 是否已从模型选择界面屏蔽
}

export type ProbeVerdict =
  | 'ok' | 'throttled' | 'auth' | 'region-blocked' | 'unavailable' | 'timeout' | 'unknown'

export interface PoolSnapshot {
  entries: ModelEntry[]
  updatedAt: number
}
```

```ts
// src/pool/pool.ts —— 对外查询接口（伪代码）
export interface ModelPool {
  reload(): Promise<void>                       // 重新枚举 ctx.llm.listProviders/listModels + 配置覆盖
  all(): ModelEntry[]
  get(key: string): ModelEntry | undefined
  candidates(req: CapabilityRequirement): ModelEntry[]   // 已按能力过滤
  markProbe(key: string, verdict: ProbeVerdict, meta?): void
  markFailure(key: string, kind: FailureKind): void
  markSuccess(key: string): void
  setHidden(key: string, hidden: boolean): void
  snapshot(): PoolSnapshot
  subscribe(fn: (s: PoolSnapshot) => void): () => void
}
```

真实数据来源（已核实）：

- `ctx.llm.listProviders()` → `{ id, name }[]`
- `ctx.llm.listModels(providerId)` → 模型条目
- `ctx.llm.resolveModelInfo(providerId, modelId)` → 能力/reasoning 元数据
- 配置里的 6 家模型商按 `provider id` 打 `cost: 'paid'` + `priority`；`our-free-model` 等免费插件打 `cost: 'free'`。
- 免费识别规则：配置显式名单 > provider id 含 `free`（兜底）。

### 3.2 探针机制

```ts
// src/probe/probe.ts
export interface ProbeOptions {
  timeoutMs?: number       // 默认 45000（与 our-free-model 的探针一致）
  signal?: AbortSignal
}

/** 单模型探针：发一个最小请求，只要能拿到正常结束就算 ok。 */
export async function probeOne(
  ctx: Context,
  entry: ModelEntry,
  opts?: ProbeOptions,
): Promise<{ verdict: ProbeVerdict; latencyMs: number; detail?: string }> {
  const started = Date.now()
  try {
    const stream = ctx.llm.stream({
      provider: entry.provider,
      model: entry.model,
      messages: [{ role: 'user', content: 'ping' }],   // TODO: 按 DSH 实际 API 补齐（GenerateOptions 的字段名/必填项）
      maxTokens: 8,
      signal: opts?.signal,
    })
    // 只读首帧即可判定：有 text-delta 视为通，finish.kind === 'error' 视为不通
    for await (const chunk of stream) {
      if (chunk.type === 'finish' && chunk.reason?.kind === 'error')
        return classify(chunk.reason.failure, Date.now() - started)
      if (chunk.type === 'text-delta' || chunk.type === 'finish')
        return { verdict: 'ok', latencyMs: Date.now() - started }
    }
    return { verdict: 'unknown', latencyMs: Date.now() - started, detail: 'empty stream' }
  } catch (err) {
    return classifyError(err, Date.now() - started)   // TODO: 按 DSH 实际 API 补齐（错误码枚举来源）
  }
}
```

```ts
// src/probe/prober.ts —— 周期 / 按需探测
export interface Prober {
  start(): () => void                       // 用 ctx.interval，默认每 10 分钟一轮
  probeAll(reason: string): Promise<void>
  probeOne(key: string): Promise<ProbeVerdict>
  /** 免费模型：每轮全量；付费模型：仅在 cooling/degraded 时探测，避免无谓计费 */
}

// 轮转策略（伪代码）
async function round() {
  const free = pool.all().filter(e => e.cost === 'free')
  const paidTroubled = pool.all().filter(e => e.cost === 'paid' && e.health !== 'available')
  await runLimited([...free, ...paidTroubled], concurrency = 3, entry => probeAndWriteBack(entry))
}

async function probeAndWriteBack(entry: ModelEntry) {
  const r = await probeOne(ctx, entry)
  pool.markProbe(entry.key, r.verdict, r)      // 写回：lastProbe / health / cooldownUntil
  // 状态迁移由 verdict.ts 决定：
  //   ok            → health=available, failCount=0, cooldownUntil=0, 取消屏蔽
  //   throttled     → health=degraded, cooldown=min(60s * 2^n, 30min)
  //   timeout       → health=degraded, cooldown 同上
  //   auth/region   → health=dead（需人工/配置修复），进入 picker 屏蔽
  //   unavailable   → health=cooling, cooldown=指数退避
  // 变更后 → ctx.llm.emitAdaptersUpdated?.() 触发目录刷新
}
```

关键：**探针写回即状态迁移**，池里每次变更都广播 `subscribe`，面板与 catalog 屏蔽都读同一份状态。

### 3.3 选择策略（免费优先）

```ts
// src/schedule/scoring.ts
export function score(e: ModelEntry, now: number, stats: EntryStats): number {
  let s = 0
  s += e.cost === 'free' ? 1000 : 0          // 硬性：免费永远排在付费前面
  s += e.priority                             // 同成本内按配置优先级
  if (e.health === 'available') s += 50
  if (e.health === 'degraded') s -= 20
  if (e.health === 'cooling' && e.cooldownUntil > now) s -= 500   // 冷却中基本不选
  s -= Math.min(e.failCount, 10) * 15         // 连续失败降权
  s -= Math.min(stats.avgLatencyMs ?? 0, 20000) / 1000            // 延迟轻惩罚
  if (e.halfOpen) s += 10                     // 半开试探优先给一次机会
  return s
}
```

```ts
// src/schedule/scheduler.ts
export interface ScheduleRequest {
  requirement?: CapabilityRequirement   // 上下文窗口 / 多模态 / reasoning
  allowPaid?: boolean                   // 默认 true
  exclude?: string[]                    // 本次尝试已失败过的 key
  now?: number
}

export interface ScheduleResult {
  primary: ModelEntry
  fallbacks: ModelEntry[]               // 已排序的候选链
  reason: string                        // 例如 'free:ok' | 'free:all-cooling→paid' | 'paid:fallback'
}

export function createScheduler({ pool, config }): {
  plan(req: ScheduleRequest): ScheduleResult
}
```

规则（按序）：

1. 过滤：能力不足、`cooldownUntil > now`、`health === 'dead'`、`exclude` 命中的条目全部剔除。
2. 若 `allowPaid === false`，只保留 `cost === 'free'`。
3. 按 `score` 降序排序，得到候选链。
4. **免费优先硬规则**：只要候选链里存在 `cost === 'free'` 且 `health ∈ {available, degraded}` 的条目，`primary` 必为其中最高分者；付费条目全部作为 fallback。
5. 免费全不可用时（全部 cooling/dead，或探测为 dead），才把 `primary` 落到付费最高分者，`reason` 记为 `free:all-unavailable→paid`。
6. 免费模型冷却到期时，下一次 `plan()` 会把它以 `halfOpen` 身份提到候选链前部，形成「自动恢复」。

### 3.4 故障切换

```ts
// src/failover/classify.ts
export type FailureKind = 'retryable' | 'throttled' | 'auth' | 'permanent' | 'aborted'
export function classifyError(err: unknown): FailureKind
// 依据：ctx.llm 归一化后的 LlmFailure.code（TODO: 按 DSH 实际 API 补齐具体错误码枚举）
//   429 / 5xx / 超时 → retryable | throttled
//   401 / 403        → auth（该条目直接 dead，不再重试）
//   400 / 不支持的参数 → permanent（仅切换到其他模型）
//   AbortError       → aborted（直接抛出，不计数）
```

```ts
// src/failover/failover.ts —— 主循环伪代码
export async function runWithFailover(autopilot, request): Promise<AutopilotResult> {
  const attempts: AttemptRecord[] = []
  const excluded: string[] = []
  let lastError: unknown

  while (attempts.length < config.maxAttempts) {          // 默认 3 次尝试、最多切 3 个模型
    const { primary, fallbacks } = scheduler.plan({
      requirement: request.require,
      allowPaid: request.allowPaid ?? true,
      exclude: excluded,
    })
    if (!primary) break

    for (let retry = 0; retry <= config.maxRetriesPerModel; retry++) {   // 同模型内重试
      try {
        const stream = ctx.llm.stream({ provider: primary.provider, model: primary.model, ...request.call })
        pool.markSuccess(primary.key)
        attempts.push({ key: primary.key, ok: true, retry })
        return { model: primary, attempts, stream, fallbacks }
      } catch (err) {
        const kind = classifyError(err)
        attempts.push({ key: primary.key, ok: false, kind, retry })
        lastError = err
        if (kind === 'aborted') throw err
        if (kind === 'auth') { pool.markProbe(primary.key, 'auth'); break }       // 直接换模型
        if (kind === 'permanent') break                                           // 换模型
        pool.markFailure(primary.key, kind)
        if (!config.retrySameModel) break
        await backoff(retry)                                                      // 指数退避 + 抖动
      }
    }
    excluded.push(primary.key)         // 该模型本轮流失败 → 进入排除集，下一轮 plan() 自动降级
  }

  throw lastError ?? new Error('model-autopilot: no candidate model available')
}
```

冷却与恢复（breaker）：

```
failCount += 1
冷却时长 = min(baseCooldown * 2^(failCount-1), maxCooldown)   // 默认 60s → 30min
成功后 failCount = 0、cooldownUntil = 0、health = available
冷却到期 → halfOpen = true；下一次真实调用成功则恢复，失败则冷却翻倍
探针轮转同时检查 halfOpen 条目，形成两条恢复通道（真实调用 / 主动探测）
```

### 3.5 对外统一入口

上层「只提需求」有两个等价入口：

```ts
// src/autopilot.ts
export interface AutopilotRequest {
  intent?: string                       // 人类可读的需求描述（用于日志/面板，不参与选型）
  messages: Message[]                   // 对话消息
  require?: {                           // 能力需求
    minContextWindow?: number
    input?: ('text' | 'image')[]
    reasoning?: boolean
  }
  allowPaid?: boolean                   // 默认 true；false = 只用免费
  signal?: AbortSignal
}

export interface AutopilotResult {
  model: { provider: string; model: string; key: string; cost: CostClass }
  attempts: AttemptRecord[]
  fallbacks: ModelEntry[]
  stream: AsyncIterable<StreamChunk>
}

export interface Autopilot {
  /** 唯一对外入口：给定需求，返回选中的模型与可迭代的流。 */
  run(req: AutopilotRequest): Promise<AutopilotResult>
  /** 仅做选型（面板预览 / 测试用） */
  plan(req: ScheduleRequest): ScheduleResult
  status(): PoolSnapshot
}
```

```ts
// 入口 A：显式 API（命令、脚本、其他插件调用）
const result = await autopilot.run({ intent: '修这个 TS 报错', messages, require: { input: ['text'] } })
for await (const chunk of result.stream) { /* ... */ }

// 入口 B：虚拟 provider（推荐）—— 用户只在模型选择界面选 "Autopilot"
ctx.llm.registerAdapter(['autopilot'], {
  async *stream(options) {
    const r = await autopilot.run({ messages: options.messages, allowPaid: options.allowPaid })
    yield* r.stream                       // 若首模型失败发生在首帧之前，run() 内部已完成切换
  },
  listModels: () => [{ id: 'auto', name: 'Autopilot（自动选择 / 免费优先）' }],
  // TODO: 按 DSH 实际 API 补齐 —— adapter 接口必填项（resolveModelInfo / retryPolicy / 计费等）
})
```

---

## 4. 模型选择界面动态屏蔽（附加需求）

结论：**不需要改客户端 UI**。选择器的数据来自 host：

```
session.modelCatalog() → buildModelCatalog(ctx)
   → ctx.llm.listProviders() / ctx.llm.listModels(providerId) / resolveModelInfo(...)
```

因此只要在 host 侧包一层 `listModels`，失效模型就从目录里消失，模型选择界面自动不再列出。

```ts
// src/catalog-filter.ts
export function installCatalogFilter({ ctx, pool }) {
  const original = ctx.llm.listModels.bind(ctx.llm)
  let disposed = false

  ctx.llm.listModels = async (provider: string) => {
    const models = await original(provider)
    if (disposed) return models
    return models.filter(m => !pool.shouldHide(provider, m.id))
  }

  const unsub = pool.subscribe(() => ctx.llm.emitAdaptersUpdated?.())

  ctx.effect(() => () => {                 // fiber 释放时严格还原，避免污染
    disposed = true
    ctx.llm.listModels = original
    unsub()
  }, 'model-autopilot: catalog-filter')
}
```

屏蔽判定（`pool.shouldHide`）三条硬约束：

1. 只屏蔽 **暂时失效**：`health === 'dead'`（auth/region-blocked 且探针连续失败）或 冷却超过阈值（如 > 5 分钟）。
2. **不屏蔽唯一可用项**：若该 provider 过滤后为空，则原样返回（避免选择器里整组消失）。
3. **不屏蔽当前选中项**：与 `ctx.agentDefaultModel.currentSelection()` 比对，命中则保留（避免正在用的模型从界面消失）。

刷新链路：探针/失败导致状态变化 → `pool.subscribe` → `ctx.llm.emitAdaptersUpdated()` → 客户端 catalog store 重新 `load()` → 选择界面即时更新（客户端侧 `catalog.store.subscribe` 已存在，无需我们写 UI 代码）。

降级方案（若上面某条在实测中不成立）：
- 方案 B：客户端半身在 `sidebar.right.pane.tab` 只做「展示 + 一键解除屏蔽」，不改选择器。
- 方案 C：核对 `dsh-client-ui-settings-models` 是否走同一 `modelCatalog`；若它另读配置，则同一包装需覆盖其数据源。`// TODO: 实测核对`

---

## 5. 硬性要求落点

| 要求 | 落点 |
| --- | --- |
| 免费模型优先 | `scoring.ts` 的 `cost === 'free' ? +1000`，且 `scheduler.plan()` 第 4 条硬规则独立于分值 |
| 探针必选 | `prober.start()` 在 `apply()` 里无条件挂载；免费模型每轮全量探测；面板显示 `lastProbe` |
| 失效模型动态屏蔽 | `catalog-filter.ts` 包装 `listModels` + `emitAdaptersUpdated()` |
| 6 家模型商 + 免费插件统一抽象 | `pool/types.ts` 的 `ModelEntry`，来源 `ctx.llm.listProviders()` + 配置覆盖 |
| 左侧栏入口 | client 半身 `sidebar.panellist` 槽位注册 |

---

## 6. 实现进度（阶段 1：模型池 + 探针）

已完成并在这台机器上真实运行：

| 规划项 | 落地文件 | 状态 |
| --- | --- | --- |
| 模型池建模（统一条目） | `src/pool/types.js`、`src/pool/pool.js` | ✅ 200 条目 / 28 provider |
| 状态迁移规则表 | `src/pool/transitions.js` | ✅ 纯函数 + 单测覆盖 |
| 免费判定 | `src/config.js` `freeClassOf`、`src/pool/free-channels.js` | ✅ 17 免费 / 11 付费 |
| 探针（单模型） | `src/probe/probe.js` | ✅ 首帧判定 + 超时竞速 |
| 失败分类 | `src/probe/classify.js` | ✅ 码优先、文案兜底 |
| 探针调度 | `src/probe/prober.js` | ✅ 免费全量 / 付费异常才探 / 预算并发 |
| 状态持久化 | `src/store.js` | ✅ 原子写盘 + provider 元信息 |
| host 装配 | `src/index.js` | ✅ 注入后 active |
| 调度 / 故障切换 / 界面屏蔽 / 左侧栏 | `src/schedule/`、`src/failover/`、`src/catalog-filter/`、`src/client.js` | 全部 ✅ |

实现过程中修正的三处规划偏差：

1. **不能用 tsc**：本机安装包剥离了 `.d.ts`，也没有带 `packages/` 的源码 checkout。改为可运行 ESM + JSDoc，`build.sh` 只做语法校验与同步到 `lib/`。
2. **不能给 ctx 赋属性**：cordis 的 Context 是 Proxy，`ctx.x = y` 会抛 `cannot set property "x" without provide`。改为模块级引用 + `currentService()`。
3. **免费判定不能只看 id 片段**：真实池里 `lobsterai / qoder / trae / cline / zcode / gemini / deepseek-web` 都是免费渠道却没有 `free` 字样，只识别出 2 个。改为「显式名单 → 已知渠道清单（含 `modlens-` 前缀剥离）→ 片段兜底」三级判定。

