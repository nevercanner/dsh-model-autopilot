# v0.3.0 — 免费额度带到期日，12-31 之后不再当免费烧

## 你要的东西

新增的厂商免费 API 通道（凭据库里已有 Key）已进免费名单：

| 通道 | 凭据 | 免费到期 |
| --- | --- | --- |
| `sensenova`（商汤日日新） | `SENSENOVA_API_KEY` | 2026-12-31 |
| `spark`（讯飞星火） | `SPARK_API_KEY` | 2026-12-31 |
| `agnes` | `AGNES_API_KEY` | 2026-12-31 |
| `siliconflow` | `SILICONFLOW_API_KEY` | 2026-12-31 |
| `zhipu` | `ZHIPU_API_KEY` | 2026-12-31 |
| `bailian` | `BAILIAN_API_KEY` | 2026-12-31 |

`modlens-<渠道>` 转发变体同族同期限，自动跟随。

## 病灶：免费额度的"有效期"从来没被记过

厂商送的是**促销额度**（"12月31日前有效"），到期那天同一条调用开始按量计费。
此前的名单只写"这个通道免费"，不写"免费到哪天"——于是到期后插件继续把它当免费
候选正常调度，账单在 12-31 之后开始悄悄上涨。这与 v0.2.8 修的「付费账号被判成
免费」是同一类事故：**判定依据错了，钱就漏在那里**。

## 改了什么

- `src/pool/free-channels.js`
  - `DEFAULT_FREE_CHANNELS` 增加 `sensenova` / `spark`（原有 `deepseek-web` 保留）
  - 新增 `DEFAULT_CHANNEL_EXPIRY`：`agnes / siliconflow / bailian / zhipu / sensenova / spark / openference` = `2026-12-31`
  - 新增 `channelExpiry()`（按 family 查）、`isExpiryPassed()`（UTC 日界，到期日当天仍有效）、`freeChannelStatus()`（三态：不在名单 / 有效 / 已到期）
- `src/config.js`
  - `free.channelExpiry` 可覆盖内置到期表：`'2099-12-31'` 延长，`null` = 不设期限，非法日期忽略并保留内置值（手滑不该把额度判死）
  - `freeClassOf()`：名单命中但已到期的通道**直接返回 null**，并且不让 `free.defaultFree` 把它捞回免费队列
  - 新增 `freeChannelInfo()` 供状态接口/面板展示
- `src/pool/pool.js`：provider 元数据落盘带 `freeExpiresAt` / `freeExpired`

## 验证

```bash
npm test              # 213 全绿（新增 test/free-channel-expiry.test.mjs 9 条）
npm run verify:sync   # 30 文件一致 / 19 项关键能力就位
npm run smoke         # 冒烟通过
```

实测（热重载后 `/api/model-autopilot/` 的 provider 表）：

```
sensenova   free=channel   expiresAt=2026-12-31
spark       free=channel   expiresAt=2026-12-31
agnes       free=channel   expiresAt=2026-12-31
deepseek-web free=channel  expiresAt=null        # 账号渠道，不设期限
minimax-cn  free=false     (付费)
deepseek-official free=false (付费，永不判免费)
```

到期行为可复现：把 `free.channelExpiry.agnes` 设成 `2020-01-01`，`freeClassOf('agnes')`
立刻变成 `null`（付费），即使 `free.defaultFree: true` 也一样。

## 装法

```bash
npm i github:nevercanner/dsh-model-autopilot#v0.3.0
```

## 附：当前各通道的真实可用性（探针实测）

| 通道 | 状态 | 上游原文 |
| --- | --- | --- |
| `agnes` | ✅ available | first-token |
| `sensenova` | ✅ 3/4 available | 1 条 `inference exceeds tpm/rpm` |
| `spark` | ✅ available | first-token |
| `siliconflow` | ❌ 402 | `{"code":30001,"message":"Sorry, your ..."}` 余额不足 |
| `zhipu` | ❌ 429 | `{"code":"1113","message":"余额不足或无可用资源包"}` |
| `workbuddy` | ❌ 424 | `bili_throttle_terminated` 限流 |
| `deepseek-web` | ❌ dead | 登录态失效 |
| `bailian` | ⚠️ 被 `excludeProviders` 排除 | 不进池，插件不管它 |

即：能跑的真免费是 `agnes / sensenova / spark`；其余是**账号余额**问题，不是插件不认。
