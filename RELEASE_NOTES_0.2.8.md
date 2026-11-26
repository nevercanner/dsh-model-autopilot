# v0.2.8 — 付费账号不再被当成"免费候选"烧

## 病灶：modlens 转发前缀让 `paid.providers` 形同虚设

宿主里同一个真实渠道会有两个 id：

- `deepseek-account`（直连）
- `modlens-deepseek-account`（modlens 转发，同一笔钱）

免费名单 `matchesFreeChannel` 一直会剥掉 `modlens-` 前缀再判定，但**付费名单、排除名单、置顶名单全是精确字符串比较**。于是：

```yaml
paid:
  providers: [minimax-cn, deepseek-account]   # 写了 deepseek-account
schedule:
  excludeProviders: [autopilot, deepseek-account]  # 也写了
```

`modlens-deepseek-account/deepseek-v4-pro` 两边都没命中，被判成**免费**、进了池、被调度器选中。同一条目在 `pool-state.json` 里的探针细节是：

```
Insufficient Balance (request_id: 99d0b15e-...) / ACCOUNT_QUOTA
failCount: 7, hiddenFromPicker: true
```

即：插件以为在"省免费额度"，实际在花真钱，把账号余额点空了。

## 第二处：`free.defaultFree: true` 会把自有 API Key 判成免费

白名单模式的语义是"paid.providers 之外一律免费"，它**对将来新接进来的 provider 同样生效**。用户接上官方 API Key（`deepseek-official`，按 token 计费）后，它立刻被算成免费候选——实测 `lastResult` 就是 `deepseek-official/deepseek-flash`，`cost: free`。

## 第三处：付费兜底不受 `allowPaid` 约束

`pickTerminalFallback` 的注释原文是"兜底不受 allowPaid 限制"，于是配了 `allowPaidByDefault: false`（免费优先、不落付费）时，免费池一耗尽照样调付费账号。语义自相矛盾：用户要的是不烧钱，插件却在偷偷兜底扣费。

## 改了什么

1. **新增 `src/pool/provider-id.js`**：`providerFamily` / `sameFamily` / `matchesProviderList` / `familyIndex` / `lookupByFamily`。凡是"拿 provider id 比对一份名单"的地方统一走它——剥完 `modlens-` 前缀、小写后再比。
2. **`freeClassOf` 判定顺序重排**，且全部按 family 匹配：
   `paid.providers` → `free.providers` → `paid.impliedProviders`（新）→ 已知免费通道 → `free.patterns` → `free.defaultFree`。
3. **新增 `paid.impliedProviders` 安全网**（默认 `['deepseek-official','deepseek-account']`）：按量计费/账号类 provider **无论 `defaultFree` 怎么配都不判免费**。配置里只能追加，删不掉内置两条；真要放行得显式写进 `free.providers`（用户账号事实优先）。
4. **`pool.js`**：`excludeProviders` 与 `paid.priorities` 改 family 匹配。
5. **`scoring.js`**：`providerOrder` 置顶改 family 匹配（置顶 `minimax-cn` 时 `modlens-minimax-cn` 同序）。
6. **`catalog-filter`**：受保护 provider 集合改 family 归一化，排除生效时转发变体一起受保护。
7. **`failover.js`**：
   - `terminalFallback` 服从 `allowPaid`（`allowPaidNow` 守卫）——`allowPaid=false` 时跳过付费兜底并记 info 日志；
   - `terminalFallback` 服从 `excludeProviders`（排除后兜底也不碰）；
   - `gatewayProviders`（多车道路由网关）与 pinned 限流延长改 family 匹配。
8. **`matchesFreeChannel` 只认名单命中**，去掉了那条隐藏的 `inner.includes('free')` 子串猜测——子串兜底是 `free.patterns` 的职责。这样"把某个 id 从名单里删掉"就真的是删掉了。
9. **`scripts/verify-build-sync.mjs`**：特性标记从已删除的 `openference` 换成 `matchesFreeChannel` / `matchesProviderList` / `familyIndex` / `impliedProviders` / `allowPaidNow`，15 项。

## 验证

```bash
npm test     # 204 个测试全绿（新增 test/provider-family.test.mjs 10 条）
npm run smoke # 端到端冒烟通过
```

运行态实测（热重载后）：

| provider | 修复前 cost | 修复后 cost |
| --- | --- | --- |
| `deepseek-official/*` | free（会烧自有 Key） | **paid** |
| `modlens-deepseek-account/deepseek-v4-pro` | free | **不进池**（排除名单按 family 生效） |
| `deepseek-account/*` | 不进池 | 不进池 |
| `minimax-cn/*` | paid | paid |
| `agnes/*` | free | free |

池子：58 条 / 免费 53 / 付费 5，`allowPaidByDefault: false` 下调度只会用免费候选。

## 装法

```bash
cd ~/.dsh/profiles/<profile>
npm i github:nevercanner/dsh-model-autopilot#v0.2.8
```

或已有 checkout 直接 `git pull && dev_reload_package`。热重载即生效，无需重启宿主。
