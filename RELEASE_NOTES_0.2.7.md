## v0.2.7 — 0次尝试时给出可操作诊断

### 病灶
`attempts.length === 0` 时（池子无可用候选，一次都未试），错误消息统一报「所有候选模型均失败（0 次尝试，0 次失败）」，用户看到以为插件没跑或出了 bug。

### 改法
`lib/failover/failover.js` + `src/failover/failover.js` 耗尽错误构造改为三分支：
- **无候选（0次）**：`「无可用候选，一次都未尝试（N 个本轮已试失败，N 个 dead，N 个冷却中，N 个付费被 allowPaid=false 挡住）。等待冷却到期或探针恢复后自动重试。」`
- **预算耗尽**：保留原措辞
- **候选耗尽（>0次）**：保留原措辞

### 验证
- `npm test` 193 单测全绿 + verify-build-sync 29 文件一致
- `node --check` 语法通过
- 热重载后 active
