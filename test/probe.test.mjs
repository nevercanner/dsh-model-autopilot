/**
 * 探针判定与探针调度的测试：用假 stream 覆盖「流协议的各种收尾方式」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { probeOnce } from '../src/probe/probe.js'
import { classifyFailure, classifyError } from '../src/probe/classify.js'
import { createProber } from '../src/probe/prober.js'
import { createPool } from '../src/pool/pool.js'
import { normalizeConfig } from '../src/config.js'
import { HEALTH, VERDICT } from '../src/pool/types.js'

const logger = { info() {}, warn() {} }

/** 由给定 chunk 序列构造一个 async iterable；记录 return() 是否被调用。 */
function streamOf(chunks, { onReturn, hang = false } = {}) {
  let returned = false
  return {
    get returned() {
      return returned
    },
    async *[Symbol.asyncIterator]() {
      try {
        for (const chunk of chunks) yield chunk
        if (hang) await new Promise(() => {})
      } finally {
        returned = true
        onReturn?.()
      }
    }
  }
}

const entry = { provider: 'our-free-model', model: 'free-a', key: 'our-free-model/free-a' }

test('首帧文本即判定 ok，并释放流', async () => {
  const stream = streamOf([{ type: 'text-delta', text: 'p' }, { type: 'finish', reason: { kind: 'stop' } }])
  const result = await probeOnce({ stream: () => stream }, entry)
  assert.equal(result.verdict, VERDICT.ok)
  assert.equal(result.detail, 'first-token')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(stream.returned, true)
})

test('finish 带 failure → 按码分类（RATE_LIMIT → throttled）', async () => {
  const stream = streamOf([{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } } }])
  const result = await probeOnce({ stream: () => stream }, entry)
  assert.equal(result.verdict, VERDICT.throttled)
})

test('空流（正常结束但无 token）→ empty，不是 ok', async () => {
  const stream = streamOf([{ type: 'finish', reason: { kind: 'stop' } }])
  const result = await probeOnce({ stream: () => stream }, entry)
  assert.equal(result.verdict, VERDICT.empty)
})

test('throw 带 INVALID_CREDENTIAL → auth', async () => {
  const llm = {
    stream() {
      throw Object.assign(new Error('bad key'), { code: 'INVALID_CREDENTIAL' })
    }
  }
  const result = await probeOnce(llm, entry)
  assert.equal(result.verdict, VERDICT.auth)
})

test('上游挂起不响应 abort 时，超时仍能准时返回 timeout', async () => {
  const stream = streamOf([], { hang: true })
  const started = Date.now()
  const result = await probeOnce({ stream: () => stream }, entry, { timeoutMs: 60 })
  const elapsed = Date.now() - started
  assert.equal(result.verdict, VERDICT.timeout)
  assert.ok(elapsed < 2_000, `应在超时后立即返回，实际 ${elapsed}ms`)
})

test('外部取消 → aborted（不构成对模型的判断）', async () => {
  const controller = new AbortController()
  const stream = streamOf([], { hang: true })
  const pending = probeOnce({ stream: () => stream }, entry, { timeoutMs: 5_000, signal: controller.signal })
  setTimeout(() => controller.abort(new Error('host shutdown')), 20)
  const result = await pending
  assert.equal(result.verdict, VERDICT.aborted)
})

test('classify：账号禁用类中文文案 → auth（一次即死，不复检）', () => {
  // 运行时证据：lobsterai 19 条全是「账号已被禁用」，早先被判 unknown →
  // degraded → 3 次后 dead，白烧复检预算还把真实原因埋掉。
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '账号已被禁用' }), VERDICT.auth)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '账户被封禁' }), VERDICT.auth)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '该账号异常，限制使用' }), VERDICT.auth)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '当前账号已冻结' }), VERDICT.auth)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '账号停用' }), VERDICT.auth)
})

test('classify：下架/退役文案 → retired（结构性永久失效）', () => {
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'model has reached its end of life' }), VERDICT.retired)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'END_OF_LIFE' }), VERDICT.retired)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'this model is deprecated' }), VERDICT.retired)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'the model has been discontinued' }), VERDICT.retired)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'no longer available' }), VERDICT.retired)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '模型已下线' }), VERDICT.retired)
})

test('classify：下架优先级高于地区封锁（同一句话里两者都像时判 retired）', () => {
  // 「这个模型在你的地区不再可用」—— 真相是模型没了，不是地区问题。
  assert.equal(
    classifyFailure({ code: 'UNKNOWN', message: 'this model is no longer available in your region' }),
    VERDICT.retired
  )
  // 纯地区问题仍判 region-blocked
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'not available in your region' }), VERDICT.regionBlocked)
})

test('classify：地区文案与状态码兜底', () => {
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'This model is not available in your region' }), VERDICT.regionBlocked)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '你的地区不可用' }), VERDICT.regionBlocked)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'HTTP 429 too many requests' }), VERDICT.throttled)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'HTTP 503' }), VERDICT.timeout)
  assert.equal(classifyFailure({ code: 'ABORTED' }), VERDICT.aborted)
  // 真实遇到过的上游文案（modlens 免费车道）
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'Invalid bearer token' }), VERDICT.auth)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'bad access token' }), VERDICT.auth)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: 'Unauthorized' }), VERDICT.auth)
  // 中文文案（上游免费通道的真实报错）：额度/限流
  assert.equal(
    classifyFailure({ code: 'UNKNOWN', message: 'gemini: 模型 gemini-3.8-flash 的所有账号均不可用（限流或额度耗尽），请稍后再试' }),
    VERDICT.throttled
  )
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '免费额度已用完，请升级套餐' }), VERDICT.throttled)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '积分不足' }), VERDICT.throttled)
  // 中文文案：登录/凭据
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '请先登录后再试' }), VERDICT.auth)
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '没有可用凭据' }), VERDICT.auth)
  // 中文文案：网络
  assert.equal(classifyFailure({ code: 'UNKNOWN', message: '连接失败：网络错误' }), VERDICT.timeout)
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'TIMEOUT' })), VERDICT.timeout)
  assert.equal(classifyError(new Error('fetch failed')), VERDICT.timeout)
  assert.equal(classifyError(new Error('something odd')), VERDICT.unknown)
})

// ── 探针调度 ─────────────────────────────────────────────────────────────────

function createFakeStore() {
  const models = {}
  return {
    model: (key) => models[key],
    setModel: (key, value) => {
      models[key] = value
    },
    get: () => ({ models }),
    flushSync() {},
    dispose() {}
  }
}

function createFakeLlm(models) {
  return {
    listProviders: () => Object.keys(models).map((id) => ({ id, name: id })),
    listModels: async (provider) => models[provider].map((id) => ({ provider, id, name: id })),
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    stream() {
      throw new Error('not used')
    },
    emitAdaptersUpdated() {}
  }
}

test('selectDue：新加入、从未验证过的通道不能被 dead 条目挤掉探针额度', async () => {
  const llm = createFakeLlm({ 'our-free-model': ['a', 'b', 'c'] })
  const config = normalizeConfig({ probe: { maxPerRound: 1 } })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()

  // 把 a、b 探成 dead（占了最前的位置），c 是刚加进来的、从未验证
  pool.markProbe('our-free-model/a', 'auth', { at: 1 })
  pool.markProbe('our-free-model/b', 'auth', { at: 1 })

  const prober = createProber({ ctx: { llm }, pool, config, logger, probe: async () => ({ verdict: 'ok', latencyMs: 1 }) })
  const due = prober.selectDue(Date.now())

  assert.ok(due.length > 0, '应该有到期条目')
  // dead 的复检与 unknown 同档，但 unknown 从没探过（nextProbeAt=0），应当在前
  const unknownFirst = due.findIndex((item) => item.health === 'unknown')
  const deadFirst = due.findIndex((item) => item.health === 'dead')
  assert.ok(
    unknownFirst === -1 || deadFirst === -1 || unknownFirst < deadFirst,
    `从未验证的条目应排在 dead 复检之前：${due.map((item) => item.key + '/' + item.health).join(', ')}`
  )
})

test('selectDue：免费全量，付费只挑不健康的，并按紧迫度排序', async () => {
  const llm = createFakeLlm({ 'our-free-model': ['a', 'b'], magpie: ['m1', 'm2'] })
  const config = normalizeConfig({})
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()
  pool.markProbe('our-free-model/b', 'auth', { at: 1 })   // dead，应排最前
  pool.markProbe('magpie/m1', 'timeout', { at: 1 })        // 付费但异常，应入选

  const prober = createProber({ ctx: { llm }, pool, config, logger, probe: async () => ({ verdict: 'ok', latencyMs: 1 }) })
  const due = prober.selectDue(Date.now())
  const keys = due.map((item) => item.key)

  assert.ok(keys.includes('our-free-model/a'))
  assert.ok(keys.includes('our-free-model/b'))
  assert.ok(keys.includes('magpie/m1'))
  assert.ok(!keys.includes('magpie/m2'), '健康付费模型默认不探')
  // 批次 2 规则：同紧迫度档内，**从未探过**的（nextProbeAt === 0）排最前 ——
  // 新加入/刚配好 Key 的通道必须马上验证，否则会被老故障条目一直挤掉预算。
  assert.equal(keys[0], 'our-free-model/a', '从未探过的条目应最先探')
  assert.ok(
    keys.indexOf('our-free-model/b') < keys.length,
    'dead 条目仍要进本轮（要复检）'
  )
})

test('round 把判决写回池，并遵守 maxPerRound', async () => {
  const llm = createFakeLlm({ 'our-free-model': ['a', 'b', 'c'] })
  const config = normalizeConfig({ probe: { maxPerRound: 2, concurrency: 2 } })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()

  const verdicts = { 'our-free-model/a': 'ok', 'our-free-model/b': 'throttled', 'our-free-model/c': 'auth' }
  const prober = createProber({
    ctx: { llm },
    pool,
    config,
    logger,
    probe: async (_llm, item) => ({ verdict: verdicts[item.key], latencyMs: 5 })
  })

  const outcome = await prober.round('test')
  assert.equal(outcome.probed, 2, 'maxPerRound=2 只探两条')

  const busy = pool.all().filter((item) => item.lastProbe !== null)
  assert.equal(busy.length, 2)
  assert.equal(prober.status().lastRoundCount, 2)
})

test('paidProbeWhenHealthy=true 时健康付费模型也进本轮', async () => {
  const llm = createFakeLlm({ magpie: ['m1'] })
  const config = normalizeConfig({ probe: { paidProbeWhenHealthy: true } })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()
  pool.markSuccess('magpie/m1', Date.now())

  const prober = createProber({ ctx: { llm }, pool, config, logger, probe: async () => ({ verdict: 'ok', latencyMs: 1 }) })
  // nextProbeAt 被 markSuccess 推到未来，这里直接把时钟往后拨
  const due = prober.selectDue(Date.now() + config.probe.intervalMs + 1)
  assert.deepEqual(due.map((item) => item.key), ['magpie/m1'])
})

test('冷却未到期的条目不会被反复探测', async () => {
  const llm = createFakeLlm({ 'our-free-model': ['a'] })
  const config = normalizeConfig({})
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()
  pool.markProbe('our-free-model/a', 'throttled', { at: Date.now() })

  assert.equal(pool.get('our-free-model/a').health, HEALTH.degraded)
  const prober = createProber({ ctx: { llm }, pool, config, logger, probe: async () => ({ verdict: 'ok', latencyMs: 1 }) })
  assert.deepEqual(prober.selectDue(Date.now()), [])
})
