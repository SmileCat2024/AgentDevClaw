/**
 * shell-bg-comms — 后台任务实时面板的 Feature 侧镜像。
 *
 * 职责（ADR-0018 feature-comms 通道的第一个真实接入）：
 * - 把 ShellFeature BgRegistry 的六类事件投影为通道事件（kind + 任务快照），
 *   面板经 /protoclaw/feature-comms/stream 订阅渲染；
 * - 以 onHostRequest 面向面板提供 list / status / kill 请求面（Host 请求
 *   经 server → runtime IPC → 本方法，见 run-prebuilt-agent.js）。
 *
 * 链路是尽力而为的镜像面：发布失败静默吞掉（bg_status 仍是任务状态真值），
 * 不影响后台任务引擎本身。
 */

import { FeatureCommunicationClient } from '../../shared/src/feature-communication.js';
import type { BgObserver, BgObserverEvent } from '@agentdevjs/shell-feature';

/** BgRegistry 的结构子集（避免值级依赖框架包，仅类型导入）。 */
interface BgRegistryLike {
  snapshot(task: unknown): Record<string, unknown>;
  list(): Array<Record<string, unknown>>;
  get(taskId: string): unknown;
  tail(task: unknown, chars: number): string;
  kill(taskId: string, opts?: { graceful?: boolean }): boolean;
}

/** ShellFeature 的结构子集（宿主装配后回填引用）。 */
export interface ShellFeatureLike {
  getBgRegistry(): BgRegistryLike | null;
}

export interface ShellBgCommsConfig {
  agentId: string;
  sessionId: string;
  serverOrigin: string;
  channelId?: string;
  title?: string;
  description?: string;
}

const STATUS_TAIL_CHARS = 4_000;
/** 事件 / list 镜像附带的输出尾巴长度：面板纯事件驱动渲染，不另发请求。 */
const MIRROR_TAIL_CHARS = 2_000;

export class ShellBgCommsFeature {
  readonly name = 'shell-bg-comms';
  readonly description = '后台任务实时面板镜像（feature-comms 通道）';

  private readonly client: FeatureCommunicationClient;
  private readonly channelId: string;
  private readonly channelTitle: string;
  private readonly channelDescription: string;
  private shell: ShellFeatureLike | null = null;
  private declared = false;

  constructor(config: ShellBgCommsConfig) {
    this.channelId = config.channelId || 'shell-bg';
    this.channelTitle = config.title || '后台任务';
    this.channelDescription = config.description || 'bash_bg 后台任务实时状态镜像';
    this.client = new FeatureCommunicationClient(config.serverOrigin, {
      agentId: config.agentId,
      sessionId: config.sessionId,
      featureId: this.name,
      channelId: this.channelId,
    });
    // 构造期即声明：runtime 进程内构造时 server 侧注册已完成（先 spawn 后
    // 建子进程内的 agent 实例）。失败不重试——后续首个观察事件会走
    // ensureDeclared 惰性补声明。
    this.declare().catch(() => {});
  }

  /** 宿主装配点：agent.js 构造 ShellFeature 后回填引用（observer 之外，
   * onHostRequest 也要经它拿 BgRegistry）。 */
  attachShell(shell: ShellFeatureLike): void {
    this.shell = shell;
  }

  /**
   * 传给 ShellFeature 构造配置的 bgObserver。事件投影为
   * { eventType: kind, data: BgTaskSnapshot } 通道事件；引擎已对 output
   * 做 1s 节流，这里不再叠加。
   */
  readonly observer: BgObserver = (event: BgObserverEvent) => {
    void this.mirrorEvent(event);
  };

  /** 面板请求面（server /request → runtime IPC → 此处）。 */
  async onHostRequest(requestType: string, payload: unknown): Promise<Record<string, unknown>> {
    const registry = this.shell?.getBgRegistry() ?? null;
    const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const taskId = String(body.taskId || '');
    switch (requestType) {
      case 'list':
        return {
          ok: true,
          tasks: registry
            ? registry.list().map((t) => ({
                ...registry.snapshot(t),
                outputTail: registry.tail(t, MIRROR_TAIL_CHARS),
              }))
            : [],
        };
      case 'status': {
        if (!registry || !taskId) return { ok: false, code: 'task_not_found', error: 'taskId is required' };
        const task = registry.get(taskId);
        if (!task) return { ok: false, code: 'task_not_found', error: `No such task: ${taskId}` };
        return { ok: true, task: registry.snapshot(task), outputTail: registry.tail(task, STATUS_TAIL_CHARS) };
      }
      case 'kill': {
        if (!registry || !taskId) return { ok: false, code: 'task_not_found', error: 'taskId is required' };
        const killed = registry.kill(taskId, { graceful: body.graceful === true });
        return killed
          ? { ok: true, killed: true }
          : { ok: false, code: 'task_not_found', error: `No such task: ${taskId}` };
      }
      default:
        return { ok: false, code: 'operation_unavailable', error: `Unknown requestType: ${requestType}` };
    }
  }

  private async declare(): Promise<void> {
    await this.client.declareChannel({ title: this.channelTitle, description: this.channelDescription });
    this.declared = true;
  }

  private async ensureDeclared(): Promise<void> {
    if (this.declared) return;
    await this.declare();
  }

  private async mirrorEvent(event: BgObserverEvent): Promise<void> {
    try {
      await this.ensureDeclared();
      const registry = this.shell?.getBgRegistry() ?? null;
      const data = registry && event.task
        ? { ...registry.snapshot(event.task), outputTail: registry.tail(event.task, MIRROR_TAIL_CHARS) }
        : { id: event.task?.id, kind: event.kind };
      await this.client.publishEvent(event.kind, data);
    } catch {
      // 镜像面尽力而为：发布失败不影响任务引擎（bg_status 仍是真值）。
    }
  }
}
