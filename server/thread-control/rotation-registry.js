/**
 * Rotation Registry — 线程接续编排的进程内在办登记。
 *
 * 事实模型：succession 的编排者是本进程（自动接力 thread-rotation、手动
 * compact_and_resume、手动恢复 resume-rotation，全部经
 * thread-integration.beginSessionSuccession 立挡板、经 thread-succession 的
 * commitSuccession / failSuccession 终局）。线程记录的 status='rotating'
 * 只是这个在办事实的持久化投影。
 *
 * 用途：运行期幽灵挡板判定（createThreadRecoveryService.convergePhantomRotating）。
 * 「记录在 rotating 但本进程没有该线程的编排在办」= 投影失去对应事实，
 * 立即收敛——无 TTL 等待窗口，也无 TTL 误杀（真实接续无论跑多久都登记
 * 在册；时间判不出编排死活，事实判得出）。
 *
 * 配对契约（咽喉层结构性保证，编排方零感知）：
 *   - begin：beginSessionSuccession 挡板落盘成功后同步登记（同一微任务链，
 *     中间无 await——并发扫描不可能观察到「已 rotating 但未登记」的中间
 *     态，见该处注释）；
 *   - end：commitSuccession / failSuccession 的 finally 注销。finally 而非
 *     成功路径：记录级收敛（rotation_failed 落盘 / 挡板清除）即使写盘失败，
 *     登记也先释放——残留挡板交给运行期幽灵扫描收敛，而不是等登记泄漏。
 *
 * age 阀（防御性）：end 配对由咽喉层 finally 结构性保证；未来新增编排方
 * 走 fallback 路径（无 succession 服务）漏注销时，把「静默永久跳过收敛」
 * 降级为「有界跳过」——超龄登记按不存在处理并顺手清除。阈值远大于任何
 * 合法接续时长（READY 等待 20s 级 + 摘要 LLM 分钟级）。
 */

/**
 * @param {object} [options]
 * @param {number} [options.maxAgeMs] 登记超龄阈值（默认 30 分钟）
 * @param {() => number} [options.now] 时钟注入（测试用）
 */
export function createRotationRegistry({ maxAgeMs = 30 * 60 * 1000, now = () => Date.now() } = {}) {
  const inflight = new Map(); // threadId → { startedAt, reason }

  return {
    /** 编排开始（挡板已立）：登记在办事实。同线程重复 begin 刷新时间戳。 */
    begin(threadId, meta = {}) {
      const key = String(threadId || '').trim();
      if (!key) return;
      inflight.set(key, { startedAt: now(), reason: meta?.reason || null });
    },

    /** 编排终局（commit / fail / 收敛）：注销登记。幂等。 */
    end(threadId) {
      inflight.delete(String(threadId || '').trim());
    },

    /**
     * 该线程是否有编排在办。空 id 恒 false；超龄登记视为泄漏，顺手清除
     * 并返回 false（age 阀，见头注）。
     */
    isActive(threadId) {
      const key = String(threadId || '').trim();
      if (!key) return false;
      const entry = inflight.get(key);
      if (!entry) return false;
      if (now() - entry.startedAt > maxAgeMs) {
        inflight.delete(key);
        return false;
      }
      return true;
    },

    /** 在办条数（诊断/测试）。 */
    activeCount() {
      return inflight.size;
    },
  };
}

let _defaultRegistry = null;

/**
 * 进程级单例：begin/终局咽喉与运行期幽灵扫描必须共享同一实例才有意义。
 * 测试环境用 createRotationRegistry 显式注入隔离实例，不用单例。
 */
export function getRotationRegistry() {
  if (!_defaultRegistry) _defaultRegistry = createRotationRegistry();
  return _defaultRegistry;
}
