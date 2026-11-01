import { CODER_RUNTIME_MODE_VALUES } from './permission-registry.js';

export const CODER_RUNTIME_MODE_STANDARD = 'standard';
export const CODER_RUNTIME_MODE_CONTAINER = 'container';
export const CODER_RUNTIME_MODE_AGENT_CHOICE = 'agent-choice';

export function runtimeModeToExecutor(mode) {
  if (mode === CODER_RUNTIME_MODE_STANDARD) return 'local';
  if (mode === CODER_RUNTIME_MODE_CONTAINER) return 'container';
  return null;
}

/** Resolve and enforce the user's Coder runtime-mode authorization. */
export async function resolveCoderRuntimeMode(requestedMode, { readPolicies, configuredMode, allowPolicyDefault = false } = {}) {
  const policies = typeof readPolicies === 'function' ? await readPolicies() : null;
  const configured = configuredMode || policies?.coder?.runtimeExecutionMode || CODER_RUNTIME_MODE_STANDARD;
  if (!CODER_RUNTIME_MODE_VALUES.includes(configured)) {
    throw Object.assign(new Error(`Invalid configured Coder runtime mode: ${configured}`), { statusCode: 500, code: 'coder_runtime_policy_invalid' });
  }
  if (requestedMode === undefined && allowPolicyDefault && configured !== CODER_RUNTIME_MODE_AGENT_CHOICE) return configured;
  if (requestedMode === undefined) {
    throw Object.assign(new Error('Coder dispatch must explicitly select runtimeMode=standard or container'), { statusCode: 400, code: 'coder_runtime_mode_required' });
  }
  if (!CODER_RUNTIME_MODE_VALUES.slice(0, 2).includes(requestedMode)) {
    throw Object.assign(new Error('runtimeMode must be "standard" or "container"'), { statusCode: 400, code: 'invalid_runtime_mode' });
  }
  if (configured === CODER_RUNTIME_MODE_AGENT_CHOICE) return requestedMode;
  if (requestedMode !== configured) {
    throw Object.assign(new Error(`Coder runtime mode "${requestedMode}" is not allowed by the fixed user policy "${configured}"`), { statusCode: 403, code: 'coder_runtime_mode_forbidden' });
  }
  return configured;
}

// 会话级运行模式（ADR-0037）：会话 metadata 持久化 runtimeMode，启动按它覆盖
// executor。coder 走无人值守策略闸门（用户批准固定模式 / agent-choice 显式选择）；
// programming-helper 是用户亲自操作的交互入口，入口选择即用户意愿，不设策略闸门
// ——缺省不传 = 维持现状（本地 executor），显式传值只接受 standard / container。
export const SESSION_RUNTIME_MODE_AGENTS = new Set(['coder', 'programming-helper']);

export function supportsSessionRuntimeMode(agentId) {
  return SESSION_RUNTIME_MODE_AGENTS.has(agentId);
}

/** Resolve a session runtime mode by agent dispatch semantics; undefined = unset. */
export async function resolveSessionRuntimeMode(agentId, requestedMode, options = {}) {
  if (agentId === 'coder') return resolveCoderRuntimeMode(requestedMode, options);
  if (requestedMode === undefined) return undefined;
  if (!CODER_RUNTIME_MODE_VALUES.slice(0, 2).includes(requestedMode)) {
    throw Object.assign(new Error('runtimeMode must be "standard" or "container"'), { statusCode: 400, code: 'invalid_runtime_mode' });
  }
  return requestedMode;
}
