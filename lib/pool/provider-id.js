/**
 * provider id 归一化。
 *
 * 为什么需要单独一个模块：宿主里同一个真实渠道会以多种 id 出现——
 * `deepseek-account`（直连）与 `modlens-deepseek-account`（modlens 转发）、
 * `bailian` 与 `modlens-bailian`。这些是**同一个账号、同一笔钱**。
 *
 * 但配置里的 `paid.providers` / `schedule.excludeProviders` / `providerOrder`
 * 过去都是**精确字符串比较**，于是出现两个真实事故：
 *   1. `paid.providers: ['deepseek-account']` 挡不住 `modlens-deepseek-account/*`，
 *      付费账号被当成免费候选去调，余额被打空（Insufficient Balance）。
 *   2. `excludeProviders: ['deepseek-account']` 同样挡不住 modlens 变体，
 *      被排除的 provider 依旧进池、依旧被探针和调度选中。
 *
 * 所以凡是「拿 provider id 去比对一份名单」的地方，都走这里：
 * 先剥转发前缀、统一小写，再比。
 *
 * @module pool/provider-id
 */

/** modlens 转发前缀：`modlens-<渠道>` 等价于 `<渠道>`。 */
export const FORWARD_PREFIX = 'modlens-'

/**
 * 归一化 provider id：可重复剥离转发前缀 + 小写。
 * @param {unknown} id
 * @returns {string} 归一化后的 family 名（空值返回 ''）
 */
export function providerFamily(id) {
  let value = String(id ?? '').trim().toLowerCase()
  while (value.startsWith(FORWARD_PREFIX)) value = value.slice(FORWARD_PREFIX.length)
  return value
}

/**
 * 两个 provider id 是否属于同一 family（同一个真实渠道）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameFamily(a, b) {
  const left = providerFamily(a)
  return left !== '' && left === providerFamily(b)
}

/**
 * provider id 是否命中一份 provider 名单（名单项按 family 比对）。
 * @param {unknown} id
 * @param {Iterable<string> | null | undefined} list
 * @returns {boolean}
 */
export function matchesProviderList(id, list) {
  if (!list) return false
  const family = providerFamily(id)
  if (family === '') return false
  for (const candidate of list) {
    if (providerFamily(candidate) === family) return true
  }
  return false
}

/**
 * provider id 在名单里的位置（family 比对），未命中返回 -1。
 * 用于 `schedule.providerOrder` 置顶排序。
 * @param {unknown} id
 * @param {readonly string[] | null | undefined} list
 * @returns {number}
 */
export function familyIndex(id, list) {
  if (!Array.isArray(list) || list.length === 0) return -1
  const family = providerFamily(id)
  if (family === '') return -1
  for (let i = 0; i < list.length; i += 1) {
    if (providerFamily(list[i]) === family) return i
  }
  return -1
}

/**
 * 在一份以 provider id 为键的对象里取值，先精确匹配，再按 family 匹配。
 * 用于 `paid.priorities` 这类 `{ provider: number }` 映射。
 * @template T
 * @param {unknown} id
 * @param {Record<string, T> | null | undefined} table
 * @returns {T | undefined}
 */
export function lookupByFamily(id, table) {
  if (!table || typeof table !== 'object') return undefined
  if (Object.prototype.hasOwnProperty.call(table, String(id))) return table[String(id)]
  const family = providerFamily(id)
  if (family === '') return undefined
  for (const key of Object.keys(table)) {
    if (providerFamily(key) === family) return table[key]
  }
  return undefined
}
