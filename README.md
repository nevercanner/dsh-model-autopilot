# @dsh-external/dsh-model-autopilot

DSH 层自动选模型：**免费优先 + 探针 + 故障切换 + 选择界面动态屏蔽 + 左侧栏面板**。上层只提需求，选型和切换由插件完成。

已完成：模型池、探针、调度器、故障切换、虚拟 provider `autopilot`、选择界面屏蔽、左侧栏入口与状态面板。
未完成：无（后续可做的是把面板的单项探测做成可点选、加历史曲线）。

## 左侧栏入口

两处注册缺一不可：

| 位置 | 作用 |
| --- | --- |
| `sidebar.panellist`（`id: model-autopilot`） | 左侧栏的导航图标 |
| `main`（`key: model-autopilot`，同名） | 点击后主区域渲染的面板 |

原因：panellist 只负责「点它 → `ctx.layout.selectPanel(id)`」，真正渲染面板的是
`renderSlot("main", {}, { entryKey: activePanelId })`（`dsh-client-ui-layout/lib/client.js:119`）。
只注册入口会点出一个空白主区域。

面板数据来自本插件自己的 same-origin 路由 `/api/model-autopilot`，不用 Remote（这里只需读状态 + 触发探测）。
面板里每个模型条目右侧有独立的**探测按钮**（`POST /probe?model=<provider/model>`）：点击期间该行按钮置灰，
返回后只替换这一行（健康/冷却/最近判决都可能是新的），失败会在这行下面显示原因，不整页重载。

### 安全边界

- 只接受**回环地址**（`req.socket.remoteAddress`）—— webserver 可能监听 `0.0.0.0`，这条路由不走宿主登录 fence；
- `POST /probe` 额外要求**同源 Origin**，不接受无 Origin 的脚本调用（它会真的向上游发请求）。

```bash
# 读状态：回环即可，直接 200
curl -s http://127.0.0.1:2202/api/model-autopilot | head -c 300

# 触发单条探测：没有 Origin 头会被拒（这是设计，不是 bug）
curl -s -X POST 'http://127.0.0.1:2202/api/model-autopilot/probe?model=our-free-model/xxx'
# → {"ok":false,"error":"probe requires a same-origin page request"}

# 模拟页面发起的同源请求
curl -s -X POST \
  -H 'Origin: http://127.0.0.1:2202' \
  'http://127.0.0.1:2202/api/model-autopilot/probe?model=our-free-model/xxx'
# → {"ok":true,"key":"...","result":{...},"entry":{...}}
```

**为什么这样设计**：这条路由会真实消耗上游额度（免费通道按 session 计配额），不能让任意本地进程拿它当探测器；
面板（同源页面）不受影响。排查时若不确定，先看返回的 `error` 字段，不要放宽鉴权。

### client 半身注册自愈

运行时注入的插件经常「host active 但 client 不出现」。实测踩到三层原因，`src/client-half.js` 逐层处理：

1. **Loader entry 短暂 `disabled: true`** → `client-modules.processOne()` 跳过它。代码安排一次解除，但**不 early-return**（它随时会自己翻正）。
2. **`resolveMeta` 把解析失败缓存成 `null`**（`pkgMeta`）→ 之后每次扫描都读到 null。先清缓存再扫。
3. **`locatePkgJson` 依赖 `loader.internal.resolveSync` 的调用签名**（v1/v2 参数顺序不同），对不上时异常被吞成 undefined。清缓存仍失败就按它自己的缓存格式补一条 `{ packageName, meta: { clientPath, ... } }`，再让它走正常流程。

诊断结果落盘在 `pool-state.json` 的 `clientHalf` 字段：
`{ ok, changed, repaired, disabledCleared }`。
`disabledCleared: 0` **是正常值**——它是「这一轮解除了几个 disabled entry」的计数，不是「是否启用」；
是否注册成功只看 `ok`。

### 停用 / 重载时会发生什么（实测）

| 观察项 | 行为 |
| --- | --- |
| `/api/model-autopilot` 路由 | 随 fiber 卸载 —— 停用后返回 **401**（不再是 200） |
| 探针定时器 | 已清理：停用后 30s 采样**零写入** |
| 停用瞬间 | 正在进行的那一轮探测会跑完并**收尾写一次盘**，此后静止（不是泄漏） |
| 池状态 | 保留在 `pool-state.json`，重新启用按 key 恢复失败计数与冷却 |
| catalog-filter wrapper | 不套娃：每次重载 `calls` 从 0 重新计数，池仍枚举到全量 200 条 |
| client 模块表 | 卸载时清理，重新启用后 `clientHalf.ok` 回到 true |

## 装什么、怎么装

```bash
bash scripts/build.sh          # 构建（无编译依赖：语法校验 + 同步到 lib/）
# 注入器环境内：dev_inject_plugin D:\桌面\建个新插件
```

卸载：`dev_uninject_plugin dsh-model-autopilot`。
数据目录：`$DSH_HOME/model-autopilot/pool-state.json`（默认 `~/.dsh/model-autopilot/`）。

## 怎么选模型

**方式 A（推荐）**：在模型选择界面选 **Autopilot（自动选择 / 免费优先）**。虚拟 provider，请求进来后由本插件选免费可用模型、失败自动切换。

**方式 B**：代码里直接调

```js
import { currentService } from '@dsh-external/dsh-model-autopilot'
const result = await currentService().autopilot.run({ intent: '…', messages })
console.log(result.model.key, result.reason)  // our-free-model/... free:preferred
```

## 选择界面为什么看不到失效模型

宿主目录链路（已核实）：

```
dsh-client-ui-model-selection/lib/client.js:752   ctx.remote.session.modelCatalog()
dsh-api-session-controller/lib/index.js:563       buildModelCatalog(ctx)
                                                  → ctx.llm.listProviders() / listModels() / resolveModelInfo()
```

拦截 `ctx.llm.listModels()` 即可。`src/catalog-filter/` 做三件事：过滤 `pool.shouldHide()` 为真的条目；
状态变化去抖 300ms → `emitAdaptersUpdated()` 让界面重拉；**池自己走未过滤的读取口**（`pool.setRawListModels`），
否则被隐藏的条目会从池里消失、探针再也探不到、永远恢复不了（实测会少 11 条）。

`autopilot` 一律不过滤（纯函数层与 wrapper 层各一道判断）。

## 故障切换：实测行为

失败类型 → 分类 → 策略（`src/probe/classify.js` + `src/failover/breaker.js`）：

| 失败 | 码 / 文案 | 判决 | 策略 |
| --- | --- | --- | --- |
| 无有效凭据 | `MISSING_CREDENTIAL` | `auth` | 立即换模型；条目判 dead |
| 登录失效 | `INVALID_CREDENTIAL` / 401 / 403 | `auth` | 同上 |
| 额度耗尽 | `QUOTA` / `RATE_LIMIT` / `ACCOUNT_QUOTA` | `throttled` | **不原地重试**，直接换候选 |
| 中文额度文案 | 「所有账号均不可用（限流或额度耗尽）」「免费额度已用完」「积分不足」 | `throttled` | 同上（**必须带中文匹配**，否则会判成 unknown 走错策略） |
| 请求超时 | `TIMEOUT` | `timeout` | 同模型退避重试一次，再换模型 |
| 网络 / 服务不可用 | `TRANSPORT` / `SERVER` / `UNAVAILABLE` | `unavailable` | 同上 |
| 空响应 | `EMPTY_RESPONSE` | `empty` | 同上 |
| 地区封锁 | 「not available in your region」 | `region-blocked` | 立即换模型；判 dead |
| 上下文超限 | `CONTEXT_WINDOW_EXCEEDED` | `unavailable` | 换模型（不拉黑原模型） |

**已验证的链路**（`test/failover-switching.test.mjs`，17 条）：

- 每种失败类型都断言了「最终落到哪个模型」+「尝试链」+「池状态更新」；
- 首选模型失败 → 切次选，且**不会重复选同一个失败模型**（`exclude` 集合）；
- 全部候选不可用 → 抛 `AutopilotExhaustedError`，带 `attempts` 与映射后的宿主错误码；
- 宿主真实链路：`adapter.stream({provider:'autopilot'})` → failover → 真实上游，
  断言下游收到的 `provider/model` 已换成真实候选、**不残留 `autopilot/auto` 虚拟路由**。

**首选被跳过时能看到原因**：`GET /api/model-autopilot/plan` 的 `pinnedSkipped` 字段
会说明「为什么锁定的模型没被选中」（例如 `冷却至 +181s` / `dead`）。

### 首帧超时（防「卡了」）

`failover.firstFrameTimeoutMs`（默认 30s）：等「第一个语义帧」的上限。
provider 可能接受请求却一直不吐数据（上游卡死、连接半开、网关排队），
宿主的 stream idle 超时管不到首帧之前这一段 —— 没有这个上限，整条会话会无限挂起。

超时后按 `timeout` 处理并**直接换候选**（不原地重试，否则又白等一轮）。
`iterator.return()` **不能 await**：上游挂在 pending `next()` 上时，async generator 的
`return()` 会排队等那一笔完成，await 它等于把超时又变回无限等待（实测会挂死）。

### 目录屏蔽默认关闭

`catalogFilter.enabled` 默认 **false**。原因（实测）：宿主的 `selectModel()` 换模型前会调
`modelAvailable()`（`dsh-api-session-controller/lib/index.js:618-630`），它读的正是
`ctx.llm.listModels()`。过滤目录会让用户手动选择失效模型时被判 `session/model-unavailable`
→ 界面回弹（表现为「模型一直在跳、没法手动切」）。
目录是宿主的公共事实，不该被插件改写；失效模型改由调度器跳过（`health`/`cooldown` 已是候选过滤条件）。

## 选型优先级

### 首选 provider（锁定）——最高优先级

面板顶部有**首选 provider** 下拉（`POST /api/model-autopilot/preference`，存 `preference.json`，热重载/重启都保持）。
锁定后：

```
首选 provider（例如 minimax-cn / MiniMax-M3）   ← 第一
其余免费模型                                     ← 让位顺序仍是免费优先
其它付费模型
```

**锁定压过「免费优先」**：给某条通道充了限时额度（比如「5 小时额度」）时，
不用就是纯亏，所以「免费优先」是**默认策略**，不是硬规则 —— 锁定是用户显式的覆盖。
锁定项一旦失效（冷却/熔断/被摘除），**自动让位**给免费模型，日志记 `首选 … 当前不可用，回落到免费优先`。
可选精确到模型（`{provider, model}`），否则该 provider 内按分数挑。

### 默认（未锁定）时的规则

1. **过滤**：能力不够 / 本轮已失败 / `dead` / 冷却中（`cooldownUntil > now`）直接剔除。
2. **免费优先是硬规则**（`src/schedule/scheduler.js:87`）：只要还有可用的免费条目，就选它；
   付费候选全部排到 fallback —— 分数再高也越不过去。
3. **同成本组内**先按 `config.schedule.providerOrder` 置顶（默认 `['minimax-cn']`），
   再按 `scoring.js` 的分数：`priority + 健康加减分 − 连败惩罚 − 首帧延迟惩罚 + 半开加分`。
4. 免费全不可用才回落付费（`reason: free:none→paid`），付费组内 `minimax-cn` 排第一。
5. `minimax-cn` 额度耗尽（`QUOTA` / `RATE_LIMIT` → `throttled`）**不重试**，直接切下一个候选
   —— 与「插件重试不与上游重试叠加」同一条收敛方向（`src/failover/breaker.js:24-26`）。

### 切换当前会话用哪个模型

`POST /api/model-autopilot/select`（body：`provider`、`model`、`sessionId`）→
走宿主 `sessionController.selectModel()`：把 selection 装到该会话的**下一次请求**上，并在后台保存默认模型。
`GET /api/model-autopilot/sessions` 用于查 sessionId（注意它带 `session-` 前缀）。

## 重试：谁在重试、怎么不叠加

| 层 | 行为 | 次数 |
| --- | --- | --- |
| adapter 内部（各家 SDK） | provider 自己的重试 | 不可控 |
| 本插件 failover | 首帧前失败 → 同模型重试 → 换模型 | 3 模型 × 2 次 = 最多 6 |
| 宿主 `dsh-llm-retry` | `agent/request-error` 按 provider policy 重试整轮 | 默认 **5** |

宿主 5 次 × 插件 6 次 = 30 次上游请求。收敛：`providerRetryPolicy()` 返回 `maxRetries: 0` + 永不匹配的错误码
（`src/autopilot.js:108-116`），宿主不再重试整轮；failover 对 `throttled` 也不原地重试（`src/failover/breaker.js:24-26`）。

单次请求上游上界 = **6 次**。

## 配置（cordis.patch.yml 的 `config`）

```yml
- insert:
    - id: model-autopilot
      name: '@dsh-external/dsh-model-autopilot'
      config:
        probe: { intervalMs: 600000, timeoutMs: 45000, concurrency: 3, maxPerRound: 12, paidProbeWhenHealthy: false }
        cooldown: { baseMs: 60000, maxMs: 1800000, deadFailCount: 3, hideAfterMs: 300000 }
        free: { providers: [], channels: [...], patterns: [free], priorityBonus: 1000 }
        paid: { providers: [], priorities: {} }
        schedule:
          allowPaidByDefault: true
          excludeProviders: [autopilot]   # 虚拟 provider 永不进池（防递归）
          providerOrder: [minimax-cn]     # 同成本组内置顶（免费仍优先）；传 [] 关闭
          hostRetry: false                # false = 切断宿主 5 次重试
          failPenalty: 15
          degradedPenalty: 20
          latencyPenaltyPerSecond: 1
          halfOpenBonus: 10
        failover:
          maxModels: 3
          maxRetriesPerModel: 1
          retrySameModel: true
          backoff: { initialMs: 400, maxMs: 4000, jitterRatio: 0.2 }
        catalogFilter: { enabled: true, refreshDebounceMs: 300 }
```

首选 provider 不走配置（配置是只读的装配参数），它由用户在面板里设定，存在 `~/.dsh/model-autopilot/preference.json`。

## 当前实测（这台机器）

```
provider 29（含虚拟 autopilot，池外）→ 池内 28：免费 17 / 付费 11
模型条目 200：免费 167 / 付费 33，hidden 20，available 90 / degraded 44 / dead 20 / unknown 46
catalogFilter: { installed: true, calls: 819, hidden: 622, emits: 8, errors: 0 }
clientHalf:   { ok: true }            ← 左侧栏入口已注册（lib/client.js）
GET  /api/model-autopilot        → 200（回环）
POST /api/model-autopilot/probe  → 403（无同源 Origin，按设计拒绝）
```

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/index.js` | 装配：建池 → 注册虚拟 provider → 重建池 → catalog-filter → 探针 → client 自愈 → API |
| `src/config.js` | 配置归一化 + 免费判定 |
| `src/pool/*.js` | 池：装载、查询、写回、订阅、未过滤读取口、状态迁移规则表 |
| `src/probe/*.js` | 探针（最小请求 + 超时竞速）、失败分类、探测调度 |
| `src/schedule/*.js` | 能力过滤、打分、选型（免费优先硬规则） |
| `src/failover/*.js` | 可重试判定、退避、首帧探路 + 切换 + 写回 |
| `src/autopilot.js` | 统一入口 + 虚拟 provider adapter + 宿主重试策略 |
| `src/catalog-filter/*.js` | 选择界面屏蔽（visibility 纯函数 + 安装/还原） |
| `src/api.js` | 面板数据通道（回环 + 同源 + 只读/触发探测） |
| `src/client-half.js` | 浏览器半身注册自愈与原因落盘 |
| `src/client.js` | 浏览器半身：左侧栏入口 + `main` 面板（手写 ModuleLoader bundle） |
| `src/store.js` | 原子写盘存档 |

## 验证

```bash
npm test       # 82 条
npm run smoke  # 假宿主跑完整装配（含 catalog-filter、端到端选型、面板数据）
```

## 已知限制

- 首帧之后的失败不能切换模型，只写回一次失败并上抛。
- 虚拟 provider 不声明上下文窗口（不编造宿主预算）。
- 付费模型 `health` 长期停在 `unknown` 是刻意的，由真实调用驱动。
- `client-half.js` 触碰 client-modules 的私有字段（`pkgMeta` / `sources` / `table`）；宿主换内部结构时它会退化为「入口不出现」，不影响 host 侧选型。
- 面板不做单项探测的「点选」交互（API 支持 `{key}`），目前只提供整轮触发。

