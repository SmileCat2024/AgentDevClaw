/**
 * runtime-spawn-tickets.js — 托管容器 runtime 的一次性注册票据（ADR-0037 M6）
 *
 * 托管 spawn 经容器后端启动时没有父子 IPC 通道，身份交接（ADR-0010 修订一：
 * 归属先于 Viewer 可见性）改经注册协议完成：宿主在启动容器前签发一次性
 * ticket（进程内随机 id，不落盘），经 env 注入容器；容器 runtime 携 ticket
 * 调用 /protoclaw/runtime/register，注册路由经本模块校验并回调容器后端的
 * onRegister —— 后者在 handle 上发出 'identity' 语义事件，宿主消费面
 * （agent-startup）与本地 IPC 握手完全同构。
 *
 * 信任边界：ticket 仅在平台进程内签发与校验、一次性消费、10 分钟过期；
 * 滥用面 = 平台进程自身，与 PROTOCLAW_INTERNAL_TOKEN 同信任域。
 */
import { randomUUID } from 'crypto';

const TICKET_TTL_MS = 10 * 60 * 1000;

// ticket id → { agentId, sessionId, onRegister, issuedAt }
const pendingTickets = new Map();

function pruneExpiredTickets(now = Date.now()) {
  for (const [id, entry] of pendingTickets) {
    if (now - entry.issuedAt > TICKET_TTL_MS) pendingTickets.delete(id);
  }
}

/**
 * 签发托管 spawn ticket。onRegister(viewerAgentId) 在校验通过的消费侧同步
 * 调用，其返回值（可为 promise）透传给注册路由作为交接结果。
 */
export function issueManagedSpawnTicket({ agentId, sessionId, onRegister }) {
  if (typeof onRegister !== 'function') {
    throw new Error('issueManagedSpawnTicket requires an onRegister callback');
  }
  pruneExpiredTickets();
  const ticket = randomUUID();
  pendingTickets.set(ticket, {
    agentId: String(agentId || ''),
    sessionId: String(sessionId || ''),
    onRegister,
    issuedAt: Date.now(),
  });
  return ticket;
}

/**
 * 一次性消费：校验 ticket 存在、未过期、agentId / sessionId 与注册载荷吻合。
 * 通过则先移除（保证一次性，即使 onRegister 抛错也不可重放）再回调；
 * 不通过返回 null，由调用方决定拒绝语义。
 */
export async function consumeManagedSpawnTicket({ ticket, agentId, sessionId, viewerAgentId }) {
  if (!ticket) return null;
  const entry = pendingTickets.get(ticket);
  if (!entry) return null;
  if (Date.now() - entry.issuedAt > TICKET_TTL_MS) {
    pendingTickets.delete(ticket);
    return null;
  }
  if (entry.agentId !== String(agentId || '') || entry.sessionId !== String(sessionId || '')) {
    return null;
  }
  pendingTickets.delete(ticket);
  const result = await entry.onRegister(viewerAgentId);
  return { ok: true, result };
}

/** 测试 / 诊断用：当前 pending ticket 数。 */
export function countPendingSpawnTickets() {
  return pendingTickets.size;
}
