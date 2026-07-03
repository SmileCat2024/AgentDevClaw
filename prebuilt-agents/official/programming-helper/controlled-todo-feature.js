/**
 * ControlledTodoFeature — 继承框架 TodoFeature，增加"完成后停止"中断控制能力。
 *
 * 设计原理：
 * - hooks registry 通过方法名调用 instance.recordToolUsage()，
 *   override 父类方法即可在 @StepFinish 决策点注入自定义逻辑。
 * - 不添加新的 @StepFinish 装饰器（唯一性约束下子类无法注册第二个）。
 * - interruptTargetId 由前端通过 IPC 设置，下一次 StepFinish 检查到目标 task
 *   进入终态（completed/deleted）时返回 Decision.Deny，优雅结束当前 call。
 */

import { TodoFeature, Decision } from 'agentdev';

export class ControlledTodoFeature extends TodoFeature {
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
   * Override @StepFinish 钩子。
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
  }
}
