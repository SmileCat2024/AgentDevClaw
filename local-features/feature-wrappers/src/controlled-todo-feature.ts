/**
 * ControlledTodoFeature — 继承框架 TodoFeature，增加会话中断控制能力：
 *
 * 1. "完成后停止"断点（interruptTarget）：目标任务进入终态时 Decision.Deny 结束 call。
 * 2. "任务未完强制继续"（forceContinue）：开关开启时，call 自然结束但任务未完，
 *    注入提醒消息并 Decision.Approve 继续循环。
 *
 * 优先级：断点 Deny 先于强制继续 Approve 判定，两者不冲突——
 * 即便强制继续开启，断点触发时仍会停下。
 *
 * 设计原理（static hooks 静态声明契约）：
 * - TodoFeature 通过 static hooks 声明钩子（含 recordToolUsage → StepFinish guard/advisor）。
 *   本类不声明自己的 static hooks，声明经原型链继承；
 *   hooks registry 按声明中的方法名调用 instance 方法，
 *   因此 override recordToolUsage 即可在 StepFinish 决策点注入自定义逻辑。
 * - 注意：一旦子类声明自己的 static hooks，将完全 shadow 父类声明（非增量合并），
 *   需声明全部钩子。本类刻意不声明。
 * - interruptTargetId 由前端通过 IPC 设置，下一次 StepFinish 检查到目标 task
 *   进入终态（completed/deleted）时返回 Decision.Deny，优雅结束当前 call。
 *
 * 同时通过 declareContinuity 包装向 Claw continuity 协议自声明参与，
 * 让 trim/summary 后任务列表能完整转移到新 runtime。
 */

import { TodoFeature, Decision } from 'agentdev';
import {
  declareContinuity,
} from '../../continuity-participant/src/index.js';

const TODO_CONTINUITY_PROTOCOL = 'claw.todo-continuity.v1';

/** 单次 call 内连续"强制继续"的次数上限：模型反复不带工具地收尾时，避免无界续跑 */
const FORCE_CONTINUE_MAX_CONSECUTIVE = 3;

class ControlledTodoFeatureInner extends TodoFeature {
  /** 当前中断目标 task ID（null = 无中断目标） */
  _interruptTargetId: string | null = null;

  /** 任务未完强制继续开关（默认关闭，由前端经 IPC 设置） */
  _forceContinueEnabled = false;
  /** 连续强制继续计数（模型带工具推进时清零） */
  _forceContinueCount = 0;

  /**
   * 设置中断目标。taskId 为 null 或空字符串时取消中断。
   * 由 IPC 消息调用。
   */
  setInterruptTarget(taskId: string | null) {
    this._interruptTargetId = taskId || null;
    console.log(`[ControlledTodoFeature] Interrupt target set to: ${this._interruptTargetId || '(none)'}`);
    this.pushDebugSnapshot();
  }

  getInterruptTarget(): string | null {
    return this._interruptTargetId;
  }

  /**
   * 设置"任务未完强制继续"开关。开启后，当 call 自然结束（无工具调用）
   * 但任务列表仍有 pending/in_progress 任务时，注入提醒消息并强制继续。
   */
  setForceContinue(enabled: boolean) {
    this._forceContinueEnabled = enabled === true;
    this._forceContinueCount = 0;
    console.log(`[ControlledTodoFeature] Force continue ${this._forceContinueEnabled ? 'enabled' : 'disabled'}`);
    this.pushDebugSnapshot();
  }

  getForceContinue(): boolean {
    return this._forceContinueEnabled;
  }

  /**
   * 为 Task 终态记录稳定时间。TodoFeature 原有 updatedAt 会随任何后续编辑变化，
   * finishedAt / completedAt / cancelledAt 专门表达本次进入终态的时刻。
   */
  updateTask(taskId: string, updates: Record<string, any> | undefined) {
    const current = this.getTask(taskId);
    if (!current) return undefined;
    const nextStatus = updates?.status || current.status;
    const terminal = nextStatus === 'completed' || nextStatus === 'deleted';
    const wasTerminal = current.status === 'completed' || current.status === 'deleted';
    const metadata = { ...(current.metadata || {}), ...(updates?.metadata || {}) };

    if (terminal) {
      if (!wasTerminal || !metadata.finishedAt) metadata.finishedAt = Date.now();
      metadata.completionStatus = nextStatus;
      if (nextStatus === 'completed' && !metadata.completedAt) metadata.completedAt = metadata.finishedAt;
      if (nextStatus === 'deleted' && !metadata.cancelledAt) metadata.cancelledAt = metadata.finishedAt;
    } else if (wasTerminal) {
      delete metadata.finishedAt;
      delete metadata.completedAt;
      delete metadata.cancelledAt;
      delete metadata.completionStatus;
    }

    return super.updateTask(taskId, { ...updates, metadata });
  }

  /** task_clear 也通过 updateTask 进入终态，保证取消时间被记录。返回进入终态的任务数。 */
  clearTasks(): number {
    let cleared = 0;
    for (const task of this.listTasks()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        this.updateTask(task.id, { status: 'deleted' });
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Override recordToolUsage（经继承的 static hooks 声明挂载于 StepFinish guard）。
   *
   * 先执行父类逻辑（todo 工具使用统计 + reminder 计数），
   * 然后按优先级决策：
   * 1. 中断目标（断点）已进入终态 → Decision.Deny 优雅结束当前 call（优先级最高）
   * 2. 强制继续开启 && call 自然结束（无工具调用）&& 仍有未完成任务
   *    → 注入提醒消息并 Decision.Approve 继续循环
   * 断点 Deny 在前，保证两者不冲突：即便强制继续开启，断点触发时仍会停下。
   */
  async recordToolUsage(ctx: any) {
    const parentResult = await super.recordToolUsage(ctx);

    if (this._interruptTargetId) {
      const task = this.getTask(this._interruptTargetId);
      if (task && (task.status === 'completed' || task.status === 'deleted')) {
        console.log(`[ControlledTodoFeature] Interrupt target task ${this._interruptTargetId} reached terminal state (${task.status}), stopping call`);
        this._interruptTargetId = null;
        return Decision.Deny;
      }
    }

    // 模型带工具推进：重置连续计数，走默认行为
    if (ctx.toolCallsCount > 0) {
      this._forceContinueCount = 0;
      return parentResult;
    }

    // 自然结束（无工具调用）时的强制继续判定
    if (this._forceContinueEnabled) {
      const activeTasks = this.listTasks().filter(
        (task) => task.status === 'pending' || task.status === 'in_progress',
      );
      if (activeTasks.length > 0) {
        if (this._forceContinueCount >= FORCE_CONTINUE_MAX_CONSECUTIVE) {
          console.warn(`[ControlledTodoFeature] Force continue limit reached (${this._forceContinueCount}), letting call end`);
          return parentResult;
        }
        this._forceContinueCount += 1;
        ctx.context.add({ role: 'system', content: this.buildForceContinueMessage(activeTasks) });
        console.log(`[ControlledTodoFeature] Force continue: ${activeTasks.length} active task(s) remain, injected reminder (${this._forceContinueCount}/${FORCE_CONTINUE_MAX_CONSECUTIVE})`);
        this.pushDebugSnapshot();
        return Decision.Approve;
      }
    }

    return parentResult;
  }

  /**
   * Override onCallStart：新一轮用户交互重置强制继续计数，
   * 保证每次 call 都有完整的连续继续预算。父类逻辑（任务状态注入）照常执行。
   */
  async onCallStart(ctx: any) {
    await super.onCallStart(ctx);
    this._forceContinueCount = 0;
  }

  /**
   * 构建强制继续注入消息（复用 listTasks 摘要，不含长描述，控制注入体积）。
   */
  private buildForceContinueMessage(activeTasks: { id: string; subject: string; status: string }[]): string {
    const lines: string[] = ['[任务未完成提醒]', '任务列表中仍有未完成的任务，请继续推进：'];
    for (const task of activeTasks.slice(0, 20)) {
      lines.push(`- #${task.id} [${task.status}] ${task.subject}`);
    }
    if (activeTasks.length > 20) {
      lines.push(`（其余 ${activeTasks.length - 20} 项未展示，可用 task_list 查看）`);
    }
    lines.push('');
    lines.push('从中断处继续执行当前任务；任务开始、完成、调整或取消时，使用 Todo 工具同步状态。');
    lines.push('若某任务确实无法继续或已不适用，请先明确说明原因，再将其标记完成/取消或调整计划。');
    lines.push('不要向用户提及此内部提示。');
    return lines.join('\n');
  }

  /**
   * Override getPlanSnapshot，附加 interruptTargetId / forceContinue 字段供前端消费。
   */
  getPlanSnapshot() {
    const snapshot = super.getPlanSnapshot();
    return {
      ...snapshot,
      interruptTargetId: this._interruptTargetId,
      forceContinue: {
        enabled: this._forceContinueEnabled,
        consecutive: this._forceContinueCount,
        max: FORCE_CONTINUE_MAX_CONSECUTIVE,
      },
    };
  }

  /**
   * Override captureState，持久化中断目标与强制继续开关。
   */
  captureState() {
    // 框架 FeatureStateSnapshot 定义为 unknown（协议层透传），此处包装需展开为对象
    const state = super.captureState() as Record<string, unknown>;
    return {
      ...state,
      interruptTargetId: this._interruptTargetId,
      forceContinue: { enabled: this._forceContinueEnabled, consecutive: this._forceContinueCount },
    };
  }

  /**
   * Override restoreState，恢复中断目标与强制继续开关。
   */
  restoreState(snapshot: any) {
    super.restoreState(snapshot);
    this._interruptTargetId = snapshot?.interruptTargetId || null;
    // 如果目标 task 已终态或不存在，清除中断目标（防止僵尸断点在精简/压缩后意外触发）
    if (this._interruptTargetId) {
      const task = this.getTask(this._interruptTargetId);
      if (!task || task.status === 'completed' || task.status === 'deleted') {
        console.log(`[ControlledTodoFeature] Clearing stale interrupt target ${this._interruptTargetId} on restore (task ${task ? task.status : 'missing'})`);
        this._interruptTargetId = null;
      }
    }
    const forceContinue = snapshot?.forceContinue;
    this._forceContinueEnabled = forceContinue?.enabled === true;
    this._forceContinueCount = typeof forceContinue?.consecutive === 'number'
      ? Math.max(0, Math.min(FORCE_CONTINUE_MAX_CONSECUTIVE, Math.floor(forceContinue.consecutive)))
      : 0;
  }
}

/**
 * 通过 declareContinuity 包装：在 inner 类基础上叠加 Claw continuity 自声明。
 *
 * 包装链（captureState）：
 *   declareContinuity 子类 → super.captureState()
 *     → ControlledTodoFeatureInner.captureState() → super.captureState()
 *       → TodoFeature 原生 captureState()
 *     → 加 interruptTargetId
 *   → 加 __agentdev_continuity__ descriptor
 *
 * 包装链（restoreState）：
 *   declareContinuity 子类 → 剥离 __agentdev_continuity__ → super.restoreState()
 *     → ControlledTodoFeatureInner.restoreState() → super.restoreState() + 恢复 interruptTargetId
 */
export const ControlledTodoFeature = declareContinuity(ControlledTodoFeatureInner, {
  protocol: TODO_CONTINUITY_PROTOCOL,
  importMode: 'replace',
});
