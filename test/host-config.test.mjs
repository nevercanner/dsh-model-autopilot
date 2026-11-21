/**
 * 默认模型落盘：读写 profile patch。
 *
 * 这条路径会改用户的配置文件，测不住就会把 DSH 启动配置写坏，
 * 所以覆盖：保留注释、保留其它条目、字段缺失时插入、写后回读一致、备份。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readDefaultModel, writeDefaultModel, persistDefaultModel, findProfilePatches } from '../src/host-config.js'

const logger = { info() {}, warn() {} }

const PATCH = `# profile patch
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1

- id: agent-default-model # magpie
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high

- id: llm-pi-ai
  config:
    providers:
      magpie: {}
`

test('读取当前默认模型', () => {
  const current = readDefaultModel(PATCH)
  assert.deepEqual(current, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
})

test('写入后能读回，且保留注释与其它条目', () => {
  const next = writeDefaultModel(PATCH, { provider: 'autopilot', model: 'auto' })
  const check = readDefaultModel(next)
  assert.deepEqual(check, { provider: 'autopilot', model: 'auto', reasoningEffort: null })

  // 其它内容原样保留
  assert.match(next, /- id: ui-settings-general/)
  assert.match(next, /welcomeNoticeVersion: 2026-09-28\.1/)
  assert.match(next, /- id: llm-pi-ai/)
  assert.match(next, /magpie: \{\}/)
  // 行尾注释保留
  assert.match(next, /- id: agent-default-model # magpie/)
})

test('reasoningEffort 传值时会写入', () => {
  const next = writeDefaultModel(PATCH, { provider: 'minimax-cn', model: 'MiniMax-M3', reasoningEffort: 'low' })
  assert.deepEqual(readDefaultModel(next), {
    provider: 'minimax-cn',
    model: 'MiniMax-M3',
    reasoningEffort: 'low'
  })
})

test('条目里缺 provider/model 字段时插入到 config 之后', () => {
  const thin = `- id: agent-default-model
  config:
    unrelated: 1

- id: other
`
  const next = writeDefaultModel(thin, { provider: 'autopilot', model: 'auto' })
  assert.deepEqual(readDefaultModel(next), { provider: 'autopilot', model: 'auto', reasoningEffort: null })
  assert.match(next, /unrelated: 1/, '原有字段不能丢')
})

test('找不到条目时明确报错（而不是瞎写）', () => {
  assert.throws(() => writeDefaultModel('# empty\n', { provider: 'a', model: 'b' }), /找不到/)
})

test('persistDefaultModel：写盘 + 备份 + 回读校验', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))
  const profileDir = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profileDir, { recursive: true })
  const file = path.join(profileDir, 'cordis.patch.yml')
  fs.writeFileSync(file, PATCH, 'utf8')

  assert.deepEqual(findProfilePatches(home), [file])

  const result = persistDefaultModel({
    dshHome: home,
    selection: { provider: 'autopilot', model: 'auto' },
    logger
  })
  assert.equal(result.errors.length, 0)
  assert.deepEqual(result.updated, [file])
  assert.deepEqual(readDefaultModel(fs.readFileSync(file, 'utf8')), {
    provider: 'autopilot',
    model: 'auto',
    reasoningEffort: null
  })
  // 备份存在
  const backups = fs.readdirSync(profileDir).filter((name) => name.includes('.bak-autopilot-'))
  assert.equal(backups.length, 1)

  // 第二次写同样的值 → skipped，不重复写
  const again = persistDefaultModel({
    dshHome: home,
    selection: { provider: 'autopilot', model: 'auto' },
    logger
  })
  assert.deepEqual(again.updated, [])
  assert.deepEqual(again.skipped, [file])
})

test('所有 profile 都写：插件的默认模型是部署级配置', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-multi-'))
  for (const name of ['desktop', 'web', 'yutu-diag']) {
    const dir = path.join(home, 'profiles', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), PATCH, 'utf8')
  }

  const result = persistDefaultModel({
    dshHome: home,
    selection: { provider: 'autopilot', model: 'auto' },
    logger
  })
  assert.equal(result.errors.length, 0)
  assert.equal(result.updated.length, 3, '三个 profile 都要改')
  for (const name of ['desktop', 'web', 'yutu-diag']) {
    const text = fs.readFileSync(path.join(home, 'profiles', name, 'cordis.patch.yml'), 'utf8')
    assert.equal(readDefaultModel(text).provider, 'autopilot', `${name} 应改为 autopilot`)
  }
})

test('没有 profiles 目录时安全返回空结果', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-empty-'))
  const result = persistDefaultModel({ dshHome: home, selection: { provider: 'a', model: 'b' }, logger })
  assert.deepEqual(result, { updated: [], skipped: [], errors: [] })
})
