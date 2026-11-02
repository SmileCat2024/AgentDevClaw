import {
  cleanSessionText, parseListField, sanitizeSessionFragment, log,
} from '../shared/string-helpers.js';
import { startLocalRuntime } from './local-backend.js';
import { containerRuntimeBackend } from './container-backend.js';

export const RUNTIME_EXECUTOR_LOCAL = 'local';
export const RUNTIME_EXECUTOR_CONTAINER = 'container';

export const localRuntimeBackend = { name: RUNTIME_EXECUTOR_LOCAL, start: startLocalRuntime };
export { containerRuntimeBackend };

/**
 * 执行后端选择（ADR-0037 M4，实验形态 env 开关；配置入口产品化归后续里程碑）：
 *
 * - CLAW_RUNTIME_EXECUTOR：local（默认）| container。container 经 dockerode
 *   运行 pack:container 预构建的按 agent 镜像（默认 tag
 *   agentdev-claw-runtime:<agentId>，CLAW_RUNTIME_CONTAINER_IMAGE 可整体覆盖；
 *   运行时不构建；镜像缺失 / Docker 不可用 / 平台未开启 TCP 与非回环 HTTP
 *   绑定时启动报错，不静默回退 local）。
 * - CLAW_RUNTIME_EXECUTOR_AGENTS：逗号分隔的 agentId 清单；空 = 全部托管 spawn。
 *   清单外的 agent 落回 local，支持单 agent 试点。
 *
 * 共享进程模式的 bootstrap spawn（首会话，argv 带 session）与 isolated 同构，
 * 可走容器；边界在宿主 join 路径（add-session 需本地 IPC）——容器共享进程的
 * join 在 agent-startup 显式报错，不在此处整体回退（M6 修订）。
 */
export function resolveRuntimeExecutor({ agentId, processMode, env = process.env }) {
  void processMode; // bootstrap spawn 不依赖进程模式；join 边界在宿主层守卫
  const configured = cleanSessionText(env.CLAW_RUNTIME_EXECUTOR) || RUNTIME_EXECUTOR_LOCAL;
  if (configured === RUNTIME_EXECUTOR_LOCAL) return localRuntimeBackend;
  if (configured !== RUNTIME_EXECUTOR_CONTAINER) {
    throw new Error(`未知 CLAW_RUNTIME_EXECUTOR "${configured}"（可选 local | container）`);
  }
  const agentFilter = parseListField(env.CLAW_RUNTIME_EXECUTOR_AGENTS);
  if (agentFilter.length > 0 && !agentFilter.includes(sanitizeSessionFragment(agentId))) {
    return localRuntimeBackend;
  }
  // 共享进程模式（shared-by-project / shared-global）的 bootstrap spawn 可走
  // 容器（argv 带 session，与 isolated 同构）；边界在宿主 join 路径——容器
  // handle 无父子 IPC，add-session 不可用，宿主层对容器共享进程的 join 显式
  // 报错（agent-startup join 分支守卫），不在此处整体回退。
  return containerRuntimeBackend;
}
