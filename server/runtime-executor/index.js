import {
  cleanSessionText, parseListField, sanitizeSessionFragment, log,
} from '../shared/string-helpers.js';
import {
  PROCESS_MODE_SHARED_BY_PROJECT,
  PROCESS_MODE_SHARED_GLOBAL,
} from '../shared/process-mode.js';
import { startLocalRuntime } from './local-backend.js';

export const RUNTIME_EXECUTOR_LOCAL = 'local';
export const RUNTIME_EXECUTOR_CONTAINER = 'container';

export const localRuntimeBackend = { name: RUNTIME_EXECUTOR_LOCAL, start: startLocalRuntime };

/**
 * 执行后端选择（ADR-0037 M4，实验形态 env 开关；配置入口产品化归后续里程碑）：
 *
 * - CLAW_RUNTIME_EXECUTOR：local（默认）| container。container 后端在 M6 接入，
 *   当前显式报错——不静默回退 local，避免误以为已跑在容器里。
 * - CLAW_RUNTIME_EXECUTOR_AGENTS：逗号分隔的 agentId 清单；空 = 全部托管 spawn。
 *   清单外的 agent 落回 local，支持单 agent 试点。
 *
 * 共享进程模式（shared-by-project / shared-global）依赖宿主→子进程 add-session
 * IPC，跨容器边界不成立：选 container 时回退 local 并记 warn 日志。
 */
export function resolveRuntimeExecutor({ agentId, processMode, env = process.env }) {
  const configured = cleanSessionText(env.CLAW_RUNTIME_EXECUTOR) || RUNTIME_EXECUTOR_LOCAL;
  if (configured === RUNTIME_EXECUTOR_LOCAL) return localRuntimeBackend;
  if (configured !== RUNTIME_EXECUTOR_CONTAINER) {
    throw new Error(`未知 CLAW_RUNTIME_EXECUTOR "${configured}"（可选 local | container）`);
  }
  const agentFilter = parseListField(env.CLAW_RUNTIME_EXECUTOR_AGENTS);
  if (agentFilter.length > 0 && !agentFilter.includes(sanitizeSessionFragment(agentId))) {
    return localRuntimeBackend;
  }
  if (processMode === PROCESS_MODE_SHARED_BY_PROJECT || processMode === PROCESS_MODE_SHARED_GLOBAL) {
    log('runtime-executor', `container executor 不支持共享进程模式，agent=${agentId} 回退 local`, 'warn');
    return localRuntimeBackend;
  }
  throw new Error('container 执行后端尚未实施（ADR-0037 M6）；当前 CLAW_RUNTIME_EXECUTOR 仅支持 local');
}
