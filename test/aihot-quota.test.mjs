/**
 * AIHOT 额度情报测试：解析、映射、打分、失败降级。
 *
 * 清单形状来自真实抓取（https://aihot.news/free-tokens.md），这里用最小样本覆盖
 * 解析规则与排序影响。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFreeTokens, parseDeadline, resolveProviderId, summarize, groupByProvider } from '../src/aihot/free-tokens.js'
import { createQuotaIntel } from '../src/aihot/quota-intel.js'
import { scoreEntry } from '../src/schedule/scoring.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {} }

const SAMPLE = `# 大模型免费额度与免费 API：Token 羊毛

- 更新：2026-11-20 22:08（北京时间）

## 每天都能领（2 个）

### Agnes AI 文本、图片与视频模型限免

- 提供方：Agnes AI
- 能领多少：免费（指定 Flash 型号限时免费）
- 怎么领：在中国站用免费／默认账号创建免费 API 密钥后调用
- 能用在：Agnes 3.0 Flash、Agnes Video 2.5 Flash
- 门槛：仅免费密钥、付费订阅不适用
- 有效期：长期
- 核实：2026-11-20 22:08（北京时间）；厂商官方页面
- 去领：https://wiki.agnes-ai.cn/zh-Hans/docs/pricing

### 豆包电脑版每天签到领 200 额度

- 提供方：豆包
- 能领多少：200 额度（每天 · 未有适用的额度单独售价，不折钱）
- 怎么领：在豆包电脑版签到
- 能用在：豆包 2.1 Turbo
- 门槛：限产品内使用、仅电脑端
- 有效期：每笔发放后 30 天
- 核实：2026-11-14 03:51（北京时间）；厂商官方页面
- 去领：https://example.com/doubao

## 其他福利（1 个）

### 硅基流动实名认证送 16 元代金券

- 提供方：硅基流动
- 能领多少：¥16（面值）
- 怎么领：完成实名认证后手动领
- 能用在：平台上的所有模型
- 门槛：要实名
- 有效期：领取后 180 天
- 截止：2027-01-01 00:00（北京时间）
- 核实：2026-11-15 10:00（北京时间）；厂商官方页面
- 去领：https://www.siliconflow.cn/news/od7wj9rr23p95uhihmhrombp
`

test('解析 Markdown 清单：分组、字段、截止时间', () => {
  const entries = parseFreeTokens(SAMPLE)
  assert.equal(entries.length, 3)

  const agnes = entries.find((entry) => entry.provider === 'Agnes AI')
  assert.ok(agnes)
  assert.equal(agnes.cadence, 'daily')
  assert.equal(agnes.productOnly, false)
  assert.equal(agnes.claimUrl, 'https://wiki.agnes-ai.cn/zh-Hans/docs/pricing')
  assert.equal(agnes.deadlineAt, 0, '没有截止就是 0')
  assert.ok(agnes.verifiedAtMs > 0)

  const doubao = entries.find((entry) => entry.provider === '豆包')
  assert.equal(doubao.productOnly, true, '「限产品内使用」要能识别')

  const silicon = entries.find((entry) => entry.provider === '硅基流动')
  assert.equal(silicon.cadence, 'other')
  assert.equal(silicon.deadlineAt, Date.parse('2027-01-01T00:00:00+08:00'))
  assert.equal(silicon.expired, false)
})

test('厂商名映射到宿主 provider id；映射不到返回 null', () => {
  assert.equal(resolveProviderId('Agnes AI'), 'agnes')
  assert.equal(resolveProviderId('字节 TRAE'), 'trae')
  assert.equal(resolveProviderId('MiniMax'), 'minimax')
  assert.equal(resolveProviderId('阿里云百炼'), 'bailian')
  assert.equal(resolveProviderId('某个没装过的厂商'), null)
})

test('按 provider 归拢：区分「有可用额度」与「仅产品内使用」', () => {
  const groups = groupByProvider(parseFreeTokens(SAMPLE))
  assert.ok(groups.get('agnes'))
  assert.equal(groups.get('agnes').hasUsableQuota, true, 'Agnes 是真 API 额度')
  // 豆包没有映射；硅基流动映射到 siliconflow
  assert.equal(groups.get('siliconflow').hasUsableQuota, true)
  assert.equal(groups.get('siliconflow').expired, false)
})

test('summarize 统计可用/过期通道数', () => {
  const summary = summarize(parseFreeTokens(SAMPLE))
  assert.equal(summary.total, 3)
  assert.ok(summary.usableProviders >= 2)
  assert.equal(summary.expiredProviders, 0)
  assert.ok(summary.providers.siliconflow.nextDeadline > 0)
})

test('过期条目要能被识别（截止时间已过）', () => {
  const past = SAMPLE.replace('2027-01-01 00:00', '2020-01-01 00:00')
  const entries = parseFreeTokens(past)
  const silicon = entries.find((entry) => entry.provider === '硅基流动')
  assert.equal(silicon.expired, true)
  const groups = groupByProvider(entries)
  assert.equal(groups.get('siliconflow').expired, true)
  assert.equal(groups.get('siliconflow').hasUsableQuota, false, '过期的不算可用额度')
})

test('额度情报影响打分：有额度加分、过期减分', () => {
  const config = normalizeConfig({})
  const context = { now: Date.now(), config }
  const entry = {
    key: 'agnes/Agnes-3.0-Flash',
    provider: 'agnes',
    model: 'Agnes-3.0-Flash',
    cost: 'free',
    priority: 0,
    health: 'available',
    failCount: 0,
    cooldownUntil: 0,
    lastProbe: null
  }
  const plain = scoreEntry(entry, context)
  const withQuota = scoreEntry(entry, {
    ...context,
    quota: { providers: { agnes: { hasUsableQuota: true, expired: false } } }
  })
  const withExpired = scoreEntry(entry, {
    ...context,
    quota: { providers: { agnes: { hasUsableQuota: false, expired: true } } }
  })
  assert.ok(withQuota > plain, '有额度的通道应加分')
  assert.ok(withExpired < plain, '额度过期的通道应减分')
})

test('同步失败不影响调度：情报为空时排序退回原逻辑', async () => {
  const config = normalizeConfig({})
  const intel = createQuotaIntel({
    config,
    logger,
    fetch: async () => {
      throw new Error('network down')
    }
  })
  const result = await intel.sync('test')
  assert.equal(result.ok, false)
  assert.match(result.error, /network down/)
  assert.equal(intel.quota(), null, '失败时没有快照')
  assert.equal(intel.status().lastError, 'network down')
  // 调度器拿到空 providers → 相当于没有情报
  assert.deepEqual(intel.quota()?.providers ?? {}, {})
})

test('同步成功：快照可用、状态可读', async () => {
  const config = normalizeConfig({})
  const intel = createQuotaIntel({
    config,
    logger,
    fetch: async () => ({ entries: parseFreeTokens(SAMPLE), fetchedAt: 12345, sourceUrl: 'x' })
  })
  const result = await intel.sync('test')
  assert.equal(result.ok, true)
  assert.equal(result.entries, 3)
  assert.ok(intel.quota().providers.agnes)
  const status = intel.status()
  assert.equal(status.fetchedAt, 12345)
  assert.equal(status.lastError, null)
  assert.equal(status.usableProviders >= 2, true)
})
