/**
 * 人为停止的线程看板收敛（C1）
 *
 * 语义（线程生命周期定案）：手动打断、手动关闭 Agent → 线程进空闲；
 * 崩溃 / 系统重启 → 保留"干到一半"事实（看板停留 running，供重启恢复
 * 判定"未完成事实"）。收敛是宿主已知事实的播种动作，走 board.setStatus
 * 播种通道（与 waiting_input 同机制），不改写事件流。
 *
 * 挂点两处（均为停止确认点：事件流已终止，无迟到事件反转窗口）：
 * 1. 共享会话 remove-session 的 session-exited IPC 确认（进程不死，
 *    agent-lifecycle.js removeSharedSession）；
 * 2. runtime 进程 exit handler（宿主先行标记 stopped=true 的人为停止；
 *    崩溃时该标志在被 handler 置位前为 false，天然区分人为/意外，
 *    agent-startup.js）。
 *
 * 收敛规则：该会话是某线程 head 且看板为 running → setStatus('idle')；
 * 看板 closed（归档/删除已 seal）、非 head、非 running、无线程一律 no-op。
 *
 * 口径：手动停止 × 已失败看板——回合先真失败、用户再手动停止时，
 * failed 不收敛（失败事实先于停止发生，红点仍需人处理；"手动停止→空闲"
 * 只覆盖 running 事实）。
 */

import { getThreadControl } from './thread-controller.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';

/**
 * 人为停止后收敛线程看板。
 *
 * @param {string} agentId 停止的 runtime 所属 agent
 * @param {string} sessionId 被停止的会话
 * @param {{ core: object, board: object }} [control] 控制面（缺省生产单例，测试注入）
 * @returns {Promise<boolean>} 是否实际执行了收敛（running → idle）
 */
export async function convergeThreadBoardOnDeliberateStop(agentId, sessionId, control = getThreadControl()) {
  if (!agentId || !sessionId) return false;
  const { core, board } = control;
  const normalized = sanitizeSessionFragment(sessionId);
  const threads = await core.listThreads({ agentId });
  const target = (threads || []).find(
    (t) => sanitizeSessionFragment(t?.headSessionId) === normalized,
  );
  if (!target) return false;
  const state = await board.getState(target.threadId);
  // 仅 running 需要收敛；idle / failed / closed（含归档删除 seal 后）不动
  if (!state || state.status !== 'running') return false;
  await board.setStatus(target.threadId, 'idle');
  return true;
}
