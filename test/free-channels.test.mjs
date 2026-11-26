/**
 * 免费判定测试：这条规则决定「最大化利用免费模型」是否成立，必须可回归。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, isFreeProvider, freeClassOf } from '../src/config.js'
import { matchesFreeChannel } from '../src/pool/free-channels.js'

test('our-free-model 已从免费名单移除（2026-11-26 隔离出本机）', () => {
  // 用户把 our-free-model 系列隔离出本机后，渠道本体仍在但不再随插件回装，
  // 免费名单里随之移除。它既不是已知免费通道、也不命中 'free' 片段
  // （'our-free-model' 本身含 free 字样，但名单移除后仍会被 patterns 判免费 ——
  //  所以这里断言的是**名单层面**的移除，patterns 兜底仍可能让它算免费）。
  const config = normalizeConfig({})
  const channelHit = matchesFreeChannel('our-free-model')
  assert.equal(channelHit, false, 'our-free-model 不应再命中已知免费通道名单')
})

test('our-free-model 的账号渠道算免费（id 里没有 free 字样）', () => {
  const config = normalizeConfig({})
  for (const id of ['lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'zcode', 'gemini', 'minimax', 'deepseek-web']) {
    assert.equal(isFreeProvider(id, config), true, `${id} 应判免费`)
    assert.equal(freeClassOf(id, config), 'channel', `${id} 的判定依据应为已知通道`)
  }
})

test('modlens 前缀剥离后按同一份名单判定', () => {
  assert.equal(matchesFreeChannel('modlens-qoder'), true)
  assert.equal(matchesFreeChannel('modlens-trae'), true)
  assert.equal(matchesFreeChannel('modlens-deepseek-account'), false)
})

test('用户自行注册、领厂商免费配额的通道按免费处理', () => {
  const config = normalizeConfig({})
  // 这些通道走的是厂商白送的新人/每日额度（凭据库里已有 Key），
  // 不算订阅付费，必须按免费算，否则会被排到免费模型之后、探针也探不到。
  for (const id of ['agnes', 'siliconflow', 'bailian', 'zhipu', 'sensenova', 'spark']) {
    assert.equal(isFreeProvider(id, config), true, `${id} 应算免费通道`)
  }
})

test('真正的订阅付费通道仍按付费处理', () => {
  const config = normalizeConfig({})
  for (const id of ['minimax-cn', 'deepseek-official', 'workbuddy', 'workbuddy-ai', 'qoder-fake-saas']) {
    assert.equal(isFreeProvider(id, config), false, `${id} 不应被判免费`)
  }
})

test('付费名单可以否决内置免费通道（用户账号事实优先）', () => {
  const config = normalizeConfig({ paid: { providers: ['trae'] } })
  assert.equal(isFreeProvider('trae', config), false)
})

test('free.providers 可以显式把任意 provider 拉成免费，判定依据为 config', () => {
  const config = normalizeConfig({ free: { providers: ['workbuddy'] } })
  assert.equal(isFreeProvider('workbuddy', config), true)
  assert.equal(freeClassOf('workbuddy', config), 'config')
})

test('channels 可被配置覆盖为空，退回 patterns 兜底', () => {
  const config = normalizeConfig({ free: { channels: [] } })
  assert.equal(isFreeProvider('lobsterai', config), false)
  assert.equal(isFreeProvider('our-free-model', config), true) // 仍命中 'free' 片段
  assert.equal(freeClassOf('our-free-model', config), 'pattern')
})
