/**
 * PanelShellFeature — 继承框架 ShellFeature，内建后台任务实时面板镜像
 * （ADR-0018 feature-comms 通道的首个接入）。
 *
 * 与框架包的关系同 ControlledTodoFeature：框架生态包不感知宿主协议，
 * Claw 侧以继承增强并整体替换原版装配。本类不改任务引擎行为，只做两件事：
 * - 把 BgRegistry 六类事件投影为 shell-bg 通道事件（面板经
 *   /protoclaw/feature-comms/stream 订阅渲染）；
 * - 以 onHostRequest 面向面板提供 list / status / kill / report 请求面
 *   （Host 请求经 server → runtime IPC → 此处，见 run-prebuilt-agent.js）。
 *
 * 链路是尽力而为的镜像面：发布失败静默吞掉（bg_status 仍是任务状态真值），
 * 不影响后台任务引擎本身。
 */

import { ShellFeature } from '@agentdevjs/shell-feature';
import type { BgObserverEvent, ShellFeatureConfig } from '@agentdevjs/shell-feature';
import { FeatureCommunicationClient } from '../../shared/src/feature-communication.js';

export interface PanelShellFeatureConfig extends Omit<ShellFeatureConfig, 'bgObserver'> {
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

export class PanelShellFeature extends ShellFeature {
  private readonly client: FeatureCommunicationClient;
  private readonly channelId: string;
  private readonly channelTitle: string;
  private readonly channelDescription: string;
  private declared = false;

  constructor(config: PanelShellFeatureConfig) {
    // bgObserver 由本类自持（箭头函数延迟解引用 this，super 时尚未初始化完），
    // 不接受外部注入，因此 PanelShellFeatureConfig 用 Omit 排除该字段。
    super({
      ...config,
      bgObserver: (event) => { void this.handleBgEvent(event); },
    });
    this.channelId = config.channelId || 'shell-bg';
    this.channelTitle = config.title || '后台任务';
    this.channelDescription = config.description || 'bash_bg 后台任务实时状态镜像';
    this.client = new FeatureCommunicationClient(config.serverOrigin, {
      agentId: config.agentId,
      sessionId: config.sessionId,
      // featureId 必须等于 feature name：IPC 分发按 agent.features.get(featureId)
      // 查实例（run-prebuilt-agent.js），用 this.name 随继承自动对齐。
      featureId: this.name,
      channelId: this.channelId,
    });
    // 构造期即声明：runtime 进程内构造时 server 侧注册已完成（先 spawn 后
    // 建子进程内的 agent 实例）。失败不重试——后续首个观察事件会走
    // ensureDeclared 惰性补声明。
    this.declare().catch(() => {});
  }

  /**
   * BgRegistry 观察事件入口（经构造注入的 bgObserver 触发）。事件投影为
   * { eventType: kind, data: BgTaskSnapshot } 通道事件；引擎已对 output
   * 做 1s 节流，这里不再叠加。
   */
  handleBgEvent(event: BgObserverEvent): void {
    void this.mirrorEvent(event);
  }

  /** 面板请求面（server /request → runtime IPC → 此处）。 */
  async onHostRequest(requestType: string, payload: unknown): Promise<Record<string, unknown>> {
    const registry = this.getBgRegistry();
    const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    const taskId = String(body.taskId || '');
    switch (requestType) {
      case 'list':
        return {
          ok: true,
          tasks: registry
            ? registry.list().map((snap) => {
              // list() 返回快照（非引擎内部任务对象）；尾巴要经 get 拿回
              // 原始任务再取，直接把快照传给 tail 会炸（快照没有 chunks）。
              const task = registry.get(String(snap.id));
              return { ...snap, outputTail: task ? registry.tail(task, MIRROR_TAIL_CHARS) : '' };
            })
            : [],
        };
      case 'status': {
        if (!registry || !taskId) return { ok: false, code: 'task_not_found', error: 'taskId is required' };
        const task = registry.get(taskId);
        if (!task) return { ok: false, code: 'task_not_found', error: `No such task: ${taskId}` };
        return { ok: true, task: registry.snapshot(task), outputTail: registry.tail(task, STATUS_TAIL_CHARS) };
      }
      case 'report': {
        if (!registry || !taskId) return { ok: false, code: 'task_not_found', error: 'taskId is required' };
        // 面板手动触发器：与节拍/静默同款汇报（通知增量 + 双节奏互重置）。
        const reported = registry.reportNow(taskId);
        return reported
          ? { ok: true, reported: true }
          : { ok: false, code: 'task_not_found', error: `No such task: ${taskId}` };
      }
      case 'kill': {
        if (!registry || !taskId) return { ok: false, code: 'task_not_found', error: 'taskId is required' };
        // 面板 kill 即用户发起：manual 让引擎补发"用户手动打断"通知
        // （发起方不是模型，模型需要知情；工具路径 bg_control 不走此处）。
        const killed = registry.kill(taskId, { graceful: body.graceful === true, manual: true });
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
      const registry = this.getBgRegistry();
      const data = registry && event.task
        ? { ...registry.snapshot(event.task), outputTail: registry.tail(event.task, MIRROR_TAIL_CHARS) }
        : { id: event.task?.id, kind: event.kind };
      await this.client.publishEvent(event.kind, data);
    } catch {
      // 镜像面尽力而为：发布失败不影响任务引擎（bg_status 仍是真值）。
    }
  }
}
