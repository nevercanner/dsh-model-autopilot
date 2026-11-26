# v0.2.9 — 兜底通道同样按 family 认 provider

v0.2.8 修掉了「付费账号被判免费」的主路径，这里是同一类问题的一处漏网：

## 病灶

`pickTerminalFallback`（终极兜底）内部按 **精确 provider 字符串**过滤候选：

```js
.filter((entry) => entry.provider === target.provider)
```

配置写 `terminalFallback: { provider: 'deepseek-account' }`，池里只有转发 id `modlens-deepseek-account` 时，**一个都匹配不上**，兜底静默返回 null —— 表现为「免费全挂 + 兜底明明可用却不生效」，最终报"所有候选均失败"。

另外该函数的注释还写着「兜底不受 `allowPaid` 限制」，与 v0.2.8 的新语义完全相反。错误注释比没注释更危险：下一个改这里的人会照着它把闸门拆掉。

## 改了什么

1. 兜底候选过滤改 `sameFamily(entry.provider, target.provider)` —— 剥 `modlens-` 前缀后比较，`deepseek-account` 与 `modlens-deepseek-account` 同族。
2. 注释改写为该函数的真实行为：两道闸（`allowPaid`；`schedule.excludeProviders` 按 family 匹配）。

## 验证

```bash
npm test            # 204 全绿
npm run verify:sync # 30 个文件一致 / 15 项关键能力就位
```

## 装法

```bash
npm i github:nevercanner/dsh-model-autopilot#v0.2.9
```

热重载即生效。
