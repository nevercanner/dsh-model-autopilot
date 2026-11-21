/**
 * 注册清单测试：能接进 DSH 的厂商、签到节奏、链接完整性。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { VENDOR_PLANS, CADENCE_LABEL, groupPlans } from '../src/onboarding.js'

test('每条厂商都有完整信息：链接、节奏、领取方式', () => {
  for (const plan of VENDOR_PLANS) {
    assert.ok(plan.id, '缺 id')
    assert.ok(plan.name, `${plan.id} 缺 name`)
    assert.ok(plan.provider, `${plan.id} 缺 provider`)
    assert.ok(plan.amount, `${plan.id} 缺 amount`)
    assert.ok(plan.how, `${plan.id} 缺 how`)
    assert.match(plan.claimUrl, /^https?:\/\//, `${plan.id} 的 claimUrl 不是 http(s)`)
    assert.match(plan.apiKeyUrl, /^https?:\/\//, `${plan.id} 的 apiKeyUrl 不是 http(s)`)
    assert.ok(CADENCE_LABEL[plan.cadence], `${plan.id} 的节奏 ${plan.cadence} 没有中文标签`)
  }
})

test('id 不重复', () => {
  const ids = VENDOR_PLANS.map((plan) => plan.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('每天要签到的条目必须写明「签到」，否则用户不知道要手动操作', () => {
  const daily = VENDOR_PLANS.filter((plan) => plan.cadence === 'daily')
  assert.ok(daily.length > 0, '应该至少有一条每天的')
  for (const plan of daily) {
    assert.match(plan.how + plan.amount, /签到|登录|重置/, `${plan.id} 是每天的，但没说清怎么拿`)
  }
})

test('按 provider 分组，同 provider 的条目归到一起', () => {
  const groups = groupPlans()
  assert.ok(groups.length > 0)
  const bailian = groups.find((group) => group.provider === 'bailian')
  assert.ok(bailian, 'bailian 应有自己的分组')
  assert.ok(bailian.items.length >= 2, 'bailian 有新人额度与学生额度两条')
})

test('已知的 DSH provider 都在清单里（bailian/agnes/minimax/siliconflow 等）', () => {
  const providers = new Set(VENDOR_PLANS.map((plan) => plan.provider))
  for (const id of ['bailian', 'agnes', 'minimax', 'siliconflow', 'qiniu', 'modelscope']) {
    assert.ok(providers.has(id), `清单里应有 ${id}`)
  }
})
