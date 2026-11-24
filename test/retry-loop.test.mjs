/**
 * 外层重试循环：一轮没成功就等一会儿再来一轮，直到拿到有效响应。
 *
 * 用户诉求（原话）：「除非完成任务，否则要无感自动切换模型，不能因为预算耗尽
 * 就直接中断任务」。拷问后确认的口径：
 *   - 失败 → 下一轮（免费池 + deepseek-account 兜底）；
 *   - 不设时长上限（maxRounds: null）；
 *   - 进度写进「思考中」（reasoning-delta），不污染正式回答；
 *   - 每 10 轮给一条里程碑提示，但不停手；
 *   - 用户点停止时立刻中断。
 *
 * 这些用例只测 adapter 层，不碰 failover 内部逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAutopilotAdapter } from '../src/autopilot.js'
import { normalizeConfig } from '../src/config.js'

const logger = { info() {}, warn() {}, error() {} }

/**
 * 造一个假的 autopilot：前 N 次 run() 抛错，之后成功。
 * @param {number} failTimes
 * @param {{ model?: string }} [options]
 */
function createFakeAutopilot(failTimes, options = {}) {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    async run() {
      calls += 1
      if (calls <= failTimes) {
        throw Object.assign(new Error(`第 ${calls} 次失败：所有候选模型均失败`), {
          name: 'AutopilotExhaustedError'
        })
      }
      return {
        model: { provider: 'p', model: options.model ?? 'ok-model', key: 'p/ok-model', cost: 'free' },
        reason: 'free:preferred',
        attempts: [{ key: 'p/ok-model', ok: true, retry: 0, latencyMs: 1 }],
        stream: (async function* () {
          yield { type: 'text-delta', text: '真实回答' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
    }
  }
}

/** 收集一个流里的全部帧。 */
async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** 轮间等待设成 1s（归一化下限），测试才跑得快。 */
function fastConfig(overrides = {}) {
  const { retryLoop = {}, ...rest } = overrides
  return normalizeConfig({
    failover: {
      ...rest,
      // 注意顺序：retryLoop 的构造必须在 ...rest 之后，
      // 否则 rest 里的 retryLoop 会把这里的默认值整个覆盖掉
      // （实测导致 roundDelayMs 变成默认 20s，用例跑 40 秒超时）。
      retryLoop: { maxRounds: null, roundDelayMs: 1_000, noticeAfterRounds: 10, ...retryLoop }
    }
  })
}

test('首轮失败后自动重试，第二轮成功：进度写进思考区，不污染正文', async () => {
  const autopilot = createFakeAutopilot(1)
  const adapter = createAutopilotAdapter({ getAutopilot: () => autopilot, config: fastConfig(), logger })

  const chunks = await collect(adapter.stream({ messages: [], signal: new AbortController().signal }))

  // 必须有一次重试
  assert.equal(autopilot.calls, 2, '应该重试了 1 次')

  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

  assert.match(reasoning, /第 1 轮未成功/, '进度要写进思考区')
  assert.match(reasoning, /自动重试/, '要说明会重试')
  assert.equal(text, '真实回答', '正文只能是真实回答，不能混入进度文案')
})

test('多轮都失败也继续重试，直到成功（不中断任务）', async () => {
  const autopilot = createFakeAutopilot(5)
  const adapter = createAutopilotAdapter({ getAutopilot: () => autopilot, config: fastConfig(), logger })

  const chunks = await collect(adapter.stream({ messages: [] }))

  assert.equal(autopilot.calls, 6, '失败 5 次后第 6 次成功')
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  assert.equal(text, '真实回答')
  // 5 条进度帧，一条都不该进正文
  const reasoningCount = chunks.filter((c) => c.type === 'reasoning-delta').length
  assert.equal(reasoningCount, 5)
})

test('显式 maxRounds=3：3 轮都失败后抛错（安全阀）', async () => {
  const autopilot = createFakeAutopilot(99)
  const adapter = createAutopilotAdapter({
    getAutopilot: () => autopilot,
    config: fastConfig({ retryLoop: { maxRounds: 3 } }),
    logger
  })

  await assert.rejects(() => collect(adapter.stream({ messages: [] })), (error) => {
    assert.match(error.message, /所有候选模型均失败/)
    return true
  })
  assert.equal(autopilot.calls, 3, '最多只跑 3 轮')
})

test('每 10 轮发一条里程碑提示（含最后错误），但不停止', async () => {
  const autopilot = createFakeAutopilot(10)
  const adapter = createAutopilotAdapter({
    getAutopilot: () => autopilot,
    config: fastConfig({ retryLoop: { noticeAfterRounds: 10 } }),
    logger
  })

  const chunks = await collect(adapter.stream({ messages: [] }))
  const reasoning = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')

  // 第 10 轮失败时命中里程碑（第 11 次调用才成功）
  assert.match(reasoning, /已重试 10 轮/, '里程碑提示要出现')
  assert.match(reasoning, /继续重试/, '要说明仍在继续，不停手')
  assert.equal(autopilot.calls, 11)
})

test('用户取消：立刻停止，不再重试', async () => {
  const autopilot = createFakeAutopilot(99)
  const adapter = createAutopilotAdapter({ getAutopilot: () => autopilot, config: fastConfig(), logger })

  const controller = new AbortController()
  const stream = adapter.stream({ messages: [], signal: controller.signal })

  // 读第一帧（第一条进度），然后取消
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.next()
  controller.abort()

  await assert.rejects(
    async () => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return
      }
    },
    (error) => {
      assert.ok(error, '取消后应该抛错')
      return true
    }
  )
  // 取消后不应该继续跑很多轮
  assert.ok(autopilot.calls <= 3, `取消后不该继续重试，实际跑了 ${autopilot.calls} 轮`)
})

test('拿到响应后不再重试（成功即结束）', async () => {
  const autopilot = createFakeAutopilot(0)
  const adapter = createAutopilotAdapter({ getAutopilot: () => autopilot, config: fastConfig(), logger })

  const chunks = await collect(adapter.stream({ messages: [] }))
  assert.equal(autopilot.calls, 1, '第一次就成功，不该重试')
  assert.equal(chunks.filter((c) => c.type === 'reasoning-delta').length, 0, '不该有进度帧')
  assert.equal(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join(''), '真实回答')
})
