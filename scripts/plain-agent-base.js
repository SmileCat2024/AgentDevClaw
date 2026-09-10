/**
 * Plain agent 默认执行底座 — runner 级装配
 *
 * 让 plain agent 与 workspace coder 共享同一套自主执行安全网：
 *   - ContinuityAwareOpencodeBasic：文件工具 + 先读后写保护 + continuity 协议
 *     自声明（trim/摘要接力时 readFiles 状态随协议转移）；
 *   - OutputGuardFeature：工具输出截断安全网，防止上下文溢出；
 *   - ContextRotationTriggerFeature：上下文过界触发器，过界打断当前轮并经
 *     onTrip 回调交由 plain-agent-rotation 在进程内执行接力（不经 server）。
 *
 * 按(feature)名去重：agent.js 自行挂载的同名 feature 不覆盖——底座只兜底，
 * 用户的显式装配优先。todo / shell / memory 等执行纪律与工具不进底座，
 * 由 agent 经 metadata.features（tgz 仓库精确版本）或自身 use() 装配。
 *
 * 触发器不携带 serverOrigin：plain agent 的过界接力在本进程内完成，向
 * server 上报 context_guard_event 只会触发一次针对未知会话的 server 侧
 * 旋转，无意义。
 */

import { OutputGuardFeature } from '@agentdevjs/core';
import { ContinuityAwareOpencodeBasic } from '../local-features/dist/feature-wrappers/src/index.js';
import { ContextRotationTriggerFeature } from '../local-features/dist/context-guard/src/index.js';

/**
 * 挂载 plain agent 默认底座。
 *
 * @param {import('@agentdevjs/core').Agent} agent - 已由用户 agent.js 构造的实例
 * @param {object} [options]
 * @param {string} [options.workspaceDir] - 工具默认工作目录（--cwd / 当前目录）
 * @param {string} [options.agentId]
 * @param {string} [options.sessionId] - 仅用于触发器日志标注
 * @param {(trip: { at: number, thresholdTokens: number, inputTokens: number, reason: string }) => void} [options.onContextTrip]
 *   上下文过界回调（plain-agent-rotation 的接力入口）
 * @returns {string[]} 实际由底座挂载的 feature 名（去重跳过的不在内）
 */
export function mountPlainAgentBase(agent, { workspaceDir, agentId, sessionId, onContextTrip } = {}) {
  const mounted = [];
  // agent.features 是框架 Agent 的实例 Map（TS private 仅编译期）；运行时按
  // feature 名查重与 server/context-continuity/feature-continuity.js 的
  // findAgentFeature 同一访问面。
  const hasFeature = (name) => agent?.features?.has?.(name) === true;

  if (!hasFeature('opencode-basic')) {
    agent.use(new ContinuityAwareOpencodeBasic({ workspaceDir }));
    mounted.push('opencode-basic');
  }
  if (!hasFeature('output-guard')) {
    agent.use(new OutputGuardFeature({ workdir: workspaceDir }));
    mounted.push('output-guard');
  }
  if (!hasFeature('context-rotation-trigger')) {
    agent.use(new ContextRotationTriggerFeature({
      ...(agentId ? { agentId } : {}),
      ...(sessionId ? { sessionId } : {}),
      onTrip: typeof onContextTrip === 'function' ? onContextTrip : undefined,
    }));
    mounted.push('context-rotation-trigger');
  }
  return mounted;
}
