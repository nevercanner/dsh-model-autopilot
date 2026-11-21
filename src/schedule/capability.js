/**
 * 需求 → 能力过滤。
 *
 * 判断原则：**未知不等于不够**。免费通道常常不给上下文窗口元数据
 * （`contextWindow: 0`），若把未知一律判为“不满足”，免费模型会被整体排除，
 * “免费优先”直接落空。所以未知一律放行，只排除「明确不够」的条目。
 *
 * @module schedule/capability
 */

/**
 * @typedef {object} CapabilityRequirement
 * @property {number} [minContextWindow] - 需要的最小上下文窗口（token）
 * @property {('text'|'image')[]} [input] - 需要的输入模态
 * @property {boolean} [reasoning] - 是否需要 reasoning effort
 */

/**
 * @param {import('../pool/types.js').ModelEntry} entry
 * @param {CapabilityRequirement | undefined} requirement
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkCapability(entry, requirement) {
  if (!requirement) return { ok: true }

  if (typeof requirement.minContextWindow === 'number' && requirement.minContextWindow > 0) {
    // contextWindow === 0 表示未声明，不是“很小”。
    if (entry.contextWindow > 0 && entry.contextWindow < requirement.minContextWindow) {
      return {
        ok: false,
        reason: `context ${entry.contextWindow} < 要求 ${requirement.minContextWindow}`
      }
    }
  }

  if (Array.isArray(requirement.input) && requirement.input.length > 0) {
    const declared = Array.isArray(entry.inputModalities) && entry.inputModalities.length > 0
      ? entry.inputModalities
      : ['text']
    for (const modality of requirement.input) {
      if (!declared.includes(modality)) return { ok: false, reason: `缺少模态 ${modality}` }
    }
  }

  if (requirement.reasoning === true && entry.reasoning === false) {
    return { ok: false, reason: '未声明 reasoning effort' }
  }

  return { ok: true }
}
