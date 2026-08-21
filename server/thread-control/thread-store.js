/**
 * Thread Store 薄壳 — 框架 WorkThreadStore 的 Claw 数据兼容层
 *
 * 目录布局与框架逐字节一致（threads/ 子目录 + index.json，ticket 008：
 * 数据目录指向不变，历史线程记录无需迁移）。本壳只补一件事：把切换前
 * Claw 自持状态机的旧状态值（idle / running / waiting_input / failed，
 * 007 拆分前的锚点+执行混合域）读时归一为框架锚点域的 'open'，下次写盘
 * 自动落成新值。更古老的状态（active / completed / cancelled / blocked）
 * 由框架 store 自带的 LEGACY_STATUS_MAP 归一。
 *
 * 旧记录中的 executionEvents / mode 字段切到 WorkThreadBoard 后成为惰性
 * 字段（不再读写，看板事件自 boards/ 目录重新累积）——已知语义变化。
 */

import {
  WorkThreadStore,
  WorkThreadNotFoundError,
  WorkThreadRevisionConflictError,
  generateWorkThreadId,
} from '@agentdev/core';

export { WorkThreadNotFoundError as ThreadNotFoundError };
export { WorkThreadRevisionConflictError as ThreadRevisionConflictError };
export { generateWorkThreadId as generateThreadId };

// 切换前 Claw 锚点记录携带的执行域状态 → 框架锚点域 open（存活）。
// 执行态判定归看板（boards/*.board.json），锚点层只关心 closed 与否。
const CLAW_LEGACY_STATUS_MAP = {
  idle: 'open',
  running: 'open',
  waiting_input: 'open',
  failed: 'open',
};

export class ThreadStore extends WorkThreadStore {
  async get(threadId) {
    const record = await super.get(threadId);
    if (record && CLAW_LEGACY_STATUS_MAP[record.status]) {
      record.status = CLAW_LEGACY_STATUS_MAP[record.status];
    }
    return record;
  }
}
