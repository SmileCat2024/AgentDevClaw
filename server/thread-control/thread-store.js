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

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  WorkThreadStore,
  WorkThreadNotFoundError,
  WorkThreadRevisionConflictError,
  generateWorkThreadId,
} from '@agentdevjs/core';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';

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

  /**
   * T005 删除级联：移除 Thread record 文件 + index 条目（框架 store 无删除原语，
   * 本壳补齐）。幂等：文件 / 条目不存在时视为成功。走 per-thread 串行锁，与
   * update / create 互斥；index 条目移除复用框架的 index 原子写（经私有
   * readIndex / writeIndex，布局与 updateIndexEntry 一致，只读改后整写）。
   *
   * @param {string} threadId
   * @returns {Promise<{removed: boolean, alreadyAbsent: boolean}>}
   */
  async remove(threadId) {
    const normalizedThreadId = String(threadId || '').trim();
    if (!normalizedThreadId) throw new WorkThreadNotFoundError(threadId);

    const prev = this._threadLocks.get(normalizedThreadId) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    this._threadLocks.set(normalizedThreadId, next);
    await prev.catch(() => {});
    try {
      const record = await super.get(normalizedThreadId);
      if (!record) return { removed: false, alreadyAbsent: true };

      const filePath = path.join(this.threadsDir, `${sanitizeSessionFragment(normalizedThreadId)}.json`);
      await fsp.rm(filePath, { force: true });

      // index 条目移除：框架 index 结构 { revision, threads: [...] }，
      // 与 updateIndexEntry 同布局。读-改-整写必须走框架的 _indexLock
      // 串行链（updateIndexEntry 在同一链上），否则并发创建 / 更新其它
      // 线程时双方各自的旧 index 快照会互相覆盖、丢失对方的条目。
      const indexPrev = this._indexLock;
      let indexRelease;
      const indexNext = new Promise((r) => { indexRelease = r; });
      this._indexLock = indexNext;
      try {
        await indexPrev.catch(() => {});
        const index = await this.readIndex();
        if ((index.threads || []).some((entry) => entry?.threadId === normalizedThreadId)) {
          index.threads = index.threads.filter(
            (entry) => entry?.threadId !== normalizedThreadId,
          );
          index.revision = (Number(index.revision) || 0) + 1;
          await this.writeIndex(index);
        }
      } finally {
        indexRelease();
      }
      return { removed: true, alreadyAbsent: false };
    } finally {
      release();
      if (this._threadLocks.get(normalizedThreadId) === next) this._threadLocks.delete(normalizedThreadId);
    }
  }
}
