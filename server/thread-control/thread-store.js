/**
 * ThreadStore — 工作线程持久化存储
 *
 * 设计要点（与 session-access.js 的 index 模式对齐）：
 * - 每个线程一个 JSON 文件（含 thread 记录与 inbox commands），
 *   保证「head 推进 + 指令状态变更」可以在同一次原子写内完成。
 * - index.json 仅保存列表摘要（threadId / agentId / title / status /
 *   headSessionId / updatedAt），供轻量列举。
 * - 所有写操作走 per-thread 串行锁 + revision 自增 + tmp/rename 原子写。
 * - 支持 expectedRevision 乐观并发控制（head 推进等关键事务使用）。
 *
 * 该模块只负责持久化与并发安全，不理解线程语义（head 推进规则、
 * 指令幂等等由 thread-controller.js 负责）。
 */

import path from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { ensureDir } from '../shared/fs-helpers.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';

export class ThreadNotFoundError extends Error {
  constructor(threadId) {
    super(`Thread "${threadId}" not found`);
    this.name = 'ThreadNotFoundError';
    this.code = 'thread_not_found';
  }
}

export class ThreadRevisionConflictError extends Error {
  constructor(threadId, expected, actual) {
    super(`Revision conflict on thread "${threadId}": expected ${expected}, current ${actual}`);
    this.name = 'ThreadRevisionConflictError';
    this.code = 'revision_conflict';
    this.expected = expected;
    this.actual = actual;
  }
}

export function generateThreadId() {
  return `wt-${randomUUID()}`;
}

function _threadContentSignature(record) {
  // revision 与 updatedAt 不参与签名：纯元数据更新（如重复幂等追加）不落盘
  const { revision: _revision, updatedAt: _updatedAt, ...rest } = record || {};
  return JSON.stringify(rest);
}

export class ThreadStore {
  /**
   * @param {object} options
   * @param {string} options.rootDir - 线程数据根目录（默认由调用方注入 THREADS_ROOT）
   */
  constructor({ rootDir } = {}) {
    if (!rootDir || typeof rootDir !== 'string') {
      throw new Error('ThreadStore requires a rootDir');
    }
    this.rootDir = rootDir;
    this.threadsDir = path.join(rootDir, 'threads');
    this.indexPath = path.join(rootDir, 'index.json');
    this._threadLocks = new Map();
    this._indexLock = Promise.resolve();
  }

  // ── 路径 ──────────────────────────────────────────────────────────

  _threadFilePath(threadId) {
    return path.join(this.threadsDir, `${sanitizeSessionFragment(threadId)}.json`);
  }

  // ── 原子写（对齐 session-access.writeSessionIndex 模式）─────────

  async _atomicWriteJson(filePath, data) {
    const tmpPath = filePath + '.tmp';
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    try {
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        await fs.unlink(filePath).catch(() => {});
        await fs.rename(tmpPath, filePath);
      } else if (err.code === 'EXDEV') {
        await fs.copyFile(tmpPath, filePath);
        await fs.unlink(tmpPath).catch(() => {});
      } else {
        throw err;
      }
    }
  }

  // ── index（列表摘要）─────────────────────────────────────────────

  async _readIndex() {
    try {
      const raw = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
      const threads = Array.isArray(raw.threads) ? raw.threads : [];
      return {
        revision: Number.isSafeInteger(Number(raw.revision)) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0,
        threads,
      };
    } catch {
      return { revision: 0, threads: [] };
    }
  }

  async _writeIndex(index) {
    await ensureDir(this.rootDir);
    await this._atomicWriteJson(this.indexPath, index);
  }

  async _updateIndexEntry(record) {
    const prev = this._indexLock;
    let release;
    const next = new Promise((r) => (release = r));
    this._indexLock = next;
    await prev.catch(() => {});
    try {
      const index = await this._readIndex();
      const entry = {
        threadId: record.threadId,
        agentId: record.agentId,
        workspaceId: record.workspaceId || '',
        title: record.title || '',
        mode: record.mode || 'interactive',
        status: record.status || 'active',
        rootSessionId: record.rootSessionId || '',
        headSessionId: record.headSessionId || '',
        // 链成员 id 列表（轻量，供前端徽标判定「会话是否属于线程」）
        sessionIds: (Array.isArray(record.sessionChain) ? record.sessionChain : []).map(
          (entry) => entry?.sessionId || '',
        ).filter(Boolean),
        revision: record.revision,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      const existingIdx = index.threads.findIndex((t) => t.threadId === record.threadId);
      if (existingIdx >= 0) {
        index.threads[existingIdx] = entry;
      } else {
        index.threads.push(entry);
      }
      index.revision = (Number(index.revision) || 0) + 1;
      await this._writeIndex(index);
    } finally {
      release();
    }
  }

  // ── 读 ───────────────────────────────────────────────────────────

  async list() {
    const index = await this._readIndex();
    return index.threads;
  }

  async get(threadId) {
    if (!threadId || typeof threadId !== 'string') return null;
    try {
      return JSON.parse(await fs.readFile(this._threadFilePath(threadId), 'utf8'));
    } catch {
      return null;
    }
  }

  // ── 写 ───────────────────────────────────────────────────────────

  /**
   * 创建线程记录。要求调用方（controller）已构建完整初始记录。
   */
  async create(record) {
    const threadId = record?.threadId;
    if (!threadId) throw new Error('ThreadStore.create requires record.threadId');
    await ensureDir(this.threadsDir);
    const existing = await this.get(threadId);
    if (existing) {
      throw new Error(`Thread "${threadId}" already exists`);
    }
    await this._atomicWriteJson(this._threadFilePath(threadId), record);
    await this._updateIndexEntry(record);
    return record;
  }

  /**
   * 串行化更新单个线程记录。
   *
   * @param {string} threadId
   * @param {(record: object) => object} mutFn - 返回（可能被修改的）记录
   * @param {object} [options]
   * @param {number} [options.expectedRevision] - 乐观并发检查
   * @returns {Promise<{record: object, changed: boolean}>}
   */
  async update(threadId, mutFn, options = {}) {
    const prev = this._threadLocks.get(threadId) || Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    this._threadLocks.set(threadId, next);
    await prev.catch(() => {});
    try {
      const record = await this.get(threadId);
      if (!record) {
        throw new ThreadNotFoundError(threadId);
      }
      if (Number.isInteger(options.expectedRevision) && record.revision !== options.expectedRevision) {
        throw new ThreadRevisionConflictError(threadId, options.expectedRevision, record.revision);
      }

      const before = _threadContentSignature(record);
      const proposed = await mutFn(record);
      if (!proposed || typeof proposed !== 'object') {
        throw new Error('ThreadStore.update mutFn must return the record');
      }
      const after = _threadContentSignature(proposed);

      if (after === before) {
        return { record, changed: false };
      }

      const nextRecord = {
        ...proposed,
        revision: (Number(record.revision) || 0) + 1,
        updatedAt: Date.now(),
      };
      await this._atomicWriteJson(this._threadFilePath(threadId), nextRecord);
      await this._updateIndexEntry(nextRecord);
      return { record: nextRecord, changed: true };
    } finally {
      release();
      if (this._threadLocks.get(threadId) === next) this._threadLocks.delete(threadId);
    }
  }
}
