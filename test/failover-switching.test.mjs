/**
 * 故障切换专项验证。
 *
 * 覆盖用户点名的每一种失败形态，验证「失败发生后真的会换模型」，
 * 而不是只验证分类器或状态机：
 *
 *   - 无有效凭据（MISSING_CREDENTIAL）
 *   - provider 未登录 / 登录失效（INVALID_CREDENTIAL、401/403 文案）
 *   - 请求超时（TIMEOUT）
 *   - 429 限流（RATE_LIMIT）
 *   - 网络 / provider 暂时不可用（TRANSPORT、SERVER）
 *   - 流式响应开始前失败
 *   - 流式响应中途失败
 *   - 首选模型失败后切到次选
 *   - 全部候选不可用
 *   - 切换后新模型再次失败
 *   - 防止重复选择失败模型造成死循环
 *
 * 每个用例都断言「最终落到哪个模型」+「尝试链长什么样」+「池状态有没有更新」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPool } from '../src/pool/pool.js'
import { createScheduler } from '../src/schedule/scheduler.js'
import { createFailover } from '../src/failover/failover.js'
import { createAutopilot, createAutopilotAdapter } from '../src/autopilot.js'
import { normalizeConfig } from '../src/config.js'
import { HEALTH } from '../src/pool/types.js'

const logger = { info() {}, warn() {} }

function createFakeStore() {
  const models = {}
  return {
    model: (key) => models[key],
    setModel: (key, value) => {
      models[key] = value
    },
    setMeta() {},
    get: () => ({ models }),
    flushSync() {},
    dispose() {}
  }
}

/**
 * 构造假宿主。
 * behaviour[key] 可以是：
 *   'ok'                        → 正常流
 *   { throw: {code,message} }   → 建流就抛
 *   { chunks: [...], failAfter } → 流中途抛
 *   { hang: true }              → 永不产出
 */
function createFakeLlm(models, behaviour, { onStream } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => Object.keys(models).map((id) => ({ id, name: id })),
    listModels: async (provider) => models[provider].map((id) => ({ provider, id, name: id })),
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    stream(options) {
      const key = `${options.provider}/${options.model}`
      calls.push(key)
      onStream?.(key, options)
      const spec = behaviour[key] ?? 'ok'
      if (spec === 'throw') throw Object.assign(new Error('boom'), { code: 'SERVER' })
      if (spec?.slowMs) {
        // 首帧挂起 slowMs 之后才产出 —— 模拟「首帧超时」
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => setTimeout(resolve, spec.slowMs))
            yield { type: 'text-delta', text: 'slow' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          }
        }
      }
      if (spec?.delayMs) {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => setTimeout(resolve, spec.delayMs))
            const error = Object.assign(new Error(spec.throw?.message ?? 'boom'), {
              code: spec.throw?.code ?? 'SERVER'
            })
            throw error
          }
        }
      }
      if (spec?.throw) {
        return {
          async *[Symbol.asyncIterator]() {
            throw Object.assign(new Error(spec.throw.message), { code: spec.throw.code })
          }
        }
      }
      if (spec?.hang) {
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise(() => {})
          }
        }
      }
      if (spec?.hangAfter) {
        const head = spec.chunks ?? []
        return {
          async *[Symbol.asyncIterator]() {
            for (const chunk of head) yield chunk
            await new Promise(() => {})
          }
        }
      }
      const chunks = spec?.chunks ?? [
        { type: 'text-delta', text: 'hi' },
        { type: 'finish', reason: { kind: 'stop' } }
      ]
      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
          if (spec?.failAfter) {
            throw Object.assign(new Error(spec.failAfter.message ?? 'mid-stream'), { code: spec.failAfter.code ?? 'TRANSPORT' })
          }
        }
      }
    },
    emitAdaptersUpdated() {}
  }
}

/**
 * @param {object} [options]
 * @param {Record<string, any>} [options.behaviour]
 * @param {Record<string, string[]>} [options.models]
 * @param {any} [options.config]
 * @param {any} [options.preference]
 * @param {(key: string, options: any) => void} [options.onStream]
 */
async function setup(options = {}) {
  const models = options.models ?? {
    'our-free-model': ['free-a', 'free-b', 'free-c'],
    magpie: ['paid-x']
  }
  const llm = createFakeLlm(models, options.behaviour ?? {}, { onStream: options.onStream })
  const config = normalizeConfig({
    failover: {
      maxModels: 3,
      maxRetriesPerModel: 1,
      retrySameModel: true,
      backoff: { initialMs: 0, maxMs: 0, jitterRatio: 0 }
    },
    ...(options.config ?? {})
  })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()
  const scheduler = createScheduler({ pool, config, logger, preference: options.preference ?? null })
  const failover = createFailover({
    ctx: { llm },
    pool,
    scheduler,
    config,
    logger,
    wait: async () => {},
    preference: options.preference ?? null
  })
  const autopilot = createAutopilot({ ctx: { llm }, pool, scheduler, failover, config, logger })
  const adapter = createAutopilotAdapter({ getAutopilot: () => autopilot, config, logger })
  return { llm, pool, scheduler, failover, autopilot, adapter, config }
}

// ── 单点失败 → 必须换模型 ────────────────────────────────────────────────────

test('无有效凭据（MISSING_CREDENTIAL）：失败后切到下一个模型', async () => {
  const { failover, llm, pool } = await setup({
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'gemini: no usable credential; log in first' } }
    }
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.deepEqual(llm.calls, ['our-free-model/free-a', 'our-free-model/free-b'])
  assert.equal(result.attempts[0].verdict, 'auth')
  // 池状态：失败的模型被记为 dead（结构性失效），不是还在冷却
  assert.equal(pool.get('our-free-model/free-a').health, HEALTH.dead)
  assert.equal(pool.get('our-free-model/free-a').failCount, 1)
})

test('登录失效（INVALID_CREDENTIAL）：失败后切到下一个模型', async () => {
  const { failover, llm } = await setup({
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'INVALID_CREDENTIAL', message: 'token expired' } }
    }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.deepEqual(llm.calls, ['our-free-model/free-a', 'our-free-model/free-b'])
  assert.equal(result.attempts[0].verdict, 'auth')
})

test('401/403 文案（无码）：失败后切到下一个模型', async () => {
  const { failover, llm } = await setup({
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'UNKNOWN', message: 'HTTP 403 Forbidden' } }
    }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.equal(result.attempts[0].verdict, 'auth')
})

test('请求超时（TIMEOUT）：切到下一个模型，且超时可重试一次', async () => {
  const { failover, llm } = await setup({
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'TIMEOUT', message: 'request timed out' } }
    }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  // timeout 属于可重试：同一模型先重试一次，再换模型
  assert.deepEqual(llm.calls, [
    'our-free-model/free-a',
    'our-free-model/free-a',
    'our-free-model/free-b'
  ])
  assert.equal(result.attempts.filter((item) => item.key === 'our-free-model/free-a').length, 2)
})

test('429 限流（RATE_LIMIT）：不原地重试，直接换模型', async () => {
  const { failover, llm } = await setup({
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'RATE_LIMIT', message: '429 too many requests' } }
    }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.deepEqual(llm.calls, ['our-free-model/free-a', 'our-free-model/free-b'])
  assert.equal(result.attempts[0].verdict, 'throttled')
  assert.equal(result.attempts[0].retry, 0)
})

test('网络 / provider 暂时不可用（TRANSPORT、SERVER）：失败后换模型', async () => {
  for (const code of ['TRANSPORT', 'SERVER']) {
    const { failover, llm } = await setup({
      behaviour: {
        'our-free-model/free-a': { throw: { code, message: 'upstream down' } }
      }
    })
    const result = await failover.run({ messages: [] })
    assert.equal(result.model.key, 'our-free-model/free-b', `${code} 应换模型`)
    assert.equal(llm.calls.length >= 2, true)
  }
})

test('流式响应开始前失败：换模型', async () => {
  const { failover, llm } = await setup({
    behaviour: {
      'our-free-model/free-a': { chunks: [{ type: 'usage' }], failAfter: { code: 'MISSING_CREDENTIAL', message: 'boom' } }
    }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.deepEqual(llm.calls, ['our-free-model/free-a', 'our-free-model/free-b'])
})

test('流式响应开始前失败（可重试类）：先重试同一模型，再换模型', async () => {
  // SERVER 归为 unavailable → 属可重试：同一模型重试一次，仍失败才换。
  const { failover, llm } = await setup({
    behaviour: {
      'our-free-model/free-a': { chunks: [{ type: 'usage' }], failAfter: { code: 'SERVER', message: 'boom' } }
    }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-b')
  assert.deepEqual(llm.calls, [
    'our-free-model/free-a',
    'our-free-model/free-a',
    'our-free-model/free-b'
  ])
})

test('流式响应中途失败：已产出内容不能切换，但必须记一次失败', async () => {
  const { failover, pool } = await setup({
    behaviour: {
      'our-free-model/free-a': {
        chunks: [{ type: 'text-delta', text: 'partial' }],
        failAfter: { code: 'TRANSPORT', message: 'mid-stream' }
      }
    }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-a')

  const seen = []
  await assert.rejects(async () => {
    for await (const chunk of result.stream) seen.push(chunk)
  }, /mid-stream/)
  assert.equal(seen.length, 1, '已产出的内容要保留给调用方')
  assert.equal(pool.get('our-free-model/free-a').failCount, 1, '中途失败要写回池')
})

// ── 首选模型相关 ─────────────────────────────────────────────────────────────

test('首选模型失败后切到次选（不会重新选同一个失败模型）', async () => {
  const preference = {
    isPinned: () => true,
    get: () => ({ provider: 'magpie', model: 'paid-x' })
  }
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['free-a'], magpie: ['paid-x'] },
    behaviour: {
      'magpie/paid-x': { throw: { code: 'MISSING_CREDENTIAL', message: 'no usable credential' } }
    },
    preference
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-a', '首选失败后应让位给免费模型')
  assert.deepEqual(llm.calls, ['magpie/paid-x', 'our-free-model/free-a'])
  // 首选不能被重复选择
  assert.equal(llm.calls.filter((key) => key === 'magpie/paid-x').length, 1)
})

test('首选模型额度耗尽：不重试，直接切下一个候选', async () => {
  const preference = {
    isPinned: () => true,
    get: () => ({ provider: 'minimax-cn', model: 'MiniMax-M3' })
  }
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['free-a'], 'minimax-cn': ['MiniMax-M3'] },
    behaviour: {
      'minimax-cn/MiniMax-M3': { throw: { code: 'QUOTA', message: 'quota exhausted' } }
    },
    preference
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-a')
  assert.deepEqual(llm.calls, ['minimax-cn/MiniMax-M3', 'our-free-model/free-a'])
  assert.equal(result.attempts[0].verdict, 'throttled')
})

// ── 边界 ─────────────────────────────────────────────────────────────────────

test('所有候选都不可用：抛出可诊断的错误，带尝试记录', async () => {
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['free-a'] },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'no credential' } }
    },
    config: { failover: { maxModels: 2, maxRetriesPerModel: 0 } }
  })
  await assert.rejects(
    () => failover.run({ messages: [] }),
    (error) => {
      assert.equal(error.name, 'AutopilotExhaustedError')
      // v0.2.1 起 error.code 表达**耗尽原因**（与文案一一对应），
      // 上游失败语义另存 lastVerdictCode，两者不能混淆。
      assert.equal(error.code, 'AUTOPILOT_CANDIDATES_EXHAUSTED', '错误码要表达「候选耗尽」')
      assert.equal(error.lastVerdictCode, 'INVALID_CREDENTIAL', '上游语义另存 lastVerdictCode')
      assert.equal(error.budgetExhausted, false)
      assert.equal(error.attempts.length, 1)
      assert.match(error.message, /所有候选模型均失败/)
      return true
    }
  )
  assert.equal(llm.calls.length, 1)
})

test('切换后新模型再次失败：继续往下换，直到耗尽', async () => {
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['free-a', 'free-b', 'free-c'] },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'a' } },
      'our-free-model/free-b': { throw: { code: 'MISSING_CREDENTIAL', message: 'b' } },
      'our-free-model/free-c': { throw: { code: 'MISSING_CREDENTIAL', message: 'c' } }
    },
    config: { failover: { maxModels: 3, maxRetriesPerModel: 0 } }
  })
  await assert.rejects(() => failover.run({ messages: [] }), /所有候选模型均失败/)
  assert.deepEqual(llm.calls, [
    'our-free-model/free-a',
    'our-free-model/free-b',
    'our-free-model/free-c'
  ])
})

test('不会重复选择失败模型（防死循环）：每个模型最多被选一次', async () => {
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['free-a', 'free-b'] },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'SERVER', message: 'a' } },
      'our-free-model/free-b': { throw: { code: 'SERVER', message: 'b' } }
    },
    config: { failover: { maxModels: 5, maxRetriesPerModel: 0 } }
  })
  await assert.rejects(() => failover.run({ messages: [] }), /所有候选模型均失败/)
  const unique = new Set(llm.calls)
  assert.equal(unique.size, llm.calls.length, `同一个模型被选了多次: ${llm.calls.join(', ')}`)
  assert.equal(llm.calls.length, 2, '不会超过候选数量')
})

test('失败的模型进入冷却后，下一次请求不会再选它', async () => {
  const { failover, pool, llm } = await setup({
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'no credential' } }
    }
  })
  await failover.run({ messages: [] })
  assert.equal(pool.get('our-free-model/free-a').health, HEALTH.dead)

  llm.calls.length = 0
  const second = await failover.run({ messages: [] })
  assert.equal(second.model.key, 'our-free-model/free-b')
  assert.ok(!llm.calls.includes('our-free-model/free-a'), 'dead 的模型不应再被选中')
})

test('取消信号：立刻中断，不写回失败，不换模型', async () => {
  const controller = new AbortController()
  controller.abort()
  const { failover, pool, llm } = await setup({})
  await assert.rejects(() => failover.run({ messages: [], signal: controller.signal }))
  assert.equal(llm.calls.length, 0)
  assert.equal(pool.get('our-free-model/free-a').failCount, 0)
})

test('provider 挂起不吐数据：首帧超时后换模型，不会无限等待', async () => {
  const started = Date.now()
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['free-a', 'free-b'] },
    behaviour: {
      'our-free-model/free-a': { hang: true }
    },
    config: { failover: { firstFrameTimeoutMs: 120, maxRetriesPerModel: 1 } }
  })

  const result = await failover.run({ messages: [] })
  const elapsed = Date.now() - started

  assert.equal(result.model.key, 'our-free-model/free-b', '挂起的模型必须被跳过')
  // 首帧超时直接换模型，不在同一模型上重试（只调用一次 free-a）
  assert.deepEqual(llm.calls, ['our-free-model/free-a', 'our-free-model/free-b'])
  assert.equal(result.attempts[0].verdict, 'timeout')
  assert.ok(elapsed < 5_000, `必须在超时后立刻回退，实际耗时 ${elapsed}ms（不能挂死）`)
})

test('流中途挂起：首帧已拿到，交给宿主处理，不重复请求', async () => {
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['free-a', 'free-b'] },
    behaviour: {
      'our-free-model/free-a': { chunks: [{ type: 'text-delta', text: 'x' }], hangAfter: true }
    },
    config: { failover: { firstFrameTimeoutMs: 120 } }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-a')
  assert.deepEqual(llm.calls, ['our-free-model/free-a'], '首帧之后不换模型')
})

test('首选模型挂起：超时后让位给免费模型', async () => {
  const preference = { isPinned: () => true, get: () => ({ provider: 'magpie', model: 'paid-x' }) }
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['free-a'], magpie: ['paid-x'] },
    behaviour: { 'magpie/paid-x': { hang: true } },
    preference,
    config: { failover: { firstFrameTimeoutMs: 120 } }
  })
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/free-a')
  assert.deepEqual(llm.calls, ['magpie/paid-x', 'our-free-model/free-a'])
})

// ── 终极兜底：免费全挂也要继续干活 ───────────────────────────────────────────

test('免费通道全失败后落到 deepseek-account 继续，不抛错', async () => {
  const { failover, llm } = await setup({
    models: {
      'our-free-model': ['free-a', 'free-b', 'free-c'],
      'deepseek-account': ['deepseek-flash']
    },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'RATE_LIMIT', message: 'quota' } },
      'our-free-model/free-b': { throw: { code: 'RATE_LIMIT', message: 'quota' } },
      'our-free-model/free-c': { throw: { code: 'RATE_LIMIT', message: 'quota' } }
    },
    config: { failover: { terminalFallback: { provider: 'deepseek-account', model: null } } }
  })

  // 关键：不抛错，落到能用的通道上
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'deepseek-account/deepseek-flash', '必须落到 deepseek-account')
  assert.equal(llm.calls.at(-1), 'deepseek-account/deepseek-flash')
  // 免费通道确实被流转过了（不是直接跳到付费）
  assert.ok(
    llm.calls.indexOf('deepseek-account/deepseek-flash') >= 3,
    `应先试完免费通道再落付费，实际调用链：${llm.calls.join(' → ')}`
  )
})

test('兜底不受 allowPaid 限制（免费全挂时付费通道照样用）', async () => {
  const { failover } = await setup({
    models: {
      'our-free-model': ['free-a'],
      'deepseek-account': ['deepseek-flash']
    },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'no key' } }
    },
    config: {
      schedule: { allowPaidByDefault: false },
      failover: { terminalFallback: { provider: 'deepseek-account', model: null } }
    }
  })

  // allowPaid=false 时正常候选只剩免费；免费挂了仍要兜底
  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'deepseek-account/deepseek-flash')
})

test('兜底也失败时才抛错（并带上完整尝试链）', async () => {
  const { failover } = await setup({
    models: {
      'our-free-model': ['free-a'],
      'deepseek-account': ['deepseek-flash']
    },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'no key' } },
      'deepseek-account/deepseek-flash': { throw: { code: 'MISSING_CREDENTIAL', message: 'no key' } }
    },
    config: {
      // 关掉付费普通候选，让 deepseek-account 只能靠兜底进入 → 兜底那次才会被记录
      schedule: { allowPaidByDefault: false },
      failover: { terminalFallback: { provider: 'deepseek-account', model: null } }
    }
  })

  await assert.rejects(
    () => failover.run({ messages: [] }),
    (error) => {
      assert.equal(error.name, 'AutopilotExhaustedError')
      assert.ok(error.attempts.some((item) => item.terminal === true), '尝试链里要能看到兜底那次')
      return true
    }
  )
})

test('关闭兜底 + 禁用付费候选时，耗尽即抛错', async () => {
  const { failover } = await setup({
    models: {
      'our-free-model': ['free-a'],
      'deepseek-account': ['deepseek-flash']
    },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'no key' } }
    },
    config: {
      schedule: { allowPaidByDefault: false },
      failover: { terminalFallback: false }
    }
  })

  await assert.rejects(() => failover.run({ messages: [] }), (error) => {
    assert.equal(error.name, 'AutopilotExhaustedError')
    return true
  })
})

test('兜底通道被判死时跳过它（不往墙上撞）', async () => {
  const { failover, pool } = await setup({
    models: {
      'our-free-model': ['free-a'],
      'deepseek-account': ['deepseek-flash']
    },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'no key' } }
    },
    config: { failover: { terminalFallback: { provider: 'deepseek-account', model: null } } }
  })
  // 把兜底条目标成 dead
  pool.markFailure('deepseek-account/deepseek-flash', 'auth')
  pool.markFailure('deepseek-account/deepseek-flash', 'auth')

  await assert.rejects(() => failover.run({ messages: [] }), (error) => {
    assert.equal(error.name, 'AutopilotExhaustedError')
    assert.equal(error.attempts.some((item) => item.terminal === true), false, '不该尝试判死的兜底')
    return true
  })
})

// ── 输出被 max_tokens 截断 ──────────────────────────────────────────────────

test('输出被截断且一个字都没吐：换下一个模型，不把空回复当成功', async () => {
  const { failover, llm } = await setup({
    // 名字要保证 a-tiny 排在 b-large 之前，否则第一个就不是被截断的那个
    models: { 'our-free-model': ['a-tiny', 'b-large'] },
    behaviour: {
      // 首帧就是 finish(max-tokens)，没有任何 text-delta
      'our-free-model/a-tiny': { chunks: [{ type: 'finish', reason: { kind: 'max-tokens' } }] }
    }
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/b-large', '应换到输出预算更大的模型')
  assert.deepEqual(llm.calls, ['our-free-model/a-tiny', 'our-free-model/b-large'])
  assert.equal(result.attempts[0].verdict, 'truncated')
})

test('已经吐了内容才被截断：不重放（会重复内容），但记一次截断信号', async () => {
  const { failover, pool } = await setup({
    models: { 'our-free-model': ['a', 'b'] },
    behaviour: {
      'our-free-model/a': {
        chunks: [
          { type: 'text-delta', text: '前半段' },
          { type: 'finish', reason: { kind: 'max-tokens' } }
        ]
      }
    }
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/a', '已产出的内容不重放')
  let text = ''
  for await (const chunk of result.stream) if (chunk.type === 'text-delta') text += chunk.text
  assert.equal(text, '前半段')

  const entry = pool.get('our-free-model/a')
  assert.equal(entry.truncatedCount, 1, '要记下这次截断')
  assert.equal(entry.failCount, 0, '截断不算失败，不能升 failCount')
  assert.notEqual(entry.health, 'dead', '截断不能让模型判死')
})

test('截断过的模型在打分上被降权（下次优先别的通道）', async () => {
  const { scoreEntry } = await import('../src/schedule/scoring.js')
  const { normalizeConfig } = await import('../src/config.js')
  const config = normalizeConfig({})
  const base = {
    key: 'x/y',
    provider: 'x',
    model: 'y',
    cost: 'free',
    priority: 0,
    health: 'available',
    failCount: 0,
    cooldownUntil: 0,
    lastProbe: null
  }
  const clean = scoreEntry(base, { now: Date.now(), config })
  const truncated = scoreEntry({ ...base, truncatedCount: 3 }, { now: Date.now(), config })
  assert.ok(truncated < clean, '截断过应被降权')
})

test('全部模型都截断：抛出带 MAX_TOKENS 的错误码', async () => {
  const { failover } = await setup({
    models: { 'our-free-model': ['a', 'b'] },
    behaviour: {
      'our-free-model/a': { chunks: [{ type: 'finish', reason: { kind: 'max-tokens' } }] },
      'our-free-model/b': { chunks: [{ type: 'finish', reason: { kind: 'max-tokens' } }] }
    },
    config: { failover: { terminalFallback: false } }
  })

  await assert.rejects(() => failover.run({ messages: [] }), (error) => {
    assert.equal(error.name, 'AutopilotExhaustedError')
    // v0.2.1 起 error.code 表达**耗尽原因**（与文案一一对应）：这里 2 个候选
    // 都被截断且未超预算 → 候选耗尽。「是截断不是别的问题」这个语义放在
    // lastVerdictCode 上。
    assert.equal(error.code, 'AUTOPILOT_CANDIDATES_EXHAUSTED', '错误码要表达「候选耗尽」')
    assert.equal(error.lastVerdictCode, 'MAX_TOKENS', '截断语义另存 lastVerdictCode')
    assert.match(error.message, /所有候选模型均失败/)
    return true
  })
})

test('max_tokens 文案也能被分类成 truncated', async () => {
  const { classifyError } = await import('../src/probe/classify.js')
  assert.equal(classifyError(Object.assign(new Error('x'), { code: 'MAX_TOKENS' })), 'truncated')
  assert.equal(classifyError(new Error('maximum output tokens exceeded')), 'truncated')
  assert.equal(classifyError(new Error('输出超过上限')), 'truncated')
})

test('总时间预算必须真正生效：超预算后立刻停止换模型（回归：检查点放错位置导致 130s 空白）', async () => {
  // 每个候选都要花 50ms（模拟慢通道），预算 120ms → 最多试 3 个
  const ids = Array.from({ length: 20 }, (_, i) => `m${String(i).padStart(2, '0')}`)
  const { failover } = await setup({
    models: { 'our-free-model': ids },
    behaviour: Object.fromEntries(
      ids.map((id) => [
        `our-free-model/${id}`,
        { delayMs: 50, throw: { code: 'RATE_LIMIT', message: 'quota' } }
      ])
    ),
    config: {
      failover: {
        maxTotalMs: 2_000,
        maxRetriesPerModel: 0,
        retrySameModel: false,
        backoff: { initialMs: 0, maxMs: 0, jitterRatio: 0 },
        terminalFallback: false
      }
    }
  })

  const started = Date.now()
  await assert.rejects(() => failover.run({ messages: [] }), (error) => {
    assert.equal(error.name, 'AutopilotExhaustedError')
    return true
  })
  const elapsed = Date.now() - started
  // 预算 2000ms：跑满 20 个候选各 50ms 也只要 1000ms，所以关键是不许超时。
  assert.ok(elapsed < 3_000, `超预算后必须立刻停，实际用了 ${elapsed}ms`)
})

test('报错文案区分「预算耗尽」与「候选耗尽」，且错误码一一对应', async () => {
  const { EXHAUSTED_CODE } = await import('../src/failover/failover.js')
  // 两个码必须不同 —— 否则调用方无法区分「时间不够」与「池里没模型」
  assert.notEqual(EXHAUSTED_CODE.budget, EXHAUSTED_CODE.candidates)

  // 候选耗尽：候选很少、很快试完，预算没用满
  {
    const { failover } = await setup({
      models: { 'our-free-model': ['a'] },
      behaviour: { 'our-free-model/a': { throw: { code: 'RATE_LIMIT', message: 'quota' } } },
      config: { failover: { terminalFallback: false, maxRetriesPerModel: 0 } }
    })
    await assert.rejects(() => failover.run({ messages: [] }), (error) => {
      assert.match(error.message, /所有候选模型均失败/, '文案说候选耗尽')
      assert.equal(error.code, EXHAUSTED_CODE.candidates, '码必须是候选耗尽码')
      assert.equal(error.budgetExhausted, false)
      // 最后一次失败的具体语义另存，不与耗尽原因混在一个字段
      assert.equal(error.lastVerdictCode, 'RATE_LIMIT')
      return true
    })
  }

  // 预算耗尽：候选多、每步慢，预算先到
  {
    const ids = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const { failover } = await setup({
      models: { 'our-free-model': ids },
      behaviour: Object.fromEntries(
        ids.map((id) => [`our-free-model/${id}`, { delayMs: 700, throw: { code: 'RATE_LIMIT', message: 'quota' } }])
      ),
      config: {
        failover: {
          maxTotalMs: 5_000,
          maxRetriesPerModel: 0,
          retrySameModel: false,
          backoff: { initialMs: 0, maxMs: 0, jitterRatio: 0 },
          terminalFallback: false
        }
      }
    })
    await assert.rejects(() => failover.run({ messages: [] }), (error) => {
      assert.match(error.message, /换模型预算耗尽/, '文案说预算耗尽')
      assert.equal(error.code, EXHAUSTED_CODE.budget, '码必须是预算耗尽码')
      assert.equal(error.budgetExhausted, true)
      assert.ok(typeof error.elapsedMs === 'number', '要带已用时')
      assert.ok(typeof error.budgetMs === 'number', '要带上限')
      return true
    })
  }
})

test('慢失败仍受预算保护：首帧挂满时约 2-3 个候选就 break，不扫满 maxModels', async () => {
  const { EXHAUSTED_CODE } = await import('../src/failover/failover.js')
  const ids = Array.from({ length: 30 }, (_, i) => `s${String(i).padStart(2, '0')}`)
  const { failover } = await setup({
    models: { 'our-free-model': ids },
    behaviour: Object.fromEntries(
      ids.map((id) => [`our-free-model/${id}`, { slowMs: 11_000 }])
    ),
    config: {
      failover: {
        maxTotalMs: 30_000,
        firstFrameTimeoutMs: 10_000,
        maxRetriesPerModel: 0,
        retrySameModel: false,
        terminalFallback: false
      }
    }
  })
  const started = Date.now()
  await assert.rejects(() => failover.run({ messages: [] }), (error) => {
    // 首帧超时不原地重试，直接换下一个；10s 一个 → 30s 预算约试 3 个
    assert.ok(error.attempts.length <= 5, `应在预算内 break，实际试了 ${error.attempts.length} 个`)
    assert.equal(error.budgetExhausted, true)
    assert.equal(error.code, EXHAUSTED_CODE.budget, '慢失败耗尽的是时间，码应是预算耗尽')
    return true
  })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 40_000, `总耗时应在预算附近，实际 ${elapsed}ms`)
})

// ── 不再误报「所有候选均失败」 ───────────────────────────────────────────────

test('前 7 个候选失败、第 8 个可用：不能报耗尽', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `m${String(i).padStart(2, '0')}`)
  const { failover, llm } = await setup({
    models: { 'our-free-model': ids },
    behaviour: Object.fromEntries(
      ids.slice(0, 7).map((id) => [
        `our-free-model/${id}`,
        { throw: { code: 'RATE_LIMIT', message: '所有账号均不可用（限流或额度耗尽）' } }
      ])
    ),
    config: { failover: { terminalFallback: false, maxRetriesPerModel: 0 } }
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/m07', '必须跳过 7 个失败候选落到可用的那个')
  assert.equal(llm.calls.length, 8)
})

test('前 9 个候选失败、第 10 个可用：也不能报耗尽', async () => {
  const ids = Array.from({ length: 14 }, (_, i) => `m${String(i).padStart(2, '0')}`)
  const { failover } = await setup({
    models: { 'our-free-model': ids },
    behaviour: Object.fromEntries(
      ids.slice(0, 9).map((id) => [
        `our-free-model/${id}`,
        { throw: { code: 'RATE_LIMIT', message: 'quota exhausted' } }
      ])
    ),
    config: { failover: { terminalFallback: false, maxRetriesPerModel: 0 } }
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/m09')
})

test('真的全部失败时仍然报耗尽（放宽上限不等于永远不报）', async () => {
  const ids = ['a', 'b', 'c']
  const { failover } = await setup({
    models: { 'our-free-model': ids },
    behaviour: Object.fromEntries(
      ids.map((id) => [`our-free-model/${id}`, { throw: { code: 'RATE_LIMIT', message: 'quota' } }])
    ),
    config: { failover: { terminalFallback: false, maxRetriesPerModel: 0 } }
  })

  await assert.rejects(() => failover.run({ messages: [] }), (error) => {
    assert.equal(error.name, 'AutopilotExhaustedError')
    assert.equal(error.attempts.length, 3)
    return true
  })
})

test('账号级失败会跳过同通道剩余模型（有别的通道可用时）', async () => {
  const { failover, llm } = await setup({
    models: {
      // agnes 额度耗尽 → 同通道其它模型不必再试
      agnes: ['a1', 'a2', 'a3'],
      trae: ['t1']
    },
    behaviour: {
      'agnes/a1': { throw: { code: 'RATE_LIMIT', message: 'quota exhausted' } }
    },
    config: { failover: { terminalFallback: false, maxRetriesPerModel: 0 } }
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'trae/t1', '应跳到别的通道')
  assert.equal(
    llm.calls.some((key) => key.startsWith('agnes/a2') || key.startsWith('agnes/a3')),
    false,
    '同通道剩余模型应被跳过'
  )
})

test('多渠道路由网关不被整体跳过（our-free-model 的模型各自独立）', async () => {
  const { failover, llm } = await setup({
    models: { 'our-free-model': ['g1', 'g2', 'g3'] },
    behaviour: {
      'our-free-model/g1': { throw: { code: 'RATE_LIMIT', message: 'quota' } }
    },
    config: { failover: { terminalFallback: false, maxRetriesPerModel: 0 } }
  })

  const result = await failover.run({ messages: [] })
  assert.equal(result.model.key, 'our-free-model/g2', '同网关的下一个模型仍要试')
  assert.ok(llm.calls.includes('our-free-model/g2'))
})

// ── 宿主真实链路 ─────────────────────────────────────────────────────────────

test('宿主链路：真实 ctx.llm.stream 经 autopilot adapter，故障时切模型并把结果交给调用方', async () => {
  // 这条用例模拟宿主 agent-loop 的真实调用形状：
  //   llm.prepareCall({provider:'autopilot', model:'auto'}) → preparedCall.stream(request)
  // adapter 内部走 failover，最终由调用方消费流。
  const { adapter, llm, pool } = await setup({
    models: { 'our-free-model': ['free-a', 'free-b'] },
    behaviour: {
      'our-free-model/free-a': { throw: { code: 'MISSING_CREDENTIAL', message: 'no usable credential' } }
    }
  })

  const request = {
    provider: 'autopilot',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  }

  const chunks = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk.type)

  assert.ok(chunks.includes('text-delta'), '应当产出文本')
  assert.ok(chunks.includes('finish'), '应当正常收尾')
  assert.deepEqual(llm.calls, ['our-free-model/free-a', 'our-free-model/free-b'])
  assert.equal(pool.get('our-free-model/free-a').health, HEALTH.dead)
  assert.equal(pool.get('our-free-model/free-b').health, HEALTH.available)
})

test('宿主链路：adapter 记录调用统计 —— 证明真实请求确实进了 autopilot', async () => {
  const { adapter } = await setup({
    models: { 'our-free-model': ['free-a'] }
  })

  assert.equal(adapter.stats().calls, 0, '还没调用过')

  const request = {
    provider: 'autopilot',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  }
  for await (const _chunk of adapter.stream(request)) { /* consume */ }

  const stats = adapter.stats()
  assert.equal(stats.calls, 1, '调用次数应为 1')
  assert.ok(stats.lastCall, '要记下最后一次调用')
  assert.equal(stats.lastCall.messages, 1, '记录消息条数')
  assert.ok(stats.lastResult, '要记下最后一次选型')
  assert.equal(stats.lastResult.model.key, 'our-free-model/free-a')

  // 第二次调用：计数递增，用来区分「真实请求」与「测试请求」
  for await (const _chunk of adapter.stream(request)) { /* consume */ }
  assert.equal(adapter.stats().calls, 2)
})

test('宿主链路：adapter 的 stream 必须把 provider/model 换成真实候选，不能自我递归', async () => {
  const seen = []
  const { adapter } = await setup({
    models: { 'our-free-model': ['free-a'] },
    onStream: (key, options) => seen.push({ key, provider: options.provider, model: options.model })
  })

  const request = {
    provider: 'autopilot',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  }
  for await (const _chunk of adapter.stream(request)) { /* consume */ }

  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'our-free-model', '必须换成真实 provider')
  assert.equal(seen[0].model, 'free-a')
  assert.notEqual(seen[0].provider, 'autopilot', '不能递归回自己')
})

test('宿主链路：传给下游的请求不残留 autopilot/auto 虚拟路由', async () => {
  const seen = []
  const { adapter } = await setup({
    models: { 'our-free-model': ['free-a'] },
    onStream: (key, options) => seen.push(options)
  })
  const request = {
    provider: 'autopilot',
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  }
  for await (const _chunk of adapter.stream(request)) { /* consume */ }

  assert.equal(seen.length, 1)
  assert.equal(seen[0].provider, 'our-free-model')
  assert.equal(seen[0].model, 'free-a')
})
