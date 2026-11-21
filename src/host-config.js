/**
 * 宿主默认模型的持久化。
 *
 * 为什么需要自己写：宿主的 `agentDefaultModel.saveSelection()` 在
 * `ctx.get('configEditor')` 不存在时**静默 return**（dsh-agent-default-model/lib/index.js:55-56），
 * 而这台机器的 `config-editor` 是 disabled 状态。结果就是：
 *   - `sessionController.selectModel()` 只让**当前会话**临时生效（pending）；
 *   - 默认模型永远写不回 profile；
 *   - DSH 一重启，默认模型回到 patch 里的原值，会话随之掉回默认 ——
 *     用户看到的就是「重启后又卡住、插件没切换」（其实请求根本没经过插件）。
 *
 * 这里直接改 profile 的 `cordis.patch.yml` 里 `- id: agent-default-model` 那一段。
 * 只动 provider / model / reasoningEffort 三个值，保留注释与其余配置；写前备份。
 *
 * @module host-config
 */
import fs from 'node:fs'
import path from 'node:path'
import { failureOf } from './util.js'

/** 目标条目 id。 */
const ENTRY_ID = 'agent-default-model'

/**
 * 读 patch 文本里当前默认模型。
 * @param {string} text
 * @returns {{ provider: string, model: string, reasoningEffort: string | null } | null}
 */
export function readDefaultModel(text) {
  if (typeof text !== 'string') return null
  const lines = text.split('\n')
  const start = findEntryStart(lines)
  if (start === -1) return null
  const end = findEntryEnd(lines, start)
  let provider = null
  let model = null
  let reasoningEffort = null
  for (let index = start; index < end; index += 1) {
    const match = lines[index].match(/^\s+(provider|model|reasoningEffort):\s*(\S.*)?$/)
    if (!match) continue
    const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '')
    if (match[1] === 'provider') provider = value
    if (match[1] === 'model') model = value
    if (match[1] === 'reasoningEffort') reasoningEffort = value || null
  }
  if (provider === null || model === null) return null
  return { provider, model, reasoningEffort }
}

/**
 * 在 patch 文本里替换默认模型。返回新文本；结构异常时抛错（调用方负责不写盘）。
 * @param {string} text
 * @param {{ provider: string, model: string, reasoningEffort?: string | null }} next
 * @returns {string}
 */
export function writeDefaultModel(text, next) {
  if (typeof text !== 'string') throw new Error('patch 内容不是文本')
  if (!next || typeof next.provider !== 'string' || typeof next.model !== 'string') {
    throw new Error('provider 与 model 必填')
  }
  const lines = text.split('\n')
  const start = findEntryStart(lines)
  if (start === -1) throw new Error(`patch 里找不到 "- id: ${ENTRY_ID}" 条目`)
  const end = findEntryEnd(lines, start)

  // 定位 config 段与三个字段行。
  let configLine = -1
  const fieldLines = {}
  for (let index = start; index < end; index += 1) {
    if (/^\s*config:\s*$/.test(lines[index])) {
      configLine = index
      continue
    }
    const match = lines[index].match(/^(\s+)(provider|model|reasoningEffort):/)
    if (match && configLine !== -1 && index > configLine) {
      fieldLines[match[2]] = index
    }
  }

  const indent = '    '
  const set = (name, value) => {
    if (value === null || value === undefined) {
      if (fieldLines[name] !== undefined) lines[fieldLines[name]] = null
      return
    }
    if (fieldLines[name] !== undefined) {
      const current = lines[fieldLines[name]]
      const lead = current.match(/^(\s+)/)?.[1] ?? indent
      // 保留行尾注释（例如 `provider: x # magpie`）
      const trailing = current.match(/\s+#.*$/)?.[0] ?? ''
      lines[fieldLines[name]] = `${lead}${name}: ${value}${trailing}`
    } else {
      // 插到 config 之后
      lines.splice(configLine + 1, 0, `${indent}${name}: ${value}`)
      configLine += 1
      for (const key of Object.keys(fieldLines)) if (fieldLines[key] > configLine) fieldLines[key] += 1
      fieldLines[name] = configLine
    }
  }

  if (configLine === -1) throw new Error(`"- id: ${ENTRY_ID}" 下没有 config 段`)
  set('provider', next.provider)
  set('model', next.model)
  set('reasoningEffort', next.reasoningEffort ?? null)

  return lines.filter((line) => line !== null).join('\n')
}

/**
 * @param {string[]} lines
 * @returns {number} 条目起始行号；找不到 -1
 */
function findEntryStart(lines) {
  const pattern = new RegExp(`^-\\s*id:\\s*${ENTRY_ID}(\\s|#|$)`)
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index].trim())) return index
  }
  return -1
}

/**
 * 条目结束：下一个顶格 `- ` 行或文件末尾。
 * @param {string[]} lines
 * @param {number} start
 */
function findEntryEnd(lines, start) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^-\s/.test(lines[index])) return index
  }
  return lines.length
}

/**
 * 找出所有含 `agent-default-model` 的 profile patch。
 *
 * **所有 profile 都要改**：这个插件的默认模型设置是部署级配置，desktop / web /
 * yutu-diag 都是同一台机器上的同一套宿主，改一个不改其它的等于「有的会话走
 * autopilot、有的不走」，与插件的意图（所有会话都自动选型）相悖。
 *
 * @param {string} dshHome
 * @returns {string[]}
 */
export function findProfilePatches(dshHome) {
  const profilesDir = path.join(dshHome, 'profiles')
  /** @type {string[]} */
  const found = []
  let names = []
  try {
    names = fs.readdirSync(profilesDir)
  } catch {
    return found
  }
  for (const name of names) {
    const file = path.join(profilesDir, name, 'cordis.patch.yml')
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (text.includes(`id: ${ENTRY_ID}`)) found.push(file)
    } catch {
      /* 该 profile 没有 patch，跳过 */
    }
  }
  return found
}

/**
 * 把默认模型写进每一个 profile patch（写前备份，写后回读校验）。
 * @param {object} options
 * @param {string} options.dshHome
 * @param {{ provider: string, model: string, reasoningEffort?: string | null }} options.selection
 * @param {{ info?: Function, warn?: Function }} [options.logger]
 * @returns {{ updated: string[], skipped: string[], errors: { file: string, error: string }[] }}
 */
export function persistDefaultModel({ dshHome, selection, logger = console }) {
  /** @type {string[]} */
  const updated = []
  /** @type {string[]} */
  const skipped = []
  /** @type {{ file: string, error: string }[]} */
  const errors = []

  // 所有 profile 都写：这个插件的默认模型是部署级配置。
  for (const file of findProfilePatches(dshHome)) {
    try {
      const text = fs.readFileSync(file, 'utf8')
      const current = readDefaultModel(text)
      if (current && current.provider === selection.provider && current.model === selection.model) {
        skipped.push(file)
        continue
      }
      const next = writeDefaultModel(text, selection)
      // 写后校验：必须能读回同一组值，否则不落盘。
      const check = readDefaultModel(next)
      if (!check || check.provider !== selection.provider || check.model !== selection.model) {
        throw new Error('写入后回读不一致，放弃写盘')
      }
      fs.copyFileSync(file, `${file}.bak-autopilot-${Date.now()}`)
      const tmp = `${file}.tmp-${process.pid}`
      fs.writeFileSync(tmp, next, 'utf8')
      fs.renameSync(tmp, file)
      updated.push(file)
      logger.info?.(`model-autopilot: 默认模型已写入 ${path.basename(path.dirname(file))}/cordis.patch.yml → ${selection.provider}/${selection.model}`)
    } catch (error) {
      errors.push({ file, error: failureOf(error).message })
      logger.warn?.(`model-autopilot: 默认模型写入失败 ${file}（${failureOf(error).message}）`)
    }
  }
  return { updated, skipped, errors }
}
