/**
 * Thread Routes — 工作线程 HTTP API
 *
 * 提供线程的创建 / 查询 / 指令追加 / head 推进 / 投递尝试 / 取消，
 * 以及归档（收纳语义：线程层标记，成员会话不动，拒绝新投递）。
 *
 * 线程寻址输入（POST /:threadId/input）：threadId 即路由事实，交给统一输入
 * 网关（ADR-0024 决策 3）完成接受性判定与入箱，不看 head runtime 是否存在；
 * 调用方不计算目标 session / viewer id。head runtime 的唤起与补投是接受之后
 * 的承接点保障，成败只作为事实回报，不改变「输入已被接住」这一结果。
 *
 * 宿主判定是会话级的（host-agents.js：agent + sessionType 组合）；
 * 生命状态为推导值（thread-life-state.js 四态合成），随列表/详情响应附带。
 *
 * 错误约定：not_found → 404；revision/head 冲突 → 409；参数问题 → 400；
 * 已归档线程收新指令 → 409 thread_archived。运行中归档：生产装配注入
 * thread-lifecycle.js（archiveThread 归档即打断收纳，不做 busy 拒绝）；
 * 本文件的无 lifecycle 兜底实现拒绝 409 thread_busy（缺 seal 事务，busy
 * 拒绝是兜底安全闸，不是生产行为——前端不得据此置灰归档入口）。
 */

import { createHash } from 'node:crypto';
import { synthesizeThreadLifeState } from './thread-life-state.js';
import { deliverThreadInput } from './input-gateway.js';
import { publishThreadEvent as publishThreadEventDefault } from '../routes/sse-events.js';

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} options
 * @param {{ core: import('@agentdevjs/core').WorkThread, board: import('@agentdevjs/core').WorkThreadBoard, archive: import('./thread-archive.js').ThreadArchiveIndex }} options.control
 * @param {{ archiveThread: Function, unarchiveThread: Function }} options.lifecycle
 * @param {Function} [options.tryDeliver] 指令追加后的即时投递（经 delivery-consumer 消费面；不传则只入箱不投递）
 * @param {Function} [options.ensureHeadRuntime] head runtime 就绪闸：head runtime 不在时
 *   由宿主唤起（startManagedAgent + ready 等待）；返回 { ok: true } 或 { ok: false, code, message }。
 *   就绪闸失败时指令仍入箱（等下一次触发点），但响应带 runtimeWake 失败事实。
 * @param {Function} [options.deliverInput] 线程寻址输入端点的投递入口（默认统一
 *   网关 deliverThreadInput；测试注入替身）。生产语义：接受性判定（closed /
 *   归档 / 删除中 / 参数问题）与入箱由网关以 Thread 记录为路由事实完成，
 *   不依赖 head runtime 是否存在——runtime 唤起的成败只是承接点事实。
 * @param {Function} [options.publishThreadEvent] thread 事件发布（DI；缺省模块级
 *   publishThreadEvent，无订阅者时 no-op）
 * @param {Function} [options.assertThreadQuota] 线程并发上限检查（ADR-0027 修订一）：
 *   async (agentId) => void，满配额抛结构化 429；由装配层闭包 agent 声明与
 *   线程控制面（server.js 注入）。不传则不检查（测试装配）。
 * @param {{ deleteThread: Function }} [options.threadDelete] - T005 删除级联服务
 * @param {Function} [options.resolveSessionChainMeta] 会话代际元数据批量解析
 *   （ticket 050）：async (agentId, sessionIds[]) => Array<{ sessionId, title,
 *   updatedAt, messageCount, archived } | null>，按入参顺序返回，会话不存在为
 *   null。供详情端点组装 sessionChainMeta（历史存档面板的时间锚 / 标题 /
 *   规模）；不注入则详情响应不含该字段。
 * @param {Function} [options.resolveHeadSessionFields] head 会话字段批量解析
 *   （列表端点热路径）：async (agentId, sessionIds[]) =>
 *   Map<string, { openDirectory: string|null, title: string|null }>。
 *   列表逐线程解析 head 的目录 / 标题时按 agentId 分组一次取回——逐线程调用
 *   resolveSessionOpenDirectory + resolveSessionTitle 会让每个请求按线程数
 *   重复读索引（PH 线程化后 1400+ 线程 → 近 3000 次 mkdir+stat），是列表
 *   延迟的主要组成。不注入时回退逐线程解析（保持既有注入方兼容）。
 */
export function setupThreadRoutes(app, express, { control, lifecycle, threadDelete, resolveSessionOpenDirectory, resolveSessionTitle, resolveSessionChainMeta, resolveHeadSessionFields, tryDeliver, ensureHeadRuntime, deliverInput = deliverThreadInput, publishThreadEvent = publishThreadEventDefault, assertThreadQuota } = {}) {
  if (!control?.core || !control?.board || !control?.archive) {
    throw new Error('setupThreadRoutes requires a control ({core, board, archive})');
  }
  const { core, board, archive } = control;
  const lifecycleService = lifecycle || {
    archiveThread: async (threadId) => {
      const thread = await core.getThread(threadId);
      if (!thread) throw Object.assign(new Error('Thread not found'), { code: 'thread_not_found', status: 404 });
      const boardState = await board.getState(threadId).catch(() => null);
      const life = synthesizeThreadLifeState({ thread, boardState });
      if (life.lifeState === 'executing' || life.lifeState === 'pending-commands') {
        throw Object.assign(new Error(`线程当前状态为 ${life.lifeState}，请先中断再归档`), { code: 'thread_busy', status: 409 });
      }
      const entry = await archive.archive(threadId);
      return { threadId, archivedAt: entry.archivedAt };
    },
    unarchiveThread: async (threadId) => {
      const thread = await core.getThread(threadId);
      if (!thread) throw Object.assign(new Error('Thread not found'), { code: 'thread_not_found', status: 404 });
      await archive.unarchive(threadId);
      return { threadId, archivedAt: null, runtimeStarted: false };
    },
  };

  /** 为线程附带合成生命状态（归档标记 + 看板状态 + 锚点指令拼装）。 */
  const _attachLifeState = async (thread, archiveEntries) => {
    const boardState = await board.getState(thread.threadId).catch(() => null);
    const life = synthesizeThreadLifeState({
      thread,
      boardState,
      archiveEntry: archiveEntries?.[thread.threadId] || null,
    });
    // head runtime 进程存活事实（managed runtimes 扫描：运行中且当前绑定
    // head 会话）：watch 侧 stalled 判定的直接死亡证据。事件停滞只说明
    // 无新 turn/item 事件，长工具调用（跑实验 / 构建，可达小时级）期间
    // 同样停滞——进程不在才是孤儿执行的直接事实。
    const headRuntimeRunning = typeof control.resolveSessionViewerId === 'function'
      ? control.resolveSessionViewerId(thread.agentId, thread.headSessionId) !== null
      : undefined;
    // 交接挡板开始时间（前端顶栏「接力中」指示器 / 输入路由守卫 / 侧栏
    // 交接占位共用，5min 陈旧线与框架 stale TTL 同口径；无挡板为 0）。
    // listThreads 返回 index 摘要（不含 pendingSuccession）——只有
    // status='rotating' 的线程（接续窗口内，通常 0-1 条）需要一次 getThread
    // 补读 startedAt，不把全量线程的记录读放上 20s 轮询热路径。
    let handoffStartedAt = 0;
    if (thread.status === 'rotating') {
      const full = await core.getThread(thread.threadId).catch(() => null);
      handoffStartedAt = Number(full?.pendingSuccession?.startedAt) || 0;
    }
    return {
      ...thread,
      ...life,
      headRuntimeRunning,
      handoffStartedAt,
    };
  };

  const _getArchiveEntries = () => archive.list().catch(() => ({}));

  const _headFieldKey = (agentId, sessionId) => `${agentId}::${sessionId}`;

  /**
   * 批量解析线程 head 的会话字段（目录 / 标题）。
   *
   * 注入 resolveHeadSessionFields 时按 agentId 分组一次取回；未注入时回退到
   * 逐线程调用 resolveSessionOpenDirectory / resolveSessionTitle（既有注入方
   * 与测试装配保持兼容）。返回 Map<`agentId::sessionId`, {openDirectory, title}>。
   */
  const _resolveHeadFieldsBulk = async (threads) => {
    const out = new Map();
    const grouped = new Map();
    for (const thread of threads) {
      const agent = String(thread?.agentId || '');
      const head = String(thread?.headSessionId || '');
      if (!agent || !head) continue;
      if (!grouped.has(agent)) grouped.set(agent, new Set());
      grouped.get(agent).add(head);
    }
    if (grouped.size === 0) return out;

    if (typeof resolveHeadSessionFields === 'function') {
      const entries = await Promise.all(
        Array.from(grouped, async ([agent, heads]) => {
          const fields = await resolveHeadSessionFields(agent, Array.from(heads)).catch(() => null);
          return [agent, fields];
        }),
      );
      for (const [agent, fields] of entries) {
        if (!fields || typeof fields.forEach !== 'function') continue;
        fields.forEach((value, sessionId) => {
          out.set(_headFieldKey(agent, sessionId), value);
        });
      }
      return out;
    }

    // 回退：逐线程解析（无批量注入方的兼容路径）。
    const hasDir = typeof resolveSessionOpenDirectory === 'function';
    const hasTitle = typeof resolveSessionTitle === 'function';
    if (!hasDir && !hasTitle) return out;
    await Promise.all(
      Array.from(grouped, ([agent, heads]) => Promise.all(Array.from(heads, async (sessionId) => {
        const openDirectory = hasDir
          ? (await resolveSessionOpenDirectory(agent, sessionId).catch(() => null)) || null
          : null;
        const title = hasTitle
          ? (await resolveSessionTitle(agent, sessionId).catch(() => null)) || null
          : null;
        out.set(_headFieldKey(agent, sessionId), { openDirectory, title });
      }))),
    );
    return out;
  };

  const _assertNotArchived = async (threadId) => {
    // 归档判定走 archive 单点（与 gateway / ACP resume 共享同一事实）
    const rejection = await archive.resolveCommandRejection(threadId);
    if (rejection) {
      const err = new Error('线程已归档，拒绝新投递（如需继续请新建线程或先取消归档）');
      err.status = rejection.status;
      err.code = rejection.code;
      throw err;
    }
  };

  // T005：删除 seal 把线程置为 closed（terminal）但 record 尚未删（含 partial
  // 失败残留窗口）。框架 appendCommand 不检查 terminal 状态——路由层必须
  // 显式拒绝向 closed 线程追加新指令（与 deliverPendingCommands 的
  // thread_closed 语义对齐），否则删除期间新 command 会写进正在销毁的 Inbox。
  const _assertNotClosed = async (threadId) => {
    const thread = await core.getThread(threadId);
    if (!thread) {
      const err = new Error('Thread not found');
      err.status = 404;
      err.code = 'thread_not_found';
      throw err;
    }
    if (thread.status === 'closed') {
      const err = new Error('线程已关闭，拒绝新指令写入（删除 / 关闭后的线程不再接受派发）');
      err.status = 409;
      err.code = 'thread_closed';
      throw err;
    }
  };

  // T005：删除 begin 事务（hold + deleting 标记）后、seal（closed）前的窗口，
  // 线程未 closed（看板事件需照常收敛，自然收尾才可达），框架 appendCommand /
  // deliverPendingCommands 不拒绝 deleting 线程——入口层必须显式停止新写入与
  // 派发（实施要求 2：删除前停止新的 command 写入和自动投递）。与
  // _assertNotClosed 互补：deleting 窗口（begin 后 / seal 前）由本守卫拦，
  // seal 后（closed）由 _assertNotClosed 拦，record 删除后返回 404。
  const _assertNotDeleting = async (threadId) => {
    const thread = await core.getThread(threadId);
    if (thread && thread.deleting === true) {
      const err = new Error('线程正在删除中，拒绝新指令写入与投递');
      err.status = 409;
      err.code = 'thread_deleting';
      throw err;
    }
  };

  const jsonMiddleware = express.json({ limit: '256kb' });

  const _errorResponse = (res, err) => {
    const status = Number(err?.status) || 500;
    const body = {
      ok: false,
      code: err?.code || 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    };
    if (err?.code === 'thread_not_found' || err?.code === 'workthread_not_found') {
      return res.status(404).json(body);
    }
    // 流快照冲突（ADR-0024 决策 4）：附读取期间推进到的当前 head 事实，
    // 调用方据此直接重取新一致快照
    if (err?.code === 'thread_stream_conflict' && err?.currentHeadSessionId != null) {
      body.currentHeadSessionId = err.currentHeadSessionId;
    }
    return res.status(status).json(body);
  };

  // ── 列表 ─────────────────────────────────────────────────────────

  app.get('/protoclaw/threads', async (req, res) => {
    try {
      const agentId = String(req.query.agentId || '').trim();
      const threads = await core.listThreads({ agentId: agentId || undefined });
      const archiveEntries = await _getArchiveEntries();
      // head 会话字段批量解析：按 agentId 分组一次取回该 agent 全部 head 的
      // 目录 / 标题。注入方（server.js）走一次共享索引读 + Map 查找；此前
      // 逐线程调 resolveSessionOpenDirectory / resolveSessionTitle 会让每个
      // 请求按线程数重复读索引（PH 线程化后 1400+ 线程 ≈ 3000 次 mkdir+stat），
      // 是列表端点秒级延迟的主要组成。
      const headFields = await _resolveHeadFieldsBulk(threads);
      const withLife = await Promise.all(
        threads.map(async (thread) => {
          const withState = await _attachLifeState(thread, archiveEntries);
          // head 会话的 viewer runtime id：前端「中断此线程」的路由目标
          //（runtime 未运行时为 null，中断入口据此置灰）。
          const headViewerAgentId = typeof control.resolveSessionViewerId === 'function'
            ? control.resolveSessionViewerId(withState.agentId, withState.headSessionId)
            : null;
          // head 会话的项目目录（PH 项目卡片的 coder tab 按此归属线程）与
          // head 会话标题（会话索引事实：侧栏线程条目跟随换代，如「(精简)A」，
          // 不停在创建时的线程标题）。解析缺席为 null，前端回退线程标题。
          const fields = headFields.get(_headFieldKey(withState.agentId, withState.headSessionId)) || null;
          const headProjectDir = fields?.openDirectory ?? null;
          const headSessionTitle = fields?.title ?? null;
          const headProjectId = fields?.projectId ?? '';
          return { ...withState, headViewerAgentId, headProjectDir, headProjectId, headSessionTitle };
        }),
      );
      // 条件刷新（20s 轮询路径）：threads 无天然整数 revision——数据源是线程
      // 文件 + 看板 + 归档索引 + 派生字段（headViewerAgentId / headProjectDir 随
      // runtime 上下线变），故以聚合结果的内容哈希为门：调用方带相同
      // sinceContentHash 即返回 unchanged 短路，跳过 ~100KB 传输与前端重建
      // （先例：session.js 的 sinceRevision 短路）。内容驱动，无失效风险。
      const contentHash = createHash('sha1').update(JSON.stringify(withLife)).digest('hex');
      if (typeof req.query.sinceContentHash === 'string' && req.query.sinceContentHash === contentHash) {
        return res.json({ ok: true, unchanged: true, contentHash });
      }
      res.json({ ok: true, threads: withLife, contentHash });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 创建 ─────────────────────────────────────────────────────────

  app.post('/protoclaw/threads', jsonMiddleware, async (req, res) => {
    try {
      const { agentId, sessionId, title, mode, workspaceId } = req.body || {};
      // 线程并发上限（ADR-0027 修订一）：满配额拒绝建线（会话创建路径的
      // 检查在 session.js 落盘之前，这里覆盖 create 动词的独立建线）。
      if (typeof assertThreadQuota === 'function') {
        await assertThreadQuota(String(agentId || '').trim());
      }
      // 锚点创建走 core.start（sessionRef 重组，Q6 清单第 1 项）；
      // mode 归看板（board.setMode）。
      const thread = await core.start({
        sessionRef: { agentId, sessionId },
        title,
        workspaceId,
      });
      if (mode) {
        await board.setMode(thread.threadId, mode);
      }
      // 创建事务落定后发布事实事件（PR-3 补挂：PR-2 时因与 SSE 线程并行
      // 回避；模式与 thread-integration.onSessionCreated 一致——DI
      // publishThreadEvent，无订阅者时 no-op）
      publishThreadEvent(thread.threadId, {
        kind: 'thread.created',
        agentId: thread.agentId,
        rootSessionId: thread.rootSessionId,
        headSessionId: thread.headSessionId,
        status: thread.status,
      });
      res.status(201).json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 详情 ─────────────────────────────────────────────────────────

  app.get('/protoclaw/threads/:threadId', async (req, res) => {
    try {
      const thread = await core.getThread(req.params.threadId);
      if (!thread) {
        return res.status(404).json({ ok: false, code: 'thread_not_found', message: 'Thread not found' });
      }
      const withState = await _attachLifeState(thread, await _getArchiveEntries());
      // 代际元数据（ticket 050 历史存档面板）：sessionChain 事实（时间锚 /
      // 触发方式来自线程记录）合并会话索引元数据（标题 / 规模 / 归档态），
      // 索引查不到的代保留链事实、其余字段为 null。按代倒序（最新在前）
      // 返回——面板按时间倒序呈现存档。
      let sessionChainMeta = undefined;
      if (typeof resolveSessionChainMeta === 'function' && Array.isArray(thread.sessionChain)) {
        const metas = await resolveSessionChainMeta(thread.agentId, thread.sessionChain.map((e) => e.sessionId));
        sessionChainMeta = thread.sessionChain.map((entry, idx) => {
          const meta = Array.isArray(metas) ? metas[idx] : null;
          return {
            sessionId: entry.sessionId,
            role: entry.role || null,
            startedAt: entry.startedAt ?? null,
            endedAt: entry.endedAt ?? null,
            endKind: entry.endKind || null,
            title: meta?.title ?? null,
            updatedAt: meta?.updatedAt ?? null,
            messageCount: Number.isFinite(meta?.messageCount) ? meta.messageCount : null,
            archived: meta?.archived === true,
          };
        }).reverse();
      }
      res.json({ ok: true, thread: withState, ...(sessionChainMeta ? { sessionChainMeta } : {}) });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── runtime session events ───────────────────────────────────────
  // The payload uses the same turn.* event shape consumed by the headless
  // single-session CLI. Only the board interprets state changes (Q6 第 3 项：
  // recordRuntimeEvent 移层看板)。
  app.post('/protoclaw/thread_events', jsonMiddleware, async (req, res) => {
    try {
      const { agentId, sessionId, runtimeInstanceId, event } = req.body || {};
      const result = await board.recordRuntimeEvent({
        agentId,
        sessionId,
        runtimeInstanceId,
        event,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  app.get('/protoclaw/threads/:threadId/events', async (req, res) => {
    try {
      // 加法式附加 eventId / receivedAt（ticket 018）：board 查询 API 只返回
      // 裸事件（信封字段被剥掉），这里直接读看板状态并按与
      // board.getExecutionEvents 相同的绝对游标窗口语义（ticket 017：
      // cursor = baseOffset + 窗口长度；after 落后于窗口起点时 clamp 到 0）
      // 切片，逐事件附加上信封字段。单次读状态，避免两次查询间的竞态；
      // 游标语义变更时与 board.getExecutionEvents 同步。
      const state = await board.getState(req.params.threadId);
      if (!state) {
        // 新线程在首条 runtime 事件落盘前没有 board，仍返回完整的空窗口契约。
        res.json({ ok: true, events: [], baseOffset: 0, cursor: 0 });
        return;
      }
      const entries = Array.isArray(state.executionEvents) ? state.executionEvents : [];
      const baseOffset = Math.max(0, Number(state.executionEventBaseOffset) || 0);
      const after = Math.max(0, Number(req.query.after) || 0);
      const from = after < baseOffset ? 0 : after - baseOffset;
      res.json({
        ok: true,
        events: entries.slice(from).map((entry) => ({
          ...(entry?.event || {}),
          eventId: entry?.eventId,
          receivedAt: entry?.receivedAt,
          sessionId: entry?.sessionId,
          runtimeInstanceId: entry?.runtimeInstanceId,
        })),
        baseOffset,
        cursor: baseOffset + entries.length,
      });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 指令追加 ─────────────────────────────────────────────────────

  app.post('/protoclaw/threads/:threadId/commands', jsonMiddleware, async (req, res) => {
    try {
      const { kind, text, source, idempotencyKey, capabilityActivations, metadata } = req.body || {};
      await _assertNotArchived(req.params.threadId);
      await _assertNotDeleting(req.params.threadId);
      await _assertNotClosed(req.params.threadId);
      const thread = await core.getThread(req.params.threadId);
      if (!thread) {
        return res.status(404).json({ ok: false, code: 'thread_not_found', message: 'Thread not found' });
      }
      // head runtime 就绪闸：runtime 消失（进程退出 / server 重启清空）后
      // 指令入箱只会滞留——投递触发点全部依赖"runtime 会 ready"的事件，
      // 而进程死亡后不会再有该事件。入箱前先经宿主唤起 head runtime；
      // 唤起失败时指令仍入箱（幂等键保留），响应携带失败事实供调用方
      // 区分"已投递"与"滞留无承接"，不再静默等待一个不会来的 ready。
      let runtimeWake = null;
      if (typeof ensureHeadRuntime === 'function' && thread.headSessionId) {
        const wake = await ensureHeadRuntime(thread.agentId, thread.headSessionId).catch((error) => ({
          ok: false,
          code: 'runtime_wake_failed',
          message: String(error?.message || error),
        }));
        if (!wake?.ok) {
          runtimeWake = { ok: false, code: wake?.code || 'runtime_wake_failed', message: wake?.message || 'head runtime not available' };
        }
      }
      const result = await core.appendCommand({
        threadId: req.params.threadId,
        kind,
        text,
        source,
        idempotencyKey,
        // 随指令流动的附件字段：前端 submitThreadCommand 早已发送，此前路由未
        // 解构导致静默丢弃（skill 激活在线程快路径上丢失）
        ...(Array.isArray(capabilityActivations) && capabilityActivations.length > 0
          ? { capabilityActivations: capabilityActivations.filter((a) => typeof a === 'string' && a) }
          : {}),
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          && Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      // head runtime 已就绪时即时投递（successor 已接棒的场景）；
      // 未就绪保持 pending，等 head 推进时投递。即时投递统一经
      // delivery-consumer 消费面（线程级退避 / 水位检查同源），与
      // gateway / runtime-ready / advance 后投递共享同一套行为。
      let delivery = null;
      if (!result.duplicate && typeof tryDeliver === 'function') {
        delivery = await tryDeliver(req.params.threadId);
      }
      res.status(result.duplicate ? 200 : 201).json({
        ok: true,
        ...result,
        delivery,
        ...(runtimeWake ? { runtimeWake } : {}),
      });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 线程寻址输入（ADR-0024 决策 3：threadId → Thread → 统一网关）──────

  /** head runtime 的 viewer id（运行中且当前绑定 head 会话）；无则 null。 */
  const _resolveHeadViewerId = (thread) => (thread && typeof control.resolveSessionViewerId === 'function'
    ? control.resolveSessionViewerId(thread.agentId, thread.headSessionId)
    : null);

  app.post('/protoclaw/threads/:threadId/input', jsonMiddleware, async (req, res) => {
    try {
      const { text, images, source, sourceRef, kind, capabilityActivations, metadata } = req.body || {};
      // 接受性判定与入箱在网关内、以 Thread 记录为路由事实完成：本端点不先
      // 反查 head runtime 再决定收不收。接续窗口里旧 head 已退役、新 head 未
      // ready 是正常状态，runtime 不存在不该让输入无法被接住——否则「暂存等
      // 接续」的能力恰好在最需要它的时候失效。
      const result = await deliverInput({
        threadId: req.params.threadId,
        text: typeof text === 'string' ? text : '',
        ...(Array.isArray(images) ? { images } : {}),
        ...(typeof source === 'string' ? { source } : {}),
        ...(typeof sourceRef === 'string' ? { sourceRef } : {}),
        ...(kind !== undefined ? { kind } : {}),
        ...(Array.isArray(capabilityActivations)
          ? { capabilityActivations: capabilityActivations.filter((a) => typeof a === 'string') }
          : {}),
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
          ? { turnMetadata: metadata }
          : {}),
      });
      // 接受之后的承接点保障（best-effort，不参与接受判定，也不同步等待）：
      // head runtime 不在时把会话拉起来，就绪后由 runtime-ready 触发点补投。
      //
      // 不 await：ensureHeadRuntime 会等到 runtime READY（最长 20s），同步等待
      // 会让「发送」按钮转 20s、输入框迟迟不清空——输入其实早已被接住。回应
      // 立即返回送达事实（多为 delivered:0），前端据此提示「已暂存」，随后由
      // 既有的 runtime-ready / head 推进触发点把指令送出去。
      //
      // 交接进行中（status='rotating'）跳过：此时 runtime 的更换由接力事务自己
      // 编排，外部再拉起旧 head 只会产生一个即将退役的实例。
      const thread = await core.getThread(req.params.threadId).catch(() => null);
      if (thread && thread.status !== 'rotating' && !result.deliveryAttempt?.delivered
        && typeof ensureHeadRuntime === 'function' && thread.headSessionId
        && !_resolveHeadViewerId(thread)) {
        void Promise.resolve()
          .then(() => ensureHeadRuntime(thread.agentId, thread.headSessionId))
          .catch((error) => {
            console.warn(
              `[thread-input] head runtime wake failed for thread=${thread.threadId} session=${thread.headSessionId}:`,
              error?.message || error,
            );
          });
      }
      res.json({
        ok: true,
        ...result,
        // head 事实：本次服务端判定的投递目标基础，供调用方对账（线程域
        // 事实 threadId / commandId 由网关结果自带）
        agentId: thread?.agentId,
        headSessionId: thread?.headSessionId,
        headViewerAgentId: _resolveHeadViewerId(thread),
      });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── head 推进（会话接力事务入口）────────────────────────────────

  app.post('/protoclaw/threads/:threadId/head', jsonMiddleware, async (req, res) => {
    try {
      const { toSessionId, fromSessionId, expectedRevision, endKind } = req.body || {};
      const thread = await core.advanceHead({
        threadId: req.params.threadId,
        toSessionId,
        fromSessionId,
        expectedRevision,
        endKind,
      });
      res.json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 投递尝试（显式触发；交接中 / runtime 未就绪时指令保持 pending）──

  app.post('/protoclaw/threads/:threadId/deliver', jsonMiddleware, async (req, res) => {
    try {
      await _assertNotArchived(req.params.threadId);
      await _assertNotDeleting(req.params.threadId);
      await _assertNotClosed(req.params.threadId);
      let result = await core.deliverPendingCommands(req.params.threadId);
      // 与 send 同源的恢复闸：裸投递撞上 runtime_not_accepting（head runtime
      // 不在）时先唤起再重投一次，deliver 从"只会重复报错的手动动作"变成
      // 与 send 一致的恢复路径。唤起失败时保留首次结果并附 runtimeWake 事实。
      let runtimeWake = null;
      const notAccepting = result?.reason === 'runtime_not_accepting' || (result?.results || []).some((r) => r.reason === 'runtime_not_accepting');
      if (notAccepting && typeof ensureHeadRuntime === 'function') {
        const thread = await core.getThread(req.params.threadId);
        if (thread?.headSessionId && thread?.status === 'open') {
          const wake = await ensureHeadRuntime(thread.agentId, thread.headSessionId).catch((error) => ({
            ok: false,
            code: 'runtime_wake_failed',
            message: String(error?.message || error),
          }));
          if (wake?.ok) {
            result = await core.deliverPendingCommands(req.params.threadId);
          } else {
            runtimeWake = { ok: false, code: wake?.code || 'runtime_wake_failed', message: wake?.message || 'head runtime not available' };
          }
        }
      }
      res.json({ ok: true, ...result, ...(runtimeWake ? { runtimeWake } : {}) });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 交接失败 / 恢复 ───────────────────────────────────────────────

  app.post('/protoclaw/threads/:threadId/handoff-failed', jsonMiddleware, async (req, res) => {
    try {
      const { reason, stage, error } = req.body || {};
      const thread = await core.failSessionHandoff(req.params.threadId, { reason, stage, error });
      res.json({ ok: true, thread });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // 恢复（Q6 第 2 项：移层看板，board 只允许 failed / waiting_input 恢复；
  // 锚点域 rotation_failed 的残局收拾由宿主接力路径负责，不经此端点）
  app.post('/protoclaw/threads/:threadId/resume', jsonMiddleware, async (req, res) => {
    try {
      const boardState = await board.resume(req.params.threadId, {
        source: req.body?.source || 'api',
      });
      res.json({ ok: true, board: boardState });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 归档（跨 Thread / Board / Runtime 的生命周期事务）────────────
  app.post('/protoclaw/threads/:threadId/archive', jsonMiddleware, async (req, res) => {
    try {
      const result = await lifecycleService.archiveThread(req.params.threadId, {
        reason: req.body?.reason || 'user_archive',
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  app.post('/protoclaw/threads/:threadId/unarchive', jsonMiddleware, async (req, res) => {
    try {
      const result = await lifecycleService.unarchiveThread(req.params.threadId);
      res.json({ ok: true, ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });

  // ── 删除（T005：直接级联清理，带确认的破坏性操作，服务端是最终安全边界）──
  app.post('/protoclaw/threads/:threadId/delete', jsonMiddleware, async (req, res) => {
    try {
      if (!threadDelete || typeof threadDelete.deleteThread !== 'function') {
        throw Object.assign(new Error('Thread delete is not wired on this server'), {
          code: 'delete_not_available',
          status: 503,
        });
      }
      const result = await threadDelete.deleteThread(req.params.threadId, {
        forceWaitMs: Number.isFinite(Number(req.body?.forceWaitMs)) ? Number(req.body?.forceWaitMs) : undefined,
        reason: typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'user_delete',
      });
      // partial（存在结构化残留）不伪装成功；ok 仅当清理完全收敛。
      res.json({ ok: result.status === 'complete', ...result });
    } catch (err) {
      _errorResponse(res, err);
    }
  });
}
