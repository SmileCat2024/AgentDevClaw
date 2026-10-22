/**
 * CapabilityShellFeature — coder 领域 shell 与后台观察挂载（ADR-0031）
 *
 * 在 033 基座（管线四道检查点 + 工具工厂）上装配第一个领域 shell：
 * ProgrammingHelperAgent（main 身份）构造函数挂载，提供 `coder_shell`
 * 工具。CoderAgent 不挂（不自派工单，避免递归调度）。
 *
 * serverOrigin 解析参照 local-features/dispatch 的 runtimeIdentity 模式：
 * 显式配置 → PROTOCLAW_SERVER_ORIGIN → http://127.0.0.1:1420。
 */

import { fileURLToPath } from 'url';
import { BackgroundAccess, CoreLifecycle, Decision } from '@agentdevjs/core';
import type { AgentFeature, FeatureInitContext, CallStartContext, HookDeclarations, WakeupDeliver } from '@agentdevjs/core';
import { declareContinuity, GENERIC_CONTINUITY_PROTOCOL } from '../../continuity-participant/src/index.js';
import { internalAuthHeaders } from '../../shared/src/internal-auth.js';
import { FeatureCommunicationClient } from '../../shared/src/feature-communication.js';
import { AGENT_BACKGROUND_PRESENTATION } from '../../shared/src/background-panel.js';
import type { AgentBackgroundTask } from '../../shared/src/background-panel.js';
import { CoderMonitor } from './coder-monitor.js';
import type { CoderObservation, CoderSnapshot } from './coder-monitor.js';
import type { FetchLike } from './coder-shell.js';
import { createCapabilityShellTool } from './tool-factory.js';
import { createThreadsAdapters } from './coder-shell.js';
import { createCoderShellPolicy } from './coder-policy.js';

const __filename = fileURLToPath(import.meta.url);

export interface CapabilityShellFeatureConfig {
  /** 调度控制面 origin（缺省 runtime env → http://127.0.0.1:1420） */
  serverOrigin?: string;
  /** 覆盖工具默认超时（毫秒；超时唯一闸门 = Tool.timeout 契约） */
  timeoutMs?: number;
  /** 覆盖超时上限（缺省 600000） */
  maxTimeoutMs?: number;
  agentId?: string;
  sessionId?: string;
  fetchImpl?: FetchLike;
  deliver?: WakeupDeliver;
  pollIntervalMs?: number;
  /** Optional Claw projection; observation and wakeup work without it. */
  panel?: boolean;
}

class CapabilityShellFeatureInner implements AgentFeature {
  static hooks: HookDeclarations = {
    registerBackground: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
    standby: { lifecycle: CoreLifecycle.StepFinish, kind: 'guard' as const, role: 'advisor' as const },
  };
  readonly name = 'claw-coder-dispatch';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Claw coder 智能体调度：经受控命令管线创建 WorkThread、派发工单、监视落定与收口（coder_shell 工具）';

  private readonly serverOrigin: string;
  private readonly options: { timeoutMs?: number; maxTimeoutMs?: number };

  private access?: BackgroundAccess;
  private monitor?: CoderMonitor;
  private restored: CoderObservation[] = [];
  private viewerId?: string;
  private panelClient?: FeatureCommunicationClient;
  private panelDeclared = false;
  private destroyed = false;
  private panelQueue = Promise.resolve();
  private readonly lostProjections = new Map<string, AgentBackgroundTask>();

  private publishPanel(task?: AgentBackgroundTask): void {
    if (!this.panelClient || this.destroyed) return;
    this.panelQueue = this.panelQueue.then(async () => {
      if (this.destroyed) return;
      if (!this.panelDeclared) {
        await this.panelClient!.declareChannel({ title: 'Coder 执行', presentation: AGENT_BACKGROUND_PRESENTATION });
        this.panelDeclared = true;
      }
      if (task && !this.destroyed) await this.panelClient!.publishEvent('updated', task);
    }).catch(() => {});
  }

  async onHostRequest(requestType: string): Promise<Record<string, unknown>> {
    if (!this.config.panel || requestType !== 'list') return { ok: false, code: 'operation_unavailable' };
    const tasks = new Map(this.lostProjections);
    for (const task of this.monitor?.list() || []) tasks.set(task.id, task);
    return { ok: true, tasks: [...tasks.values()] };
  }

  constructor(private readonly config: CapabilityShellFeatureConfig = {}) {
    this.serverOrigin = config.serverOrigin
      || process.env.PROTOCLAW_SERVER_ORIGIN
      || 'http://127.0.0.1:1420';
    if (config.panel) {
      if (!config.agentId || !config.sessionId) throw new Error('面板投影要求显式 agentId/sessionId');
      this.panelClient = new FeatureCommunicationClient(this.serverOrigin, {
        agentId: config.agentId, sessionId: config.sessionId, featureId: this.name, channelId: 'coder-executions',
      });
      this.publishPanel();
    }
    this.options = {
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxTimeoutMs !== undefined ? { maxTimeoutMs: config.maxTimeoutMs } : {}),
    };
  }

  private async request(path: string, init: RequestInit = {}, origin = this.serverOrigin): Promise<any> {
    const fetcher = this.config.fetchImpl ?? fetch;
    const response = await fetcher(`${origin.replace(/\/+$/, '')}${path}`, {
      ...init, headers: internalAuthHeaders({ 'Content-Type': 'application/json' }),
      signal: init.signal ?? AbortSignal.timeout(5_000),
    });
    const payload = await response.json() as any;
    if (!response.ok || !payload || payload.ok === false || payload.success === false) {
      throw Object.assign(new Error(payload?.message || payload?.error || `HTTP ${response.status}`), { status: response.status });
    }
    return payload;
  }

  async getAsyncTools(ctx: FeatureInitContext) {
    this.viewerId = ctx.agentId;
    if (!this.access) {
      const sessionId = this.config.sessionId ?? process.env.PROTOCLAW_PREBUILT_SESSION_ID;
      this.access = new BackgroundAccess({
        source: this.name, sessionId,
        deliver: this.config.deliver ?? (async (event) => {
          if (!event.sessionId || !this.viewerId) throw new Error('Coder 通知缺少显式收件会话');
          await this.request(`/api/agents/${encodeURIComponent(this.viewerId)}/user-turn`, {
            method: 'POST', body: JSON.stringify({
              text: event.text, source: this.name, sourceRef: event.eventId, kind: 'reminder',
              sessionId: event.sessionId, metadata: { [this.name]: { workIds: event.workIds } },
            }),
          }, `http://127.0.0.1:${process.env.AGENTDEV_VIEWER_PORT || '2026'}`);
        }),
      });
      this.monitor = new CoderMonitor({
        access: this.access, intervalMs: this.config.pollIntervalMs,
        onUpdate: (task) => { this.lostProjections.delete(task.id); this.publishPanel(task); },
        read: async (threadId, after, signal): Promise<CoderSnapshot> => {
          const path = `/protoclaw/threads/${encodeURIComponent(threadId)}`;
          const bounded = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
          // Commands are read after events so a newly observed wakeup cannot precede
          // its Inbox identity in this snapshot.
          const stream = await this.request(`${path}/events?after=${after}`, { signal: bounded });
          const detail = await this.request(path, { signal: bounded });
          if (!detail.thread || !Array.isArray(stream.events) || !Number.isInteger(stream.cursor)
            || !Number.isInteger(stream.baseOffset)) throw new Error('监视响应缺少执行关联契约，请更新 server');
          return { thread: detail.thread, events: stream.events, cursor: stream.cursor, baseOffset: stream.baseOffset };
        },
      });
    }
    const adapters = createThreadsAdapters({ serverOrigin: this.serverOrigin,
      fetchImpl: this.config.fetchImpl, monitor: this.monitor, access: this.access });
    return [
      createCapabilityShellTool(
        createCoderShellPolicy(),
        adapters,
        // 只等待控制面提交与快照，不在工具中等 Coder 执行。
        {
          timeoutMs: this.options.timeoutMs ?? 120_000,
          maxTimeoutMs: this.options.maxTimeoutMs ?? 600_000,
        },
      ),
    ];
  }

  registerBackground(ctx: CallStartContext): void {
    this.access?.consumeStandbyRequest();
    if (this.access) this.access.attachAgent(ctx.agent);
    if (this.restored.length) {
      ctx.context.addSystemMessage(
        '[Coder 监视未恢复] 此前监视资源已失效；请先查询并重新 watch，勿重发原任务。\n'
        + this.restored.map((i) => `watch ${i.threadId} --command=${i.commandId}`).join('\n'),
        ctx.agent?._callIndex ?? 0, this.name, 'reminder',
      );
      this.restored = [];
    }
  }

  async standby() {
    return this.access?.consumeStandbyRequest() ? Decision.Deny : Decision.Continue;
  }

  captureState() {
    return { observations: [...this.restored, ...(this.monitor?.identities() || [])] };
  }

  restoreState(snapshot: any): void {
    this.restored = Array.isArray(snapshot?.observations)
      ? snapshot.observations.filter((i: any) => typeof i?.threadId === 'string' && typeof i?.commandId === 'string')
        .map((i: CoderObservation) => ({ threadId: i.threadId, commandId: i.commandId })) : [];
    this.lostProjections.clear();
    for (const identity of this.restored) {
      const task: AgentBackgroundTask = { id: `${identity.threadId}/${identity.commandId}`, revision: 1, ...identity,
        agentId: 'coder', title: `Coder ${identity.threadId}`, status: 'monitor_lost',
        summary: '此前监视未恢复；请查询并重新 watch，勿重发原任务', startedAt: 0, updatedAt: Date.now() };
      this.lostProjections.set(task.id, task);
      this.publishPanel(task);
    }
  }

  async onDestroy(): Promise<void> {
    this.destroyed = true;
    await this.monitor?.dispose();
    this.access?.dispose();
  }
}

export const CapabilityShellFeature = declareContinuity(CapabilityShellFeatureInner, {
  protocol: GENERIC_CONTINUITY_PROTOCOL, importMode: 'replace',
});
