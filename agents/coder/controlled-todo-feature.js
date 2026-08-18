/**
 * ControlledTodoFeature — 继承框架 TodoFeature，增加"完成后停止"中断控制能力。
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
} from '../../local-features/dist/continuity-participant/src/index.js';

const TODO_CONTINUITY_PROTOCOL = 'claw.todo-continuity.v1';

class ControlledTodoFeatureInner extends TodoFeature {
  /** 当前中断目标 task ID（null = 无中断目标） */
  _interruptTargetId = null;

  /**
   * 设置中断目标。taskId 为 null 或空字符串时取消中断。
   * 由 IPC 消息调用。
   */
  setInterruptTarget(taskId) {
    this._interruptTargetId = taskId || null;
    console.log(`[ControlledTodoFeature] Interrupt target set to: ${this._interruptTargetId || '(none)'}`);
    this.pushDebugSnapshot();
  }

  getInterruptTarget() {
    return this._interruptTargetId;
  }

  /**
   * 为 Task 终态记录稳定时间。TodoFeature 原有 updatedAt 会随任何后续编辑变化，
   * finishedAt / completedAt / cancelledAt 专门表达本次进入终态的时刻。
   */
  updateTask(taskId, updates) {
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

  /** task_clear 也通过 updateTask 进入终态，保证取消时间被记录。 */
  clearTasks() {
    for (const task of this.listTasks()) {
      if (task.status === 'pending' || task.status === 'in_progress') {
        this.updateTask(task.id, { status: 'deleted' });
      }
    }
  }

  /**
   * Override recordToolUsage（经继承的 static hooks 声明挂载于 StepFinish guard）。
   *
   * 先执行父类逻辑（todo 工具使用统计 + reminder 计数），
   * 然后检查中断目标是否已进入终态。如果是，返回 Decision.Deny
   * 优雅结束当前 call 循环。
   */
  async recordToolUsage(ctx) {
    const parentResult = await super.recordToolUsage(ctx);

    if (this._interruptTargetId) {
      const task = this.getTask(this._interruptTargetId);
      if (task && (task.status === 'completed' || task.status === 'deleted')) {
        console.log(`[ControlledTodoFeature] Interrupt target task ${this._interruptTargetId} reached terminal state (${task.status}), stopping call`);
        this._interruptTargetId = null;
        return Decision.Deny;
      }
    }

    return parentResult;
  }

  /**
   * Override getPlanSnapshot，附加 interruptTargetId 字段供前端消费。
   */
  getPlanSnapshot() {
    const snapshot = super.getPlanSnapshot();
    return {
      ...snapshot,
      interruptTargetId: this._interruptTargetId,
    };
  }

  /**
   * Override captureState，持久化中断目标。
   */
  captureState() {
    const state = super.captureState();
    return { ...state, interruptTargetId: this._interruptTargetId };
  }

  /**
   * Override restoreState，恢复中断目标。
   */
  restoreState(snapshot) {
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
 *   → 加 __claw_continuity__ descriptor
 *
 * 包装链（restoreState）：
 *   declareContinuity 子类 → 剥离 __claw_continuity__ → super.restoreState()
 *     → ControlledTodoFeatureInner.restoreState() → super.restoreState() + 恢复 interruptTargetId
 */
export const ControlledTodoFeature = declareContinuity(ControlledTodoFeatureInner, {
  protocol: TODO_CONTINUITY_PROTOCOL,
  importMode: 'replace',
});
