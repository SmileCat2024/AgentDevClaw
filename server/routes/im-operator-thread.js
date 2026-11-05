/**
 * IM 接线员线程事务 — qqbot 的业务单对话状态（ADR-0042 决策 5）
 *
 * 与 memo（ADR-0024）同构：唯一接线员线程承接连续对话，新建换代归档。
 * 两处刻意差异：
 * - 活动引用 operatorThreadId 持有在 im-workspace.config.json，不另设状态
 *   文件——接线员引用本就是 IM 域配置，与线路模型同文件、共享
 *   withIMWorkspaceConfig 串行器；
 * - boot 只唤起不新建：memo 的提醒刚性要求 boot 建会话，qqbot 的接线员
 *   对话没有这个刚性，等首个门户消息或用户打开对话时经 conversation/start
 *   建立（按需拉起模型，未配置 IM 的用户不被凭空建会话）。
 *
 * 存量处置（ADR-0042 决策 6）：receptionistSessionId 不换算线程身份——升级后
 * 首次 conversation/start 建立首代接线员线程，旧接线员会话作为普通历史会话
 * 只读保留。runtime 会话解析（agent-startup）因此只认 operatorThreadId，
 * 不回退 receptionistSessionId。
 *
 * 配置读写经 deps 注入（readConfig / mutateConfig）：生产装配传
 * im-config 的 readProjectIMWorkspaceConfig / withIMWorkspaceConfig，测试传
 * 内存实现——本模块不落任何自有状态，线程事实全部经 threadControl 查询。
 */

const OPERATOR_AGENT_ID = 'qqbot';
const OPERATOR_SESSION_TITLE = 'IM 接线员';
const RUNTIME_READY_TIMEOUT_MS = 20000;

function operatorError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/** 配置归一后的引用读取（纯函数，供 agent-startup 等轻量消费方复用）。 */
function readOperatorThreadId(config) {
  return String(config?.operatorThreadId || '').trim();
}

/**
 * 解析接线员线程（引用 → 存活线程）。终态 / 归档 / 记录消失均返回 null
 * （引用悬空），由调用方决定 ensure 还是换代。
 */
async function resolveOperatorThread({ integration, readConfig }) {
  const threadId = readOperatorThreadId(await readConfig());
  if (!threadId) return null;
  const thread = await integration.core.getThread(threadId).catch(() => null);
  if (!thread || thread.status === 'closed') return null;
  if (typeof integration.archive?.isArchived === 'function'
    && await integration.archive.isArchived(threadId).catch(() => false)) {
    return null;
  }
  return thread;
}

/**
 * qqbot runtime 的 preferredSessionId 解析（agent-startup 消费）：
 * operatorThreadId → head 会话；无引用或悬空返回 null——不回退
 * receptionistSessionId（ADR-0042 存量处置：升级即换代，不换算旧会话）。
 */
export async function resolveOperatorHeadSessionId({ integration, readConfig }) {
  const thread = await resolveOperatorThread({ integration, readConfig });
  return thread?.headSessionId || null;
}

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} deps 宿主注入（与 memo-app 同一批装配能力）
 */
export function setupIMOperatorThreadRoutes(app, express, {
  requireAgentLight,
  createPrebuiltSession,
  startManagedAgent,
  stopManagedAgent,
  waitForManagedRuntimeReady,
  threadControl,
  threadIntegration,
  threadLifecycle,
  threadDelete,
  // 配置读写注入（生产：im-config 的对应导出；测试：内存实现）
  readConfig,
  mutateConfig,
  // 旧接线员会话归档（生产：archivePrebuiltSession；ADR-0042 决策 6：
  // 既有接线员会话随换代归档、只读保留、不换算线程身份）
  archiveLegacySession,
} = {}) {
  const integration = {
    core: threadControl.core,
    archive: threadControl.archive,
  };

  /** start/new 共用的串行锁：同一时刻至多一个事务在改写接线员引用。 */
  let inFlight = null;
  function serialized(task) {
    const previous = inFlight || Promise.resolve();
    const run = previous.then(task, task);
    inFlight = run.finally(() => {
      if (inFlight === run) inFlight = null;
    });
    return inFlight;
  }

  /** 新建一代接线员对话：会话 → runtime → 宿主钩子建线程 → ready 对账 → 写引用。 */
  async function createOperatorConversation() {
    const agent = await requireAgentLight(OPERATOR_AGENT_ID);
    const state = { session: null, runtimeStartAttempted: false };
    try {
      const session = await createPrebuiltSession(OPERATOR_AGENT_ID, {
        title: OPERATOR_SESSION_TITLE,
        returnSummary: false,
      });
      state.session = session;

      state.runtimeStartAttempted = true;
      await startManagedAgent(agent, session.id);

      // 线程宿主钩子：qqbot 的会话自动成为新线程初始 head（threadHost 声明化判定）。
      await threadIntegration.onSessionCreated(OPERATOR_AGENT_ID, session);

      const ready = await waitForManagedRuntimeReady(
        OPERATOR_AGENT_ID, RUNTIME_READY_TIMEOUT_MS, session.id,
      );
      if (!ready) {
        throw operatorError(504, 'runtime_ready_timeout',
          `qqbot runtime not READY within ${RUNTIME_READY_TIMEOUT_MS}ms (session=${session.id})`);
      }

      const thread = await threadControl.core.findThreadByHeadSession(OPERATOR_AGENT_ID, session.id);
      if (!thread) {
        throw operatorError(500, 'thread_missing',
          `session created but no thread anchor holds it as head (session=${session.id})`);
      }

      await mutateConfig((config) => {
        config.operatorThreadId = thread.threadId;
        return true;
      });
      // 升级迁移（ADR-0042 决策 6）：首代接线员线程落定后，归档旧 receptionist
      // 会话并清引用。best-effort：失败不破坏新线程（引用已落定），残留的
      // receptionistSessionId 留待下次换代重试。
      const legacy = await archiveLegacyOperatorSession();
      return { created: true, threadId: thread.threadId, sessionId: session.id, legacy };
    } catch (error) {
      await rollbackConversationCreation(state).catch((rollbackError) => {
        console.error('[im-operator] rollback failed:', rollbackError?.message || rollbackError);
      });
      throw error;
    }
  }

  /** 创建链回滚（memo / ACP 原子创建同构）：stop runtime → 线程级联删。 */
  async function rollbackConversationCreation(state) {
    const sessionId = state.session?.id;
    if (!sessionId) return;
    if (state.runtimeStartAttempted) {
      await stopManagedAgent(OPERATOR_AGENT_ID, sessionId).catch(() => {});
    }
    const thread = await threadControl.core
      .findThreadByHeadSession(OPERATOR_AGENT_ID, sessionId).catch(() => null);
    if (!thread) return;
    const result = await threadDelete.deleteThread(thread.threadId, {
      reason: 'im_operator_creation_rollback',
    });
    if (result.status !== 'complete') {
      console.warn(`[im-operator] rollback thread delete partial: ${thread.threadId}`);
    }
  }

  /**
   * 升级迁移步骤：归档旧 receptionist 会话并清引用（ADR-0042 决策 6）。
   * 无 receptionistSessionId 时是 no-op；归档失败返回失败标记，不抛出——
   * 调用点（createOperatorConversation）的新线程引用已落定，不能被它破坏。
   */
  async function archiveLegacyOperatorSession() {
    const config = await readConfig();
    const legacySessionId = String(config?.receptionistSessionId || '').trim();
    if (!legacySessionId) return null;
    try {
      await archiveLegacySession(OPERATOR_AGENT_ID, legacySessionId, true);
      await mutateConfig((current) => {
        delete current.receptionistSessionId;
        return true;
      });
      return { archived: true, sessionId: legacySessionId };
    } catch (error) {
      console.warn('[im-operator] archive legacy receptionist session failed:',
        `${legacySessionId}:`, error?.message || error);
      return { archived: false, sessionId: legacySessionId, error: String(error?.message || error) };
    }
  }

  /** ensure：引用在且线程存活 → 唤起 head runtime 复用；否则新建一代。 */
  function ensureOperatorConversation() {
    return serialized(async () => {
      const active = await resolveOperatorThread({ integration, readConfig });
      if (!active) return createOperatorConversation();
      const agent = await requireAgentLight(OPERATOR_AGENT_ID);
      await startManagedAgent(agent, active.headSessionId);
      const ready = await waitForManagedRuntimeReady(
        OPERATOR_AGENT_ID, RUNTIME_READY_TIMEOUT_MS, active.headSessionId,
      );
      if (!ready) {
        throw operatorError(504, 'runtime_ready_timeout',
          `qqbot runtime not READY within ${RUNTIME_READY_TIMEOUT_MS}ms (session=${active.headSessionId})`);
      }
      return { created: false, threadId: active.threadId, sessionId: active.headSessionId };
    });
  }

  app.post('/protoclaw/im_operator/conversation/start', express.json(), async (_req, res, next) => {
    try {
      const conversation = await ensureOperatorConversation();
      const thread = await threadControl.core.getThread(conversation.threadId).catch(() => null);
      res.json({ ok: true, ...conversation, thread });
    } catch (err) {
      next(err);
    }
  });

  app.post('/protoclaw/im_operator/conversation/new', express.json(), async (_req, res, next) => {
    try {
      res.json({ ok: true, ...await replaceOperatorConversation() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 新建换代：先建新一代并落引用，再 best-effort 归档旧线程（打断收纳）。
   * 归档失败不回滚引用——残留旧线程不破坏唯一活动语义（引用已指向新线程），
   * 与 memo 换代同序。
   */
  async function replaceOperatorConversation() {
    const previous = await resolveOperatorThread({ integration, readConfig });
    const conversation = await serialized(() => createOperatorConversation());
    let archive = null;
    if (previous) {
      try {
        await threadLifecycle.archiveThread(previous.threadId, {
          reason: 'im_operator_new_conversation',
        });
        archive = { archived: true, threadId: previous.threadId };
      } catch (error) {
        archive = {
          archived: false,
          threadId: previous.threadId,
          error: String(error?.message || error),
        };
        console.warn(`[im-operator] archive previous thread failed: ${previous.threadId}:`,
          error?.message || error);
      }
    }
    return { ...conversation, archive };
  }

  /**
   * boot 自启（server ready 后调用）：引用存在 → 唤起 head runtime（IM gateway
   * 常驻的前提；在线则 no-op）；引用不存在 → 不动作（按需建，见头注）。
   * 尽力而为：失败只记日志，不阻断服务就绪。
   */
  async function bootIMOperatorOnServerReady() {
    try {
      const active = await resolveOperatorThread({ integration, readConfig });
      if (!active) return { booted: false };
      const agent = await requireAgentLight(OPERATOR_AGENT_ID);
      await startManagedAgent(agent, active.headSessionId);
      const ready = await waitForManagedRuntimeReady(
        OPERATOR_AGENT_ID, RUNTIME_READY_TIMEOUT_MS, active.headSessionId,
      );
      console.log(`[im-operator] boot: runtime ${ready ? 'ready' : 'not ready yet'}`
        + ` (thread=${active.threadId}, session=${active.headSessionId})`);
      return { booted: true, threadId: active.threadId };
    } catch (error) {
      console.warn('[im-operator] boot runtime failed:', error?.message || error);
      return { booted: false, error: String(error?.message || error) };
    }
  }

  return { bootIMOperatorOnServerReady, ensureOperatorConversation, replaceOperatorConversation, resolveOperatorThread };
}
