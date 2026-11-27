# v0.3.1 — 不再「0 次尝试」直接失败，余额不足的通道不再每半小时白打一次

## 你会看到的症状（改之前）

```
[第 1 轮未成功：model-autopilot: 无可用候选，一次都未尝试
（28 个冷却中，5 个付费被 allowPaid=false 挡住）。等待冷却到期或探针恢复后自动重试。；20s 后自动重试…]
[第 2 轮未成功：……一模一样]
```

一轮会话一次请求都没发出去就失败，等 20 秒重试，还是同样的结果。看起来像插件完全没干活。

## 三个病灶

**一、全池冷却时，插件直接放弃。**
`plan()` 是所有条目都在冷却时返回空候选，`failover` 立刻抛错，宿主 20 秒后重试还是空。
但冷却是根据**过去的**失败算出来的预测，不等于这一刻一定不通。真正的后果是：明明上游
只是刚才抖了一下，你却连一次尝试的机会都没有。

**二、402 / 余额不足被当成限流，走 60 秒→30 分钟的指数冷却。**
`402 {"code":30001,"message":"Sorry, your account balance is insufficient"}`、
`429 {"code":"1113","message":"余额不足或无可用资源包,请充值。"}` 这些被判成 `throttled`，
于是必然失败的通道每 30 分钟被捞出来白打一次 —— 池子里 `zhipu/glm-5.2` 的 `failCount`
被顶到 **197**，`modlens-zhipu/*` 全部 190+，这些条目的冷却水位一起把整个池子占满，
这才是「28 个冷却中」的来源。额度问题要靠充值恢复，等几分钟没有任何意义。

**三、排序把「探针已判定 degraded」的通道排在「available」前面。**
`siliconflow/…V4.1-Flash`（402 余额不足）因为 deepseek v4 flash 的 +500 加分，
排在 `agnes/agnes-3.0-flash`（探针可用）前面。于是每一轮都先白打 4~6 次必定 402 的请求，
把一轮的时间预算烧在确定失败的通道上。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `src/probe/classify.js` | 新增 `VERDICT.quota`：`402` / `1113` / 余额不足 / 无可用资源包 / 请充值 / `insufficient balance` / `payment required` 归这一类；纯限流（`tpm/rpm`、`rate limit`）仍是 `throttled` |
| `src/pool/transitions.js` | 新增 `quotaCooldown()`：额度类失败用独立的 `cooldown.quotaMs`（默认 6 小时，不走指数），探针与真实调用两条路径都走它 |
| `src/schedule/scheduler.js` | 新增 `schedule.coolingFallback`（默认开）：候选为空但存在冷却条目时，取「最早解冻」的免费条目打一次，`reason: free:cooling-last-resort`；只剩付费可用时仍按原规则回落付费，不抢免费优先 |
| `src/schedule/scoring.js` | 新增 `healthTier()`，`compareEntries` 先比健康档（available < unknown < degraded < cooling < dead），同档内再比分数 |
| `src/config.js` | 新增 `cooldown.quotaMs`（60s~24h）、`schedule.coolingFallback` |

## 验证

```
node --test test/*.test.mjs      215 通过 / 0 失败
node scripts/verify-build-sync.mjs  OK：30 文件一致，24 项关键能力就位
npm run smoke                     ✔ 冒烟通过
```

新增用例 6 条：
- 额度分类 4 条（中文余额不足 / 402 / 智谱 1113 / 纯限流仍是 throttled）
- 全池冷却时捞回最早解冻条目（`free:cooling-last-resort`）
- `coolingFallback=false` 恢复旧行为（`no-candidate:free-only`）
- 冷却候选中付费条目不抢免费优先

热重载后实测（`/api/model-autopilot/models`）：

```
冷却中 37
>=3h(额度类) 8      ← siliconflow 全族 402，cooldownLeft = 360min（改之前是 30min）
30min      21       ← 修复前已计入的旧冷却，会自然过期
可用: agnes×2  spark×2  sensenova×2  workbuddy×1  deepseek-modlens×1
```

## 装法

```bash
npm i github:nevercanner/dsh-model-autopilot#v0.3.1
```

## 还能调的两个旋钮

```yaml
schedule:
  coolingFallback: true      # 全池冷却时是否还试一次
cooldown:
  quotaMs: 21600000          # 额度耗尽的冷却（默认 6h）
```

把 `cooldown.quotaMs` 调小（比如 30 分钟）意味着充完值后恢复更快，但余额一直不足时
每一轮都会多打几次 402；调大则相反。
