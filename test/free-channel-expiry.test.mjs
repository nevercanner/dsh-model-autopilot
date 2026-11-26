#!/usr/bin/env node
/**
 * 限时免费额度到期判定。
 *
 * 为什么值得单独一组测试：厂商免费额度是**促销**，"12月31日前有效"到期那天
 * 同一条调用就开始按量计费。判定错了不会报错，只会安静地烧钱 —— 和 v0.2.8
 * 修的"付费账号被判免费"是同一类事故，这类必须钉死在测试里。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig, freeClassOf, freeChannelInfo, isFreeProvider } from '../src/config.js'
import {
  DEFAULT_FREE_CHANNELS,
  DEFAULT_CHANNEL_EXPIRY,
  channelExpiry,
  isExpiryPassed,
  freeChannelStatus,
  matchesFreeChannel
} from '../src/pool/free-channels.js'

/** 2026-12-31T23:59:59.999Z 之后的下一毫秒。 */
const AFTER_EXPIRY = Date.UTC(2027, 0, 1, 0, 0, 0, 1)
/** 到期日当天中午。 */
const ON_EXPIRY_DAY = Date.UTC(2026, 11, 31, 12, 0, 0)

test('新增的厂商免费 API 通道在名单里', () => {
  assert.equal(matchesFreeChannel('sensenova'), true)
  assert.equal(matchesFreeChannel('spark'), true)
  // modlens 转发变体同族
  assert.equal(matchesFreeChannel('modlens-sensenova'), true)
})

test('channelExpiry 按 family 查，返回 ISO 日期', () => {
  assert.equal(channelExpiry('agnes'), '2026-12-31')
  assert.equal(channelExpiry('modlens-agnes'), '2026-12-31')
  assert.equal(channelExpiry('SENSENOVA'.toLowerCase()), '2026-12-31')
  // 账号渠道不设期限
  assert.equal(channelExpiry('qoder'), null)
  assert.equal(channelExpiry(''), null)
})

test('isExpiryPassed：到期日当天仍有效，次日失效', () => {
  assert.equal(isExpiryPassed('2026-12-31', ON_EXPIRY_DAY), false)
  assert.equal(isExpiryPassed('2026-12-31', AFTER_EXPIRY), true)
  // 非法/缺失日期一律不判过期（宁可继续用，也不因为手滑把整批额度判死）
  assert.equal(isExpiryPassed(null), false)
  assert.equal(isExpiryPassed(''), false)
  assert.equal(isExpiryPassed('12/31/2026'), false)
})

test('freeChannelStatus 三态', () => {
  assert.deepEqual(freeChannelStatus('notychannel'), { channel: false, expired: false, expiresAt: null })
  assert.deepEqual(freeChannelStatus('spark', {}, ON_EXPIRY_DAY), {
    channel: true,
    expired: false,
    expiresAt: '2026-12-31'
  })
  assert.equal(freeChannelStatus('spark', {}, AFTER_EXPIRY).expired, true)
})

test('到期后 freeClassOf 返回 null —— 而且不被 defaultFree 捞回免费', () => {
  const config = normalizeConfig({ free: { defaultFree: true } })
  assert.equal(freeClassOf('agnes', config), 'channel')
  // 把内置到期日改成"昨天"的方式：显式覆盖成过去日期
  const expired = normalizeConfig({ free: { defaultFree: true, channelExpiry: { agnes: '2020-01-01' } } })
  assert.equal(freeClassOf('agnes', expired), null)
  assert.equal(isFreeProvider('modlens-agnes', expired), false)
  // 其他通道不受影响
  assert.equal(freeClassOf('spark', expired), 'channel')
})

test('channelExpiry 可延长，也可显式取消期限', () => {
  const extended = normalizeConfig({ free: { channelExpiry: { agnes: '2099-12-31' } } })
  assert.equal(freeChannelInfo('agnes', extended).expiresAt, '2099-12-31')

  const forever = normalizeConfig({ free: { channelExpiry: { agnes: null } } })
  assert.equal(freeChannelInfo('agnes', forever).expiresAt, null)
  assert.equal(freeChannelInfo('agnes', forever).expired, false)
  assert.equal(freeClassOf('agnes', forever), 'channel')
})

test('非法到期日不覆盖内置值（手滑不该搞死额度）', () => {
  const config = normalizeConfig({ free: { channelExpiry: { agnes: '下次一定' } } })
  assert.equal(freeChannelInfo('agnes', config).expiresAt, DEFAULT_CHANNEL_EXPIRY.agnes)
})

test('free.providers 显式声明优先于到期判定', () => {
  const config = normalizeConfig({
    free: { providers: ['agnes'], channelExpiry: { agnes: '2020-01-01' } }
  })
  // 用户明确说"这个通道免费"时以用户为准（source 为 config）
  assert.equal(freeClassOf('agnes', config), 'config')
})

test('名单本身不被到期改写：默认名单里仍有到期的通道', () => {
  assert.ok(DEFAULT_FREE_CHANNELS.includes('bailian'))
  assert.ok(Object.keys(DEFAULT_CHANNEL_EXPIRY).includes('bailian'))
})
