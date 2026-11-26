## 病灶

`scripts/build.sh` 做的是 `rm -rf lib && cp -r src/. lib/` —— **单向覆盖**。开发期只改 `lib/` 而没同步 `src/` 时，一次 build 就把这些改动静默抹掉，git 只看到「lib 被回退」，根因（src 落后）被完全掩盖。

v0.2.4 发布后实测到五处功能只存在于 `lib/`，`src/` 停在旧架构：

- `autopilot.js` 的 `shortLabel()` —— 下拉框短标签
- `api.js` 的 `current` / `next` —— `/plan` 返回当前与下一模型
- `config.js` 的 `freeClassOf` 白名单模式 `defaultFree`
- `scoring.js` 的 `V4_FLASH_RE` 正则 —— v4 flash 命名变体
- `pool/free-channels.js` 的 `openference` 免费通道

build 之后这五处全部消失，运行时表现为「下拉框又显示『等待首次请求』」+「workbuddy 又被当成付费」。

## 用户会看到什么症状

- 上一个版本修好的功能「莫名其妙又坏了」，重装也没用 —— 因为构建过程本身在抹掉修复。
- 模型下拉框显示名回到「Autopilot（等待首次请求）/（无）」。
- 明明是免费通道的 workbuddy / openference 被排到付费模型后面。

## 改了什么

- 把 HEAD 版 `lib/` 的这五处回填到 `src/`（`src/` 是唯一真源），再 build，`src/` 与 `lib/` 29 个文件逐字节一致。
- 新增 `scripts/verify-build-sync.mjs`：
  1. `src/` 与 `lib/` 逐文件比对 —— 不一致就报错（build 没跑 或 src 落后）；
  2. 11 项关键能力标记在两边都必须存在 —— 防「两边一致但都是旧版」。
- `package.json`：`test` 末尾串接一致性守卫，另加 `npm run verify:sync` 独立入口。
- `.gitignore`：忽略 `node_modules/`、`*.tgz`、`*.bak`、`.dsh-bus/`（上一版误把本地运行时产物提交进去了，本版清掉）。

## 怎么验证

```bash
npm test        # 193 单测 + 一致性守卫，全绿
npm run smoke   # 端到端装配，listModels 输出 Autopilot（our-free-model/free-alpha / anthropic/claude-x）
npm run verify:sync
```

对抗式验证（守卫不是永远绿的假绿）：

- 删掉 `src/autopilot.js` 的 `shortLabel` → 守卫 `exit=1`，指出 `autopilot.js: src 与 lib 内容不一致`。
- 删掉 `lib/autopilot.js` 的 `shortLabel` → 同样 `exit=1`。
- 恢复后 `exit=0`。

## 怎么装

```bash
npm i dsh-external/dsh-model-autopilot@0.2.5
```

或直接在 DSH 插件市场安装 @dsh-external/dsh-model-autopilot。
