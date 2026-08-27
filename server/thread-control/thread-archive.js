/**
 * Thread Archive Index — 线程归档标记（Claw 侧叠加域）
 *
 * 归档是「用户宣告一项工作结束」的收纳语义（Q11：线程层标记、成员会话
 * 数据不动、视图按所属线程归档态折叠），属于产品 filing 概念而非连续性
 * 锚点概念——因此落在本层而非框架 WorkThreadRecord。存储为 threads 根下
 * 的 archive-index.json（threadId → archivedAt），原子写 + 串行锁，
 * 与框架 store 的 revision 乐观并发互不干扰。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export class ThreadArchiveIndex {
  /** @param {{ rootDir: string }} options */
  constructor({ rootDir }) {
    if (!rootDir) throw new Error('ThreadArchiveIndex requires rootDir');
    this.rootDir = rootDir;
    this.indexPath = path.join(rootDir, 'archive-index.json');
    this._lock = Promise.resolve();
  }

  async _read() {
    try {
      const raw = await fsp.readFile(this.indexPath, 'utf8');
      const data = JSON.parse(raw);
      return data?.threads && typeof data.threads === 'object' ? data.threads : {};
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw err;
    }
  }

  async _write(entries) {
    await fsp.mkdir(this.rootDir, { recursive: true });
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ version: 1, threads: entries }, null, 2));
    await fsp.rename(tmp, this.indexPath);
  }

  async _mutate(fn) {
    const prev = this._lock;
    let release;
    this._lock = new Promise((resolve) => { release = resolve; });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** @returns {Promise<Record<string, { archivedAt: number }>>} */
  async list() {
    return this._read();
  }

  async isArchived(threadId) {
    const entries = await this._read();
    return Boolean(entries[threadId]);
  }

  /**
   * 归档拒收的统一事实（单一判定点，四个入口共享）：
   * 归档线程的 runtime 已停且无投递触发点，指令入箱只会在 unarchive 前
   * 永久滞留——与 closed 同为「线程域禁入」的客观事实，不是状态窗口裁决。
   * @returns {Promise<{ code: 'thread_archived', status: 409 } | null>}
   *   未归档返回 null；message 由各入口按自己的呈现层拼装。
   */
  async resolveCommandRejection(threadId) {
    if (!(await this.isArchived(threadId))) return null;
    return { code: 'thread_archived', status: 409 };
  }

  /** 幂等：已归档时保留时间戳，并允许更新清理结果。 */
  async archive(threadId, options = {}) {
    return this._mutate(async () => {
      const entries = await this._read();
      const existing = entries[threadId] || { archivedAt: Date.now() };
      if (options.cleanup !== undefined) existing.cleanup = options.cleanup;
      entries[threadId] = existing;
      await this._write(entries);
      return existing;
    });
  }

  /** 幂等：未归档时无操作。 */
  async unarchive(threadId) {
    return this._mutate(async () => {
      const entries = await this._read();
      if (entries[threadId]) {
        delete entries[threadId];
        await this._write(entries);
      }
      return null;
    });
  }
}
