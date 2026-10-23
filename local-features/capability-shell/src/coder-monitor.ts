/** Coder execution observation. Business execution stays in WorkThread; only observation lives here. */
import { BackgroundAccess } from '@agentdevjs/core';
import type { BackgroundWorkHandle } from '@agentdevjs/core';
import type { AgentBackgroundTask } from '../../shared/src/background-panel.js';

export interface CoderObservation {
  threadId: string;
  commandId: string;
}

export interface CoderSnapshot {
  thread: Record<string, any>;
  events: Array<Record<string, any>>;
  cursor: number;
  baseOffset: number;
}

type NodeState = 'pending' | 'executing' | 'suspended' | 'completed' | 'cancelled' | 'rotating';
interface ExecutionNode { state: NodeState; sessionId?: string }
interface Reply { sessionId: string; turn: number; text: string }
interface WaitingWork { source: string; id: string; owner: string }
interface Observation {
  identity: CoderObservation;
  handle: BackgroundWorkHandle;
  nodes: Map<string, ExecutionNode>;
  waits: Map<string, WaitingWork>;
  cursor: number;
  initialized: boolean;
  errors: number;
  result?: string;
  replies: Map<string, Reply>;
  terminal?: string;
  message?: string;
  projection: AgentBackgroundTask;
}

export interface CoderMonitorOptions {
  access: BackgroundAccess;
  read: (threadId: string, after: number, signal: AbortSignal) => Promise<CoderSnapshot>;
  intervalMs?: number;
  onUpdate?: (task: AgentBackgroundTask) => void | Promise<void>;
}

export function observationKey(identity: CoderObservation): string {
  return `${identity.threadId}/${identity.commandId}`;
}

/** No model polling, no execution cancellation, no restored connections. */
export class CoderMonitor {
  private readonly observations = new Map<string, Observation>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: CoderMonitorOptions) {}

  list(): AgentBackgroundTask[] {
    return [...this.observations.values()].map((target) => ({ ...target.projection }));
  }

  private project(target: Observation, patch: Partial<AgentBackgroundTask>): void {
    if (Object.keys(patch).length && Object.entries(patch).every(([key, value]) => target.projection[key] === value)) return;
    target.projection = { ...target.projection, ...patch, revision: target.projection.revision + 1, updatedAt: Date.now() };
    try {
      void Promise.resolve(this.options.onUpdate?.({ ...target.projection })).catch(() => {});
    } catch { /* optional projection never participates in observation or notification */ }
  }

  identities(): CoderObservation[] {
    return [...this.observations.values()]
      .filter((target) => !target.terminal || this.options.access.hasUndelivered(target.handle.id))
      .map((target) => ({ ...target.identity }));
  }

  async observe(identity: CoderObservation): Promise<string> {
    if (this.disposed) throw new Error('Coder monitor is disposed');
    if (!identity.threadId || !identity.commandId) throw new Error('监视要求真实 threadId 与 commandId');
    const key = observationKey(identity);
    let target = this.observations.get(key);
    if (target && ['monitor_unreachable', 'runtime_unavailable', 'rotation_failed', 'association_lost'].includes(target.terminal)
      && !this.options.access.hasUndelivered(key)) {
      target.handle = this.options.access.registerWork({ id: key, summary: `Coder ${key}` });
      target.nodes = new Map([[identity.commandId, { state: 'pending' }]]);
      target.waits.clear();
      target.replies.clear();
      target.cursor = 0;
      target.initialized = false;
      target.errors = 0;
      target.result = undefined;
      target.terminal = undefined;
      target.message = undefined;
      this.project(target, { status: 'submitted', summary: '已重新建立观察，等待关联执行事件', endedAt: undefined });
    }
    if (!target) {
      target = {
        identity: { ...identity },
        projection: { id: key, revision: 0, title: `Coder ${identity.threadId}`, agentId: 'coder', ...identity,
          status: 'submitted', summary: '已提交，等待关联执行事件', startedAt: Date.now(), updatedAt: Date.now() },
        handle: this.options.access.registerWork({ id: key, summary: `Coder ${key}` }),
        nodes: new Map([[identity.commandId, { state: 'pending' }]]),
        waits: new Map(), replies: new Map(), cursor: 0, initialized: false, errors: 0,
      };
      this.observations.set(key, target);
      this.project(target, {});
    }
    await this.refresh(target);
    if (this.disposed) return `monitor_disposed threadId=${identity.threadId} commandId=${identity.commandId}`;
    this.schedule();
    const catchUp = this.options.access.consumeUndelivered(key);
    return [this.describe(target), ...catchUp].join('\n');
  }

  isObserving(identity: CoderObservation): boolean {
    const target = this.observations.get(observationKey(identity));
    return !!target && !target.terminal;
  }

  private describe(target: Observation): string {
    return `${target.terminal ? 'observed' : 'monitoring'} threadId=${target.identity.threadId} commandId=${target.identity.commandId}`
      + (target.terminal ? ` reason=${target.terminal}\n${target.message}` : '；重要事件将自动通知，可继续工作。');
  }

  private schedule(): void {
    if (this.disposed || this.timer || ![...this.observations.values()].some((t) => !t.terminal)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, this.options.intervalMs ?? 2_000);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    await Promise.all([...this.observations.values()].filter((t) => !t.terminal).map((t) => this.refresh(t)));
    this.schedule();
  }

  private refresh(target: Observation): Promise<void> {
    if (target.terminal || this.disposed) return Promise.resolve();
    const key = observationKey(target.identity);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const pending = this.inspect(target).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async inspect(target: Observation): Promise<void> {
    let snapshot: CoderSnapshot;
    try {
      snapshot = await this.options.read(target.identity.threadId, target.cursor, this.controller.signal);
      if (this.disposed) return;
      target.errors = 0;
    } catch (error: any) {
      if (this.disposed) return;
      if (error?.status === 404) this.finish(target, 'thread_deleted', '线程已删除，监视结束。');
      else if (++target.errors >= 3 || !target.initialized) this.finish(target, 'monitor_unreachable', `监视读取失败：${error?.message || error}。提交未回滚，请恢复连接后重新 watch，不要重发任务。`);
      return;
    }
    const { thread, events, cursor, baseOffset } = snapshot;
    if (target.initialized && cursor < target.cursor) {
      this.finish(target, 'association_lost', '执行事件游标已回退，原事件流不再完整，无法证明本次执行结果。请主动取证。');
      return;
    }
    if (baseOffset > target.cursor && target.initialized) {
      this.finish(target, 'association_lost', '执行事件已被裁剪，监视无法证明本次执行结果。请主动取证。');
      return;
    }
    const commands: Array<Record<string, any>> = thread.commands || [];
    const original = commands.find((c) => c.commandId === target.identity.commandId);
    if (!original) {
      this.finish(target, 'association_lost', '指令不在保留窗口内，无法可靠建立监视；未重新派发。');
      return;
    }
    if (['archived', 'closed'].includes(thread.lifeState) || thread.status === 'closed') {
      this.finish(target, `thread_${thread.lifeState === 'archived' ? 'archived' : 'closed'}`, '线程已收纳或关闭；这不代表本次任务成功完成。');
      return;
    }
    if (thread.status === 'rotation_failed') {
      this.finish(target, 'rotation_failed', '会话接力失败，需要人工介入；不要重发施工指令。');
      return;
    }

    // Replay retained events in order. Expanding edges before each event also covers a
    // suspended round and its wakeup completing within the same polling interval.
    for (const event of events) {
      this.expand(target, thread, commands, event.sessionId);
      const eventRefs = [...new Set([event.sourceRef, ...(event.consumedSourceRefs || [])].filter(Boolean))];
      for (const ref of eventRefs) {
        if (target.nodes.has(ref)) continue;
        const command = commands.find((c) => c.commandId === ref);
        const wait = [...target.waits.values()].find((w) => this.wakes(command, w)
          && target.nodes.get(w.owner)?.sessionId === event.sessionId);
        if (wait) target.nodes.set(ref, { state: 'pending', sessionId: event.sessionId });
      }
      const refs = eventRefs.filter((ref) => target.nodes.has(ref));
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        target.replies.set(JSON.stringify([event.sessionId, event.item.turn]), { sessionId: event.sessionId, turn: event.item.turn, text: String(event.item.text || '') });
        continue;
      }
      for (const ref of refs) {
        const node = target.nodes.get(ref)!;
        if (event.sessionId) node.sessionId = event.sessionId;
        if (event.type === 'turn.started') node.state = 'executing';
        if (event.type === 'turn.failed') {
          this.finish(target, 'execution_failed', `执行失败：${event.error?.message || event.error?.reason || '原因未提供'}`);
          return;
        }
        if (event.type === 'turn.cancelled') node.state = 'cancelled';
        if (event.type !== 'turn.completed') continue;
        node.state = event.suspended === true ? 'suspended' : 'completed';
        // A progress wakeup can finish while the same work is still pending. Replace
        // only this node's waiting facts, then retain the new authoritative snapshot.
        for (const [key, wait] of target.waits) {
          if (wait.owner === ref || this.wakes(commands.find((c) => c.commandId === ref), wait)) target.waits.delete(key);
        }
        for (const work of event.pendingWakeups || []) {
          if (typeof work.source === 'string' && typeof work.id === 'string') {
            target.waits.set(`${work.source}/${work.id}`, { source: work.source, id: work.id, owner: ref });
          }
        }
        if (node.state === 'suspended' && !target.waits.size) {
          this.finish(target, 'association_lost', '挂起事件缺少待唤醒工作引用，无法关联后续执行。');
          return;
        }
        const reply = target.replies.get(JSON.stringify([event.sessionId, event.turn]));
        target.result = reply?.turn === event.turn ? reply.text : undefined;
      }
    }
    this.expand(target, thread, commands);
    target.cursor = cursor;
    target.initialized = true;
    if ([...target.nodes.values()].every((n) => n.state === 'completed' || n.state === 'suspended')
      && target.waits.size === 0 && [...target.nodes.values()].some((n) => n.state === 'completed')) {
      this.finish(target, 'completed', target.result
        ? `本次执行已完成。\n${target.result.slice(0, 4_000)}\n完整报告：result ${target.identity.threadId}`
        : `本次执行已完成，但缺少可关联的最终回复。请 result ${target.identity.threadId} 补取证据。`);
      return;
    }
    const status = thread.status === 'rotating' || thread.pendingSuccession ? 'rotating'
      : [...target.nodes.values()].some((node) => node.state === 'executing') ? 'executing'
        : target.waits.size > 0 ? 'suspended' : 'submitted';
    this.project(target, { status, title: thread.headSessionTitle || target.projection.title,
      sessionId: thread.headSessionId,
      summary: status === 'rotating' ? '会话接力中' : status === 'suspended' ? '等待关联后台工作唤醒'
        : status === 'executing' ? '本次关联执行进行中' : '等待关联执行事件' });
    if (thread.status === 'rotating' || thread.pendingSuccession) return;
    for (const [ref, node] of target.nodes) {
      const command = commands.find((c) => c.commandId === ref);
      if (command?.status === 'failed' || command?.status === 'cancelled') {
        this.finish(target, `command_${command.status}`, `指令未完成投递：${command.lastReason || command.status}`);
        return;
      }
      if (node.state === 'cancelled') {
        this.finish(target, 'execution_cancelled', '本次执行被中断，未声明完成。');
        return;
      }
    }
    if (thread.headRuntimeRunning === false) {
      this.finish(target, 'runtime_unavailable', 'head runtime 进程已不在，无法继续接收执行结果；请检查线程并重新 watch。');
      return;
    }
    if (baseOffset > 0 && ![...target.nodes.values()].some((n) => n.sessionId) && original.status === 'delivered') {
      this.finish(target, 'association_lost', '当前保留事件中没有本次指令身份；无法判断是否已完成。');
    }
  }

  private wakes(command: Record<string, any> | undefined, wait: WaitingWork): boolean {
    if (!command || command.kind !== 'reminder') return false;
    const metadata = command.metadata?.[wait.source];
    const ids = metadata?.taskIds ?? metadata?.workIds;
    return command.source === wait.source && Array.isArray(ids) && ids.includes(wait.id);
  }

  private expand(target: Observation, thread: Record<string, any>, commands: Array<Record<string, any>>, eventSessionId?: string): void {
    for (const node of target.nodes.values()) {
      if (!['executing', 'cancelled', 'suspended'].includes(node.state) || !node.sessionId) continue;
      const index = (thread.sessionChain || []).findIndex((s: any) => s.sessionId === node.sessionId);
      if (index < 0 || !thread.sessionChain[index + 1]) continue;
      // A retiring runtime may omit its terminal event. Cross that boundary only
      // when replay reaches the committed successor, not while replaying old work.
      if (node.state === 'executing' && eventSessionId !== thread.sessionChain[index + 1].sessionId) continue;
      const successor = commands.find((c) => c.kind === 'system_continuation'
        && c.idempotencyKey === `succession:${thread.threadId}:${node.sessionId}`);
      if (!successor) continue;
      node.state = 'rotating';
      target.nodes.set(successor.commandId, target.nodes.get(successor.commandId) || { state: 'pending' });
      // The continuation assumes all unfinished work of the old session. Pending
      // wakeups there are not promised to survive the session process.
      for (const [key, wait] of target.waits) if (target.nodes.get(wait.owner) === node) target.waits.delete(key);
      node.state = 'completed';
    }
  }

  private finish(target: Observation, reason: string, message: string): void {
    if (target.terminal || this.disposed) return;
    target.terminal = reason;
    target.message = message;
    const status = reason === 'completed' ? 'completed'
      : ['monitor_unreachable', 'runtime_unavailable', 'association_lost', 'thread_deleted'].includes(reason) ? 'monitor_lost'
        : reason === 'execution_failed' || reason === 'command_failed' ? 'failed'
          : reason.includes('cancelled') ? 'cancelled' : 'blocked';
    this.project(target, { status, summary: message, endedAt: Date.now() });
    this.options.access.submitNotice({ workId: target.handle.id, terminal: true,
      text: `[Coder 监视 ${reason}] threadId=${target.identity.threadId} commandId=${target.identity.commandId}\n${message}` });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort();
    await Promise.all(this.inFlight.values());
    for (const target of this.observations.values()) target.handle.release();
  }
}
