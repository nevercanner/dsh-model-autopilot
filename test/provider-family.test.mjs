/**
 * provider family 归一化测试。
 *
 * 这一组守的是**钱**：`modlens-<渠道>` 与 `<渠道>` 是同一个账号、同一笔钱，
 * 但配置里的 provider 名单从前是精确字符串比较 —— 于是
 *   paid.providers: ['deepseek-account']
 * 挡不住 `modlens-deepseek-account/*`，插件把它当免费候选调用，
 * 余额被点到 Insufficient Balance。这里逐条钉住修复后的行为。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPool } from '../src/pool/pool.js'
import { normalizeConfig, freeClassOf, isFreeProvider } from '../src/config.js'
import { providerRank } from '../src/schedule/scoring.js'
import { familyIndex, lookupByFamily, matchesProviderList, providerFamily } from '../src/pool/provider-id.js'

const logger = { info() {}, warn() {} }

/** 内存 store，形状与 src/store.js 一致（池需要 setModel/setMeta/model）。 */
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

test('providerFamily 剥掉可重复的 modlens 前缀并小写', () => {
  assert.equal(providerFamily('modlens-deepseek-account'), 'deepseek-account')
  assert.equal(providerFamily('MODLENS-modlens-Trae'), 'trae')
  assert.equal(providerFamily('  Bailian  '), 'bailian')
  assert.equal(providerFamily(null), '')
  assert.equal(providerFamily(''), '')
})

test('matchedProviderList 按 family 命中，不受转发前缀影响', () => {
  assert.equal(matchesProviderList('modlens-deepseek-account', ['deepseek-account']), true)
  assert.equal(matchesProviderList('deepseek-account', ['modlens-deepseek-account']), true)
  assert.equal(matchesProviderList('deepseek-account-x', ['deepseek-account']), false)
  assert.equal(matchesProviderList('autopilot', null), false)
})

test('paid.providers 按 family 生效：modlens 变体也判付费', () => {
  const config = normalizeConfig({ paid: { providers: ['deepseek-account'] } })
  assert.equal(freeClassOf('deepseek-account', config), null)
  assert.equal(freeClassOf('modlens-deepseek-account', config), null, 'modlens 转发变体必须同样判付费')
})

test('defaultFree 白名单模式也不会把按量计费账号判成免费', () => {
  // 用户的实际配置：除 minimax-cn 外一律「算免费」的省事模式。
  // 若此时 deepseek-official（自有 API Key，按 token 计费）被判免费，
  // 「免费优先」就变成「先烧真钱」。
  const config = normalizeConfig({
    free: { defaultFree: true },
    paid: { providers: ['minimax-cn'] }
  })
  assert.equal(freeClassOf('minimax-cn', config), null, '显式付费清单优先')
  assert.equal(freeClassOf('deepseek-official', config), null, '按量计费账号不能被 defaultFree 放行')
  assert.equal(freeClassOf('deepseek-account', config), null)
  assert.equal(freeClassOf('modlens-deepseek-account', config), null, 'modlens 变体同样拦')
  assert.equal(freeClassOf('agnes', config), 'channel', '免费通道照旧免费')
  assert.equal(freeClassOf('some-new-gateway', config), 'default', '未知 provider 仍走白名单兜底')
})

test('free.providers 可以显式放行被 implied 拦下的账号（用户账号事实优先）', () => {
  const config = normalizeConfig({
    free: { defaultFree: true, providers: ['deepseek-official'] }
  })
  assert.equal(freeClassOf('deepseek-official', config), 'config')
  assert.equal(freeClassOf('modlens-deepseek-official', config), 'config', '放行也按 family 生效')
})

test('paid.impliedProviders 是代码级安全网：配置里删不掉内置那两条', () => {
  const config = normalizeConfig({ paid: { impliedProviders: ['my-metered-provider'] } })
  assert.deepEqual(
    [...config.paid.impliedProviders].sort(),
    ['deepseek-account', 'deepseek-official', 'my-metered-provider'],
    '用户可以追加，但不能移除内置的两条'
  )
  assert.equal(isFreeProvider('my-metered-provider', config), false)
})

test('excludeProviders 按 family 生效：排除 deepseek-account 也排除它的转发变体', async () => {
  const models = {
    autopilot: ['auto'],
    'deepseek-account': ['deepseek-flash'],
    'modlens-deepseek-account': ['deepseek-v4-pro'],
    agnes: ['agnes-2.5-flash']
  }
  const llm = {
    listProviders: () => Object.keys(models).map((id) => ({ id, name: id })),
    listModels: async (provider) => models[provider].map((id) => ({ provider, id, name: id })),
    resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model })
  }
  const config = normalizeConfig({
    schedule: { excludeProviders: ['autopilot', 'deepseek-account'] }
  })
  const pool = createPool({ ctx: { llm }, config, store: createFakeStore(), logger })
  await pool.reload()

  const keys = pool.all().map((entry) => entry.key)
  assert.ok(keys.includes('agnes/agnes-2.5-flash'))
  assert.ok(!keys.includes('deepseek-account/deepseek-flash'), '被排除的通道不该进池')
  assert.ok(!keys.includes('modlens-deepseek-account/deepseek-v4-pro'), '转发变体同样要被排除')
})

test('providerOrder 置顶按 family 生效：置顶 minimax-cn 时转发变体同序', () => {
  const config = normalizeConfig({ schedule: { providerOrder: ['minimax-cn'] } })
  assert.equal(providerRank('minimax-cn', config), 0)
  assert.equal(providerRank('modlens-minimax-cn', config), 0)
  assert.equal(providerRank('agnes', config), 1)
})

test('额度情报查找支持 family（额度按渠道记账，转发变体共用）', () => {
  const table = { agnes: { hasUsableQuota: true } }
  assert.deepEqual(lookupByFamily('modlens-agnes', table), { hasUsableQuota: true })
  assert.equal(lookupByFamily('agnes', table), table.agnes)
  assert.equal(lookupByFamily('zhipu', table), undefined)
})

test('familyIndex 未命中返回 -1', () => {
  assert.equal(familyIndex('agnes', ['minimax-cn']), -1)
  assert.equal(familyIndex('modlens-minimax-cn', ['minimax-cn']), 0)
  assert.equal(familyIndex('agnes', null), -1)
})
