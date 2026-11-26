## 病灶

`autopilot.js` 的重试循环在每轮失败后 `yield { type: 'reasoning-delta', text: notice }` 给宿主做进度提示，但该 chunk **没有 `index` 字段**。

宿主 `dsh-api-session-controller` 的 `expandAssistantStream` 对所有 delta 类 chunk 执行 `safeIndex` 校验：

```js
if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0))
  throw new TypeError(`${label} index must be a non-negative safe integer`);
```

`index = undefined` → 不是安全整数 → 整轮崩溃。

v0.2.4 的 `normalizeChunkIndex` 只保护了 `trackStream` 转发的**上游** chunk，漏掉了 adapter **自己 yield** 的进度帧。

## 症状

- 使用 autopilot/auto 时，只要有一次重试（任何候选首帧前失败），进度帧就把整轮杀死
- 报错：`reasoning-delta index must be a non-negative safe integer`
- 多个会话反复触发，因为每次 autopilot 兜底都会走重试循环

## 改了什么

`autopilot.js` 自产 chunk 补 `index: 0`（单 block 场景合法）：

```diff
- yield { type: 'reasoning-delta', text: notice }
+ yield { type: 'reasoning-delta', index: 0, text: notice }
```

src + lib 同步，193 单测 + 构建一致性守卫全绿。

## 怎么装

```bash
npm i dsh-external/dsh-model-autopilot@0.2.6
```
