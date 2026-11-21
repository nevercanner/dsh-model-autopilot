/**
 * 面板 API 测试：路由与同源边界。
 *
 * 这里用假的 req/res，不启 HTTP 服务器 —— 要验的是「哪条路径回什么、
 * 跨源是否被拒、按钮有没有真的触发探测」，而不是 node:http 本身。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApiHandler, describeState, API_PREFIX } from '../src/api.js'

const logger = { info() {}, warn() {} }

function createFakeService(entries = []) {
  const calls = { round: [], probeKey: [] }
  return {
    calls,
    pool: {
      all: () => entries,
      get: (key) => entries.find((item) => item.key === key),
      stats: () => ({ total: entries.length, free: 1, paid: 1, hidden: 1, byHealth: {} }),
      shouldHide: (entry) => entry.hidden === true,
      snapshot: () => ({ providerErrors: [{ id: 'broken', error: 'boom' }] })
    },
    prober: {
      status: () => ({ lastRoundAt: 1234, dueNow: 2, intervalMs: 600_000, running: false, lastRoundCount: 0 }),
      round: async (reason) => {
        calls.round.push(reason)
        return { probed: 0, skipped: false, results: [] }
      },
      probeKey: async (key) => {
        calls.probeKey.push(key)
        // 与真实 prober.probeKey 一致：池里没有这个 key 就返回 null。
        if (!entries.some((item) => item.key === key)) return null
        return { key, verdict: 'ok', latencyMs: 5 }
      }
    },
    autopilot: {
      status: () => ({ lastResult: { model: { key: 'our-free-model/x' }, reason: 'free:preferred' } })
    },
    catalogFilter: { stats: () => ({ calls: 9, hidden: 4, emits: 2, errors: 0 }) },
    catalogFilterInstalled: true
  }
}

function entry(patch) {
  return {
    key: 'p/m',
    cost: 'free',
    health: 'available',
    failCount: 0,
    cooldownUntil: 0,
    hidden: false,
    lastProbe: { verdict: 'ok', latencyMs: 12 },
    ...patch
  }
}

function makeReq({ method = 'GET', url = API_PREFIX, headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const listeners = {}
  return {
    method,
    url,
    headers,
    socket: { remoteAddress },
    on(event, cb) {
      ;(listeners[event] ??= []).push(cb)
      return this
    },
    destroy() {},
    pushBody() {
      for (const cb of listeners.data ?? []) cb(Buffer.from(body ?? ''))
      for (const cb of listeners.end ?? []) cb()
    }
  }
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body ?? ''
    }
  }
}

async function call(handler, options) {
  const req = makeReq(options)
  const res = makeRes()
  const pending = handler(req, res)
  req.pushBody()
  await pending
  return { res, json: res.body ? JSON.parse(res.body) : null }
}

test('GET 根路径返回池状态、探针、最近选型与屏蔽清单', async () => {
  const service = createFakeService([
    entry({ key: 'our-free-model/ok' }),
    entry({ key: 'our-free-model/dead', health: 'dead', hidden: true, failCount: 2 }),
    entry({ key: 'magpie/paid', cost: 'paid', health: 'cooling', cooldownUntil: Date.now() + 30_000 })
  ])
  const handler = createApiHandler({ service, logger })
  const { res, json } = await call(handler, { url: API_PREFIX })

  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(json.ok, true)
  assert.equal(json.pool.total, 3)
  assert.equal(json.catalogFilter.installed, true)
  assert.equal(json.autopilot.lastResult.reason, 'free:preferred')
  assert.equal(json.totalEntries, 3)
  // 隐藏/失效的排在前面：面板首先要能处理它们。
  assert.equal(json.entries[0].key, 'our-free-model/dead')
  assert.equal(json.entries[0].hidden, true)
  // 冷却剩余时间被换算成毫秒残留
  assert.ok(json.entries.find((item) => item.key === 'magpie/paid').cooldownLeft > 0)
})

test('条目上限 60，避免一次下发整个池', async () => {
  const many = Array.from({ length: 200 }, (_, index) => entry({ key: `p/m${index}` }))
  const handler = createApiHandler({ service: createFakeService(many), logger })
  const { json } = await call(handler, { url: API_PREFIX })
  assert.equal(json.totalEntries, 200)
  assert.equal(json.entries.length, 60)
})

test('POST /probe 无 key：触发整轮但不阻塞响应', async () => {
  const service = createFakeService([entry({})])
  const handler = createApiHandler({ service, logger })
  const { res, json } = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/probe',
    body: '{}',
    headers: { origin: 'http://127.0.0.1:2202', host: '127.0.0.1:2202' }
  })

  assert.equal(res.status, 202)
  assert.equal(json.triggered, true)
  assert.deepEqual(service.calls.round, ['api'])
  assert.deepEqual(service.calls.probeKey, [])
})

test('POST /probe 带 key：只探这一条并返回结果', async () => {
  const service = createFakeService([entry({ key: 'our-free-model/x' })])
  const handler = createApiHandler({ service, logger })
  const { res, json } = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/probe',
    body: JSON.stringify({ key: 'our-free-model/x' }),
    headers: { origin: 'http://127.0.0.1:2202', host: '127.0.0.1:2202' }
  })

  assert.equal(res.status, 200)
  assert.equal(json.result.verdict, 'ok')
  assert.deepEqual(service.calls.probeKey, ['our-free-model/x'])
  assert.deepEqual(service.calls.round, [])
})

test('POST /probe?model=：单条探测并回带该条目的最新快照', async () => {
  const service = createFakeService([entry({ key: 'our-free-model/x', hidden: true, health: 'dead' })])
  const handler = createApiHandler({ service, logger })
  const { res, json } = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/probe?model=' + encodeURIComponent('our-free-model/x'),
    body: '{}',
    headers: { origin: 'http://127.0.0.1:2202', host: '127.0.0.1:2202' }
  })

  assert.equal(res.status, 200)
  assert.equal(json.key, 'our-free-model/x')
  assert.deepEqual(service.calls.probeKey, ['our-free-model/x'])
  // entry 让面板就地替换这一行，不必整页重载
  assert.equal(json.entry.key, 'our-free-model/x')
  assert.equal(json.entry.hidden, true)
})

test('POST /probe?model= 指向未知模型时回 404（不静默）', async () => {
  const service = createFakeService([entry({ key: 'a/b' })])
  const handler = createApiHandler({ service, logger })
  const { res } = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/probe?model=does/not-exist',
    body: '{}',
    headers: { origin: 'http://127.0.0.1:2202', host: '127.0.0.1:2202' }
  })
  assert.equal(res.status, 404)
})

test('POST /probe 缺 Origin 时放行（宿主链路不带 Origin，远程已由回环限制挡住）', async () => {
  const service = createFakeService([entry({})])
  const handler = createApiHandler({ service, logger })
  const { res } = await call(handler, { method: 'POST', url: API_PREFIX + '/probe', body: '{}' })
  // 无 Origin = 不是浏览器跨源请求；CSRF 一定带 Origin。远程访问由回环限制兜住。
  // 之前这里要求必须有 Origin，导致面板点「立即探测」直接吃 HTTP 403。
  assert.equal(res.status, 202)
})

test('POST /probe 带了跨源 Origin 时仍然拒绝（CSRF 防线保留）', async () => {
  const service = createFakeService([entry({})])
  const handler = createApiHandler({ service, logger })
  const { res } = await call(handler, {
    method: 'POST',
    url: API_PREFIX + '/probe',
    body: '{}',
    headers: { origin: 'https://evil.example', host: '127.0.0.1:30048' }
  })
  assert.equal(res.status, 403)
  assert.deepEqual(service.calls.round, [], '跨源请求不能替它打上游')
})

test('非回环地址一律拒绝（webserver 可能监听 0.0.0.0）', async () => {
  const service = createFakeService([entry({})])
  const handler = createApiHandler({ service, logger })
  const { res } = await call(handler, { url: API_PREFIX, remoteAddress: '192.168.1.20' })
  assert.equal(res.status, 403)
})

test('跨源请求被拒；同源放行', async () => {
  const service = createFakeService([entry({})])
  const handler = createApiHandler({ service, logger })

  const hostile = await call(handler, {
    url: API_PREFIX,
    headers: { origin: 'https://evil.example', host: '127.0.0.1:2202' }
  })
  assert.equal(hostile.res.status, 403)

  const same = await call(handler, {
    url: API_PREFIX,
    headers: { origin: 'http://127.0.0.1:2202', host: '127.0.0.1:2202' }
  })
  assert.equal(same.res.status, 200)
})

test('不支持的方法与未知路径分别 405 / 404', async () => {
  const service = createFakeService([entry({})])
  const handler = createApiHandler({ service, logger })

  const put = await call(handler, { method: 'PUT', url: API_PREFIX })
  assert.equal(put.res.status, 405)

  const missing = await call(handler, { url: API_PREFIX + '/nope' })
  assert.equal(missing.res.status, 404)
})

test('service 抛错时回 500 而不是挂掉请求', async () => {
  const service = createFakeService([entry({})])
  service.pool.all = () => {
    throw new Error('pool exploded')
  }
  const handler = createApiHandler({ service, logger })
  const { res, json } = await call(handler, { url: API_PREFIX })
  assert.equal(res.status, 500)
  assert.equal(json.ok, false)
  assert.match(json.error, /pool exploded/)
})

test('describeState 可独立调用（面板/诊断复用）', () => {
  const service = createFakeService([entry({ key: 'a/b' })])
  const state = describeState(service, 1_000)
  assert.equal(state.generatedAt, 1_000)
  assert.equal(state.entries[0].key, 'a/b')
  assert.deepEqual(state.providerErrors, [{ id: 'broken', error: 'boom' }])
})
