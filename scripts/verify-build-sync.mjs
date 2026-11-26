/**
 * 构建产物一致性守卫。
 *
 * 病灶（2026-11-26 实锤）：
 *   scripts/build.sh 做的是 `rm -rf lib && cp -r src/. lib/` —— **单向覆盖**。
 *   开发期只改 lib/ 而没同步 src/ 时，一次 build 就把这些改动静默抹掉，
 *   而 git 只会看到「lib 被回退」，根因（src 落后）被掩盖。
 *
 *   真实案例：shortLabel()、api.js 的 current/next、freeClassOf 白名单模式、
 *   V4_FLASH_RE 正则、openference 免费通道 —— 五处都只存在于 lib，
 *   src 停留在旧架构，build 后全部消失，运行时表现为「下拉框又显示等待首次请求」
 *   和「workbuddy 又被当成付费」。
 *
 * 本守卫做两件事：
 *   1. src/ 与 lib/ 逐文件比对 —— 不一致就报错（build 没跑 或 src 落后）。
 *   2. 关键能力标记在两个目录里都必须存在 —— 防止「两边一致但都是旧版」。
 *
 * 运行：node scripts/verify-build-sync.mjs
 * 退出码 0 = 通过，1 = 不一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const LIB = path.join(ROOT, 'lib')

/** 目录下所有 .js，返回相对 base 的 POSIX 路径列表。 */
function listJs(dir, base = dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listJs(full, base))
    else if (entry.name.endsWith('.js')) out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out.sort()
}

/**
 * 关键能力标记：每一项都要在 src/ 和 lib/ 的同一相对路径文件里出现。
 * 这些是「功能不该被 build 抹掉」的唯一真源清单。
 */
const FEATURE_MARKS = [
  { file: 'failover/failover.js', mark: 'normalizeChunkIndex', why: 'reasoning-delta index 保护' },
  { file: 'failover/failover.js', mark: 'INDEXED_DELTA_TYPES', why: 'delta 类型白名单' },
  { file: 'autopilot.js', mark: 'shortLabel', why: '模型下拉框短标签' },
  { file: 'autopilot.js', mark: 'ap.plan?.({})', why: '动态显示当前/下一模型' },
  { file: 'api.js', mark: 'current:', why: '/plan 返回当前模型' },
  { file: 'api.js', mark: 'next:', why: '/plan 返回下一模型' },
  { file: 'config.js', mark: 'defaultFree', why: '免费白名单模式' },
  { file: 'config.js', mark: 'v4FlashFreeBonus', why: 'v4 flash 免费加分' },
  { file: 'config.js', mark: 'v4FlashPaidBonus', why: 'v4 flash 付费加分' },
  { file: 'schedule/scoring.js', mark: 'V4_FLASH_RE', why: 'v4 flash 命名变体正则' },
  { file: 'pool/free-channels.js', mark: 'matchesFreeChannel', why: '免费通道判定入口（名单只认命中，不做子串猜测）' },
  { file: 'pool/provider-id.js', mark: 'matchesProviderList', why: 'provider family 归一化（modlens 变体不漏网）' },
  { file: 'pool/provider-id.js', mark: 'familyIndex', why: 'providerOrder 置顶按 family 匹配' },
  { file: 'config.js', mark: 'impliedProviders', why: '按量计费 provider 永不判免费（defaultFree 也拦）' },
  { file: 'failover/failover.js', mark: 'allowPaidNow', why: '付费兜底受 allowPaid 约束' },
  { file: 'pool/free-channels.js', mark: 'DEFAULT_CHANNEL_EXPIRY', why: '限时免费额度到期日' },
  { file: 'pool/free-channels.js', mark: 'freeChannelStatus', why: '通道免费三态（含到期）' },
  { file: 'config.js', mark: 'channelExpiry', why: '到期表归一化 + freeClassOf 到期降级' },
  { file: 'pool/pool.js', mark: 'freeExpiresAt', why: '状态落盘带到期日' }
]

const failures = []

if (!fs.existsSync(SRC)) {
  console.error('FAIL: src/ 不存在')
  process.exit(1)
}
if (!fs.existsSync(LIB)) {
  console.error('FAIL: lib/ 不存在 —— 先跑 npm run build')
  process.exit(1)
}

// ── 1. 逐文件比对 ────────────────────────────────────────────────────────────
const srcFiles = listJs(SRC)
const libFiles = listJs(LIB)

for (const file of srcFiles) {
  if (!libFiles.includes(file)) {
    failures.push(`${file}: src 有但 lib 没有 —— 跑 npm run build`)
    continue
  }
  const a = fs.readFileSync(path.join(SRC, file), 'utf-8')
  const b = fs.readFileSync(path.join(LIB, file), 'utf-8')
  if (a !== b) failures.push(`${file}: src 与 lib 内容不一致 —— build 没跑或 src 落后`)
}
for (const file of libFiles) {
  if (!srcFiles.includes(file)) failures.push(`${file}: lib 有但 src 没有 —— lib 里可能是手改的，跑 npm run build 会被抹掉`)
}

// ── 2. 关键能力标记 ──────────────────────────────────────────────────────────
for (const { file, mark, why } of FEATURE_MARKS) {
  for (const [dir, label] of [[SRC, 'src'], [LIB, 'lib']]) {
    const full = path.join(dir, file)
    if (!fs.existsSync(full)) {
      failures.push(`${label}/${file}: 文件不存在（${why}）`)
      continue
    }
    if (!fs.readFileSync(full, 'utf-8').includes(mark)) {
      failures.push(`${label}/${file}: 缺少 ${mark}（${why}）`)
    }
  }
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} 项不一致`)
  for (const line of failures) console.error(`  - ${line}`)
  console.error('')
  console.error('修法：把 lib/ 侧的功能回填到 src/（src 是唯一真源），然后 npm run build。')
  process.exit(1)
}

console.log(`OK: src/ 与 lib/ 完全一致（${srcFiles.length} 个文件），${FEATURE_MARKS.length} 项关键能力全部就位。`)
