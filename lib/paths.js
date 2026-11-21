/**
 * 数据目录解析。
 *
 * 与 dsh-our-free-model 保持同一约定：`DSH_HOME` 环境变量优先，否则 `~/.dsh`，
 * 插件自己的子目录名即插件数据命名空间。
 *
 * @module paths
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 本插件在 DSH home 下的数据子目录。 */
export const DATA_DIR_NAME = 'model-autopilot'

/**
 * @returns {string} DSH home 的绝对路径
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * 解析并确保数据目录存在。
 * @param {{ dataDir?: string | null }} config
 * @returns {string}
 */
export function resolveDataDir(config = {}) {
  const dir = config.dataDir ? path.resolve(config.dataDir) : path.join(resolveDshHome(), DATA_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
