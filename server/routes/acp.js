/**
 * ACP Support Routes — coder 会话的原子创建 + 精确中断 + 会话发现与续接（ticket 018）
 *
 * 为外部 ACP adapter（scripts/run-coder-acp.js，独立 stdio 进程）提供进程内
 * 编排路由，替代 adapter 自行组合既有端点（会留下孤儿 session / runtime /
 * thread，且需要理解 viewerAgentId 等 ViewerWorker 内部概念，见 ADR-0004 决策 3）：
 *
 *   POST /protoclaw/acp/coder/sessions
 *     （原子创建，见下；可选 body.model 指定启动模型预设，见
 *     resolveAcpModelPreset —— 解析成功即持久化写入 coder 配置）
 *
 * 测试缝（ctx 注入，production callers omit）：
 *   ctx.acpPresetsPath      resolveAcpModelPreset 的 presets.json 路径覆盖
 *   ctx.acpModelConfigPath  applyAcpModelPreset 的 coder.json 路径覆盖
 *
 *   GET  /protoclaw/acp/coder/sessions?cwd=...
 *     线程视角会话发现：每个活跃（未归档）线程出一条，以 head 会话为视角。
 *     可选 cwd 过滤按会话 openDirectory 归一化比较（Windows 大小写不敏感）。
 *
 *   POST /protoclaw/acp/coder/sessions/:clawSessionId/resume
 *     把成员或 head 会话解析到其线程的当前 head，急切挂载 runtime 并等待
 *     READY 后返回 { clawSessionId, threadId, viewerAgentId, cwd }。归档线程
 *     拒绝（409），无线程锚定 404，cwd 与持久化记录不一致 403。
 *
 *   POST /protoclaw/acp/coder/sessions/:clawSessionId/interrupt
 *     （精确中断，见下）
 *
 *   POST /protoclaw/acp/coder/sessions/:clawSessionId/stop
 *     精确停止该会话的 coder runtime（session/close 的数据面）。
 *     runtime 未运行时幂等成功；thread / session 数据不动，归档不经此层。
 *
 * 外部契约仍以 agentId="coder" 调用（编辑器集成零感知）；coder 已并入
 * programming-helper 工作空间，内部实现落在该工作空间的 coder 会话身份
 * 上（sessionType='coder'，线程宿主）。
 */

import path from 'path';
import { promises as fs } from 'fs';

import { PROJECT_ROOT } from '../shared/constants.js';
import { readJsonSafe } from '../shared/fs-helpers.js';
import { VIEWER_ORIGIN } from '../shared/constants.js';
import {
  getAgentRuntime,
  listAgentRuntimes,
  isManagedRuntimeRunning,
  getRuntimeByViewerAgentId,
} from '../shared/agent-access.js';
import { sanitizeSessionFragment, cleanSessionText } from '../shared/string-helpers.js';

/** 对外契约 ID：ACP adapter 请求体仍传 agentId="coder"。 */
export const ACP_AGENT_ID = 'coder';
/** 内部实现：coder 会话宿主在 programming-helper 工作空间。 */
export const ACP_WORKSPACE_AGENT_ID = 'programming-helper';
/** coder 身份会话类型（线程宿主判定与 CoderAgent 分派键）。 */
export const ACP_SESSION_TYPE = 'coder';
export const ACP_READY_TIMEOUT_DEFAULT_MS = 30_000;
export function resolveAcpReadyTimeoutMs() {
  const raw = Number(process.env.CLAW_ACP_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : ACP_READY_TIMEOUT_DEFAULT_MS;
}

function acpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** 路径比较键：归一化分隔符 + 小写（Windows 大小写不敏感语义）。 */
export function acpPathKey(rawPath) {
  return String(rawPath || '').trim().replace(/[\\/]+/g, '\\').toLowerCase();
}

/**
 * 解析某 session 当前 runtime 的 viewerAgentId。
 *
 * 精确 session 定位（与 thread-controller 桥的 resolveRuntimeViewerId 同
 * 语义）：先查精确注册键，再扫描该 agent 的 runtimes 按 selectedSessionId
 * 匹配（shared-by-project 模式下注册键可能漂移，selectedSessionId 才是
 * 当前绑定事实）。绝不回退到 primary runtime——那会把控制投递送到别的
 * session（跨 session 污染）。
 */
export function resolveSessionViewerAgentId(agentId, sessionId) {
  const normalizedSession = sanitizeSessionFragment(sessionId);
  const direct = getAgentRuntime(agentId, sessionId);
  if (direct && isManagedRuntimeRunning(direct) && direct.viewerAgentId) {
    return direct.viewerAgentId;
  }
  const match = listAgentRuntimes(agentId).find((runtime) =>
    isManagedRuntimeRunning(runtime)
    && sanitizeSessionFragment(runtime.selectedSessionId) === normalizedSession
    && runtime.viewerAgentId,
  );
  return match?.viewerAgentId || null;
}

/**
 * 按 ACP session/new 的 model 参数解析模型预设（profile）。
 *
 * 对外字段名是 model，但真实索引是 config/presets.json 的预设：name
 * （display name）与 model（模型名）两个候选字段。两层都不能假设唯一
 * ——系统不强制 preset name 去重，同一 model 名也允许挂多个预设（不同
 * 连接配置）。因此匹配规则是「唯一即用、歧义即报错」：
 *
 *   1. name 精确 → 2. name 大小写不敏感 → 3. model 精确 → 4. model 不敏感
 *
 * 任一层命中多条 → 抛 400 并列出全部候选（name + model）。绝不静默挑选
 * ——同 model 名的预设差异在连接层（baseUrl/apiKey），选错会把请求打到
 * 完全不同的服务上。
 *
 * @param {string} rawModel session/new 请求的 model 参数（原样字符串）
 * @param {{ presetsPath?: string }} [options] 测试缝——production callers omit
 * @returns {Promise<string|null>} 命中的预设 name（写回 coder 配置用）；
 *   参数缺失 / 空串返回 null（未指定，沿用现有配置）
 */
export async function resolveAcpModelPreset(rawModel, options = {}) {
  const requested = typeof rawModel === 'string' ? rawModel.trim() : '';
  if (!requested) return null;

  const presetsPath = options.presetsPath || path.join(PROJECT_ROOT, 'config', 'presets.json');
  const presetsRaw = await readJsonSafe(presetsPath, null);
  const presets = Array.isArray(presetsRaw?.presets) ? presetsRaw.presets : [];
  if (presets.length === 0) {
    throw acpError(400, 'model_preset_unavailable', `no model presets configured (config/presets.json is empty or missing); cannot resolve model "${requested}"`);
  }

  const requestedKey = requested.toLowerCase();
  const listCandidates = (matches) => matches
    .map((preset) => `  - ${preset.name || '(unnamed)'} (model: ${preset.model || '?'})`)
    .join('\n');

  // 层 1/2：preset name（display name）——主键语义，优先匹配
  const byExactName = presets.filter((preset) => preset.name === requested);
  if (byExactName.length === 1) return byExactName[0].name;
  if (byExactName.length > 1) {
    throw acpError(400, 'ambiguous_model', `model "${requested}" matches ${byExactName.length} presets with the same name:\n${listCandidates(byExactName)}\nremove the duplicate preset first`);
  }
  const byNameCi = presets.filter((preset) => typeof preset.name === 'string' && preset.name.toLowerCase() === requestedKey);
  if (byNameCi.length === 1) return byNameCi[0].name;
  if (byNameCi.length > 1) {
    throw acpError(400, 'ambiguous_model', `model "${requested}" matches ${byNameCi.length} presets (case-insensitive name):\n${listCandidates(byNameCi)}\nspecify one of the preset names above`);
  }

  // 层 3/4：model 字段——便利入口，无歧义才放行
  const byModel = presets.filter((preset) => preset.model === requested);
  if (byModel.length === 1) return byModel[0].name;
  if (byModel.length > 1) {
    throw acpError(400, 'ambiguous_model', `model "${requested}" matches ${byModel.length} presets:\n${listCandidates(byModel)}\nspecify one of the preset names above`);
  }
  const byModelCi = presets.filter((preset) => typeof preset.model === 'string' && preset.model.toLowerCase() === requestedKey);
  if (byModelCi.length === 1) return byModelCi[0].name;
  if (byModelCi.length > 1) {
    throw acpError(400, 'ambiguous_model', `model "${requested}" matches ${byModelCi.length} presets (case-insensitive):\n${listCandidates(byModelCi)}\nspecify one of the preset names above`);
  }

  throw acpError(400, 'model_preset_not_found', `no preset matches "${requested}". Available presets:\n${listCandidates(presets)}`);
}

/**
 * 把解析出的预设 name 写入 coder 的启动配置
 * （.agentdev/agent-configs/coder.json 的 modelPresets.default）。
 *
 * 写盘而非本次启动参数：coder runtime 的 spawn 链路固定从该文件解析启动
 * 模型（run-prebuilt-agent.js 的 coder 分支），写盘后 spawn 自然读到新值，
 * 无需给 runtime 加启动参数。持久化是显式行为——ACP 指定的模型成为该
 * coder 身份的后续默认。
 *
 * @param {string} presetName 已解析的预设 name
 * @param {{ configPath?: string }} [options] 测试缝——production callers omit
 */
export async function applyAcpModelPreset(presetName, options = {}) {
  const configPath = options.configPath || path.join(PROJECT_ROOT, '.agentdev', 'agent-configs', 'coder.json');
  const configDir = path.dirname(configPath);
  const existingConfig = await readJsonSafe(configPath, {}) || {};
  existingConfig.modelPresets = {
    ...(existingConfig.modelPresets && typeof existingConfig.modelPresets === 'object' ? existingConfig.modelPresets : {}),
    default: presetName,
  };
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(existingConfig, null, 2), 'utf8');
  return existingConfig;
}

/**
 * 校验 ACP cwd：必须是绝对路径、且已存在并为目录。
 * 拒绝隐式创建 / 回退（不存在、是文件、相对路径一律 400）。
 * @param {string} rawCwd
 * @param {{ cwd?: string }} [options] 测试缝
 */
export async function validateAcpCwd(rawCwd) {
  if (typeof rawCwd !== 'string' || !rawCwd.trim()) {
    throw acpError(400, 'invalid_cwd', 'cwd must be a non-empty string');
  }
  const trimmed = rawCwd.trim();
  if (!path.isAbsolute(trimmed)) {
    throw acpError(400, 'invalid_cwd', `cwd must be an absolute path: ${trimmed}`);
  }
  const normalized = path.normalize(trimmed);
  let stat;
  try {
    stat = await fs.stat(normalized);
  } catch {
    throw acpError(400, 'invalid_cwd', `cwd does not exist: ${normalized}`);
  }
  if (!stat.isDirectory()) {
    throw acpError(400, 'invalid_cwd', `cwd is not a directory: ${normalized}`);
  }
  return normalized;
}

/**
 * @param {import('express').Express} app
 * @param {typeof import('express').json} express
 * @param {object} ctx
 * @param {object} ctx.threadIntegration - getThreadIntegration()（onSessionCreated 宿主钩子）
 * @param {object} ctx.threadControl - getThreadControl()（{core, archive}；list/resume 需要）
 * @param {Function} [ctx.requirePrebuiltSessionRecord] - 会话索引记录读取（resume cwd 校验 / list 标题来源）
 * @param {Function} [ctx.readSessionSnapshotForContinuity] - 完整会话快照读取（history 端点消息来源）
 */
export function setupAcpRoutes(app, express, ctx) {
  const {
    requireAgentLight,
    createPrebuiltSession,
    deletePrebuiltSession,
    startManagedAgent,
    stopManagedAgent,
    waitForManagedRuntimeReady,
    threadIntegration,
    threadControl,
    requirePrebuiltSessionRecord,
    readSessionSnapshotForContinuity,
  } = ctx;

  // 无条件依赖做启动时校验：接线遗漏（如工厂未导出）立即暴露在 server 启动，
  // 而不是等到请求时报 "xxx is not a function"。
  for (const dep of ['requirePrebuiltSessionRecord', 'readSessionSnapshotForContinuity']) {
    if (typeof ctx[dep] !== 'function') {
      throw new Error(`setupAcpRoutes: missing required ctx dependency "${dep}"`);
    }
  }

  /**
   * 失败回滚阶梯（设计 §5）。每步独立 best-effort：前步失败不阻断后步，
   * 失败步骤与遗留对象 ID 全部如实上报。
   */
  async function rollbackAcpCreation(agentId, state) {
    const steps = [];
    const leftover = {};
    const sessionId = state.session?.id;
    if (!sessionId) {
      return { steps: [{ step: 'delete_session', status: 'skipped', reason: 'no_session_created' }], leftover };
    }

    // 1. runtime 已启动（或启动已尝试）→ 精确 stop（agentId + sessionId）
    if (state.runtimeStartAttempted) {
      try {
        await stopManagedAgent(agentId, sessionId);
        steps.push({ step: 'stop_runtime', status: 'ok' });
      } catch (error) {
        const viewerAgentId = resolveSessionViewerAgentId(agentId, sessionId);
        if (viewerAgentId) leftover.viewerAgentId = viewerAgentId;
        steps.push({ step: 'stop_runtime', status: 'failed', error: String(error?.message || error) });
      }
    }

    // 2. thread 已创建 → 关闭。不信编排期的 hook 返回值，重新按
    //    headSessionId 解析——兜底「runtime 未 READY 但 thread 已创建」
    //    的中间态；无线程（hook 未执行 / 非 head）时 skipped。
    let threadRecord = null;
    try {
      threadRecord = await threadControl.core.findThreadByHeadSession(agentId, sessionId);
    } catch (error) {
      steps.push({ step: 'close_thread', status: 'failed', error: String(error?.message || error), phase: 'resolve' });
    }
    if (threadRecord) {
      try {
        await threadControl.core.closeThread(threadRecord.threadId, { reason: 'acp_session_creation_rollback' });
        steps.push({ step: 'close_thread', status: 'ok', threadId: threadRecord.threadId });
      } catch (error) {
        leftover.threadId = threadRecord.threadId;
        steps.push({ step: 'close_thread', status: 'failed', threadId: threadRecord.threadId, error: String(error?.message || error) });
      }
    } else if (!steps.some((step) => step.step === 'close_thread')) {
      steps.push({ step: 'close_thread', status: 'skipped', reason: 'no_thread_for_session' });
    }

    // 3. session 已写入 → 从 index 删除
    try {
      await deletePrebuiltSession(agentId, sessionId, { includeSessions: false });
      steps.push({ step: 'delete_session', status: 'ok' });
    } catch (error) {
      leftover.clawSessionId = sessionId;
      steps.push({ step: 'delete_session', status: 'failed', error: String(error?.message || error) });
    }

    if (Object.keys(leftover).length > 0) leftover.clawSessionId = leftover.clawSessionId || sessionId;
    return { steps, leftover };
  }

  // ── 原子创建 ─────────────────────────────────────────────────────

  app.post('/protoclaw/acp/coder/sessions', express.json(), async (req, res) => {
    try {
      const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
      if (agentId !== ACP_AGENT_ID) {
        res.status(400).json({
          ok: false,
          code: 'agent_not_supported',
          message: `This endpoint only accepts agentId="${ACP_AGENT_ID}" (got: ${JSON.stringify(agentId)})`,
        });
        return;
      }

      const cwd = await validateAcpCwd(req.body?.cwd);

      // 可选 model 参数：解析为预设 name 并写入 coder 启动配置（持久化），
      // 随后 createPrebuiltSession → spawn 从该配置解析启动模型。解析失败
      // （歧义 / 未命中）在创建任何对象之前抛出，零副作用。
      const requestedModel = req.body?.model;
      if (requestedModel !== undefined && (typeof requestedModel !== 'string' || !requestedModel.trim())) {
        throw acpError(400, 'invalid_model', 'model must be a non-empty string when provided');
      }
      const presetName = await resolveAcpModelPreset(requestedModel, { presetsPath: ctx.acpPresetsPath });
      if (presetName) {
        await applyAcpModelPreset(presetName, { configPath: ctx.acpModelConfigPath });
      }

      let agent;
      try {
        agent = await requireAgentLight(ACP_WORKSPACE_AGENT_ID);
      } catch (error) {
        res.status(Number(error?.statusCode) || 500).json({
          ok: false,
          code: error?.code || 'agent_unavailable',
          message: String(error?.message || error),
        });
        return;
      }

      const state = { session: null, runtimeStartAttempted: false };
      try {
        const session = await createPrebuiltSession(agent.id, {
          sessionType: ACP_SESSION_TYPE,
          openDirectory: cwd,
          returnSummary: false,
        });
        state.session = session;

        state.runtimeStartAttempted = true;
        await startManagedAgent(agent, session.id);

        // 线程宿主（coder）：新会话自动成为新线程初始 head（与既有
        // /protoclaw/prebuilt_sessions 同一钩子；失败不阻断，由下方
        // store 解析兜底判定 thread_missing）。
        await threadIntegration.onSessionCreated(agent.id, session);

        const readyTimeoutMs = resolveAcpReadyTimeoutMs();
        const ready = await waitForManagedRuntimeReady(agent.id, readyTimeoutMs, session.id);
        if (!ready) {
          throw acpError(504, 'runtime_ready_timeout', `coder runtime not READY within ${readyTimeoutMs}ms (session=${session.id})`);
        }

        const viewerAgentId = resolveSessionViewerAgentId(agent.id, session.id);
        if (!viewerAgentId) {
          throw acpError(500, 'viewer_agent_missing', `READY runtime has no viewerAgentId (session=${session.id})`);
        }

        const threadRecord = await threadControl.core.findThreadByHeadSession(agent.id, session.id);
        if (!threadRecord) {
          throw acpError(500, 'thread_missing', `session created but no thread anchor holds it as head (session=${session.id})`);
        }

        res.status(201).json({
          ok: true,
          clawSessionId: session.id,
          threadId: threadRecord.threadId,
          viewerAgentId,
          cwd,
          ...(presetName ? { modelPreset: presetName } : {}),
        });
      } catch (error) {
        const rollback = await rollbackAcpCreation(agent.id, state);
        res.status(Number(error?.statusCode) || 500).json({
          ok: false,
          code: error?.code || 'acp_session_creation_failed',
          message: String(error?.message || error),
          rollback,
        });
      }
    } catch (error) {
      // cwd 校验等前置失败：无任何副作用，直接回错误。
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_session_creation_failed',
        message: String(error?.message || error),
      });
    }
  });

  // ── 会话发现（线程视角，head 出口）────────────────────────────────

  app.get('/protoclaw/acp/coder/sessions', async (req, res) => {
    try {
      // 可选 cwd 过滤：必须是已存在的目录（与 create/resume 同一校验语义）
      let cwdFilter = null;
      if (req.query.cwd) {
        cwdFilter = acpPathKey(await validateAcpCwd(req.query.cwd));
      }

      const threads = await threadControl.core.listThreads({
        agentId: ACP_WORKSPACE_AGENT_ID,
      });
      const archiveEntries = await threadControl.archive.list().catch(() => ({}));

      const sessions = [];
      for (const thread of Array.isArray(threads) ? threads : []) {
        // 归档是线程层收纳标记：归档线程不出现在 ACP 会话发现中
        if (archiveEntries[thread.threadId]) continue;
        const headSessionId = sanitizeSessionFragment(thread.headSessionId);
        if (!headSessionId) continue;

        // head 会话的持久化记录提供 cwd / 标题。ACP v1 的 SessionInfo.cwd 是
        // 必填 string；cwd 缺失的线程无法通过 resume/load 的 cwd 一致性校验，
        // 对协议客户端不可用——直接跳过（不发送违反 schema 的 cwd:null 条目）。
        let record = null;
        try {
          record = await requirePrebuiltSessionRecord(ACP_WORKSPACE_AGENT_ID, headSessionId);
        } catch (error) {
          if (error?.statusCode !== 404) throw error;
        }
        const openDirectory = record?.openDirectory ? String(record.openDirectory) : null;
        if (!openDirectory) continue;
        if (cwdFilter && (!openDirectory || acpPathKey(openDirectory) !== cwdFilter)) continue;

        sessions.push({
          threadId: thread.threadId,
          sessionId: headSessionId,
          cwd: openDirectory,
          title: thread.title || record?.title || null,
          updatedAt: Number(thread.updatedAt)
            ? new Date(Number(thread.updatedAt)).toISOString()
            : (record?.updatedAt || null),
        });
      }

      res.json({ ok: true, threads: sessions });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_list_failed',
        message: String(error?.message || error),
      });
    }
  });

  // ── 会话续接（成员/head → 线程 head，急切挂载）────────────────────

  app.post('/protoclaw/acp/coder/sessions/:clawSessionId/resume', express.json(), async (req, res) => {
    try {
      const requestedSessionId = sanitizeSessionFragment(req.params.clawSessionId);
      if (!requestedSessionId) {
        throw acpError(400, 'invalid_params', 'clawSessionId is required');
      }

      // 可选 cwd 校验：与该会话持久化的 openDirectory 一致才允许续接
      // （防止客户端拿错目录续接另一个项目的上下文）。大小写/分隔符不敏感。
      let requestCwd = null;
      if (req.body?.cwd !== undefined) {
        requestCwd = await validateAcpCwd(req.body.cwd);
      }
      const sessionRecord = await requirePrebuiltSessionRecord(ACP_WORKSPACE_AGENT_ID, requestedSessionId);
      if (
        requestCwd
        && (!sessionRecord?.openDirectory || acpPathKey(sessionRecord.openDirectory) !== acpPathKey(requestCwd))
      ) {
        throw acpError(403, 'cwd_mismatch', `session ${requestedSessionId} belongs to ${sessionRecord?.openDirectory || '(unknown)'}, not ${requestCwd}`);
      }

      // 成员会话 → 线程 → 当前 head（compact 接力后旧会话自动落到最新上下文）。
      // 先按 head 命中（快路径）；未命中再经 thread-integration 的成员链扫描
      // （sessionChain 全成员匹配，与 input-gateway 非 head 投递路由同源语义）。
      let threadRecord = await threadControl.core.findThreadByHeadSession(
        ACP_WORKSPACE_AGENT_ID,
        requestedSessionId,
      );
      if (!threadRecord && typeof threadIntegration?.findThreadBySession === 'function') {
        threadRecord = await threadIntegration.findThreadBySession(
          ACP_WORKSPACE_AGENT_ID,
          requestedSessionId,
        );
      }
      if (!threadRecord) {
        throw acpError(404, 'thread_not_found', `no thread holds session ${requestedSessionId} as member or head`);
      }
      const headSessionId = sanitizeSessionFragment(threadRecord.headSessionId);
      if (!headSessionId) {
        throw acpError(500, 'thread_head_missing', `thread ${threadRecord.threadId} has no head session`);
      }

      // 归档线程拒绝续接（先取消归档才能继续）；判定与 gateway / commands
      // / deliver 四入口共享 archive 单点事实
      const archiveRejection = await threadControl.archive.resolveCommandRejection(threadRecord.threadId);
      if (archiveRejection) {
        throw acpError(archiveRejection.status, archiveRejection.code, `thread ${threadRecord.threadId} is archived; unarchive it first`);
      }

      // closed 为硬终态（框架无 unclose）：与 archived 同为「线程域禁入」
      // 的客观事实；成员会话历史仍可经 session/load 只读回放，续接不可达
      if (threadRecord.status === 'closed') {
        throw acpError(409, 'thread_closed', `thread ${threadRecord.threadId} is closed`);
      }

      // 急切挂载：runtime 已运行则幂等复用，否则启动并等 READY（错误前置，
      // 不把失败拖到第一次 prompt）
      let agent;
      try {
        agent = await requireAgentLight(ACP_WORKSPACE_AGENT_ID);
      } catch (error) {
        throw Object.assign(error, { statusCode: Number(error?.statusCode) || 500 });
      }
      await startManagedAgent(agent, headSessionId);
      const readyTimeoutMs = resolveAcpReadyTimeoutMs();
      const ready = await waitForManagedRuntimeReady(ACP_WORKSPACE_AGENT_ID, readyTimeoutMs, headSessionId);
      if (!ready) {
        throw acpError(504, 'runtime_ready_timeout', `coder runtime not READY within ${readyTimeoutMs}ms (session=${headSessionId})`);
      }
      const viewerAgentId = resolveSessionViewerAgentId(ACP_WORKSPACE_AGENT_ID, headSessionId);
      if (!viewerAgentId) {
        throw acpError(500, 'viewer_agent_missing', `READY runtime has no viewerAgentId (session=${headSessionId})`);
      }

      res.json({
        ok: true,
        clawSessionId: headSessionId,
        threadId: threadRecord.threadId,
        viewerAgentId,
        cwd: sessionRecord?.openDirectory ? String(sessionRecord.openDirectory) : null,
      });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_resume_failed',
        message: String(error?.message || error),
      });
    }
  });

  // ── 会话历史读取（session/load 的数据面；控制面 = resume）────────

  /**
   * 把快照消息投影为可回放形态：user/assistant/tool 三类，只保留回放
   * 所需字段。system 提示、reasoning、turn/usage 等内部字段一律不外放
   * （设计 §4.8 回放粒度：grill Q3 方案 2）。
   */
  function projectSessionMessagesForReplay(messages) {
    const out = [];
    for (const msg of Array.isArray(messages) ? messages : []) {
      if (!msg || typeof msg !== 'object') continue;
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (content) out.push({ role: 'user', content });
      } else if (msg.role === 'assistant') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const toolCalls = Array.isArray(msg.toolCalls)
          ? msg.toolCalls
            .filter((tc) => tc && typeof tc === 'object' && tc.id)
            .map((tc) => ({
              id: String(tc.id),
              name: typeof tc.name === 'string' ? tc.name : '',
              arguments: tc.arguments && typeof tc.arguments === 'object' ? tc.arguments : {},
            }))
          : [];
        if (content || toolCalls.length) {
          out.push(toolCalls.length ? { role: 'assistant', content, toolCalls } : { role: 'assistant', content });
        }
      } else if (msg.role === 'tool') {
        const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
        const content = typeof msg.content === 'string' ? msg.content : '';
        if (toolCallId) out.push({ role: 'tool', toolCallId, content });
      }
    }
    return out;
  }

  app.get('/protoclaw/acp/coder/sessions/:clawSessionId/history', async (req, res) => {
    const clawSessionId = sanitizeSessionFragment(req.params.clawSessionId);
    try {
      if (!clawSessionId) {
        throw acpError(400, 'invalid_params', 'clawSessionId is required');
      }
      await requirePrebuiltSessionRecord(ACP_WORKSPACE_AGENT_ID, clawSessionId);
      const snapshot = await readSessionSnapshotForContinuity(ACP_WORKSPACE_AGENT_ID, clawSessionId);
      if (!snapshot) {
        throw acpError(404, 'session_snapshot_missing', `session file for ${clawSessionId} is missing or unreadable`);
      }
      const messages = projectSessionMessagesForReplay(snapshot?.runtime?.context?.messages);
      res.json({ ok: true, sessionId: clawSessionId, messages });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_history_failed',
        message: String(error?.message || error),
      });
    }
  });

  // ── 精确中断 ─────────────────────────────────────────────────────

  app.post('/protoclaw/acp/coder/sessions/:clawSessionId/interrupt', express.json(), async (req, res) => {
    const clawSessionId = sanitizeSessionFragment(req.params.clawSessionId);
    try {
      const viewerAgentId = resolveSessionViewerAgentId(ACP_WORKSPACE_AGENT_ID, clawSessionId);
      if (!viewerAgentId) {
        res.status(404).json({
          ok: false,
          code: 'runtime_not_found',
          message: `No running coder runtime is bound to session ${clawSessionId}`,
        });
        return;
      }

      // 现有 /api/agents/:id/interrupt 同链路：ViewerWorker interrupt 端点
      // （服务端 handler 内固定下发 UDS { type: 'interrupt-agent',
      // clearQueue: true }——同时取消 active call 与已排队 user-turn）。
      let response;
      try {
        response = await fetch(
          `${VIEWER_ORIGIN}/api/agents/${encodeURIComponent(viewerAgentId)}/interrupt`,
          { method: 'POST' },
        );
      } catch (error) {
        res.status(502).json({
          ok: false,
          code: 'viewer_unreachable',
          message: `Failed to reach ViewerWorker interrupt chain: ${String(error?.message || error)}`,
        });
        return;
      }

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        res.status(502).json({
          ok: false,
          code: 'viewer_interrupt_failed',
          message: `ViewerWorker interrupt returned ${response.status}`,
          viewerBody: body,
        });
        return;
      }

      res.json({ ok: true, clawSessionId, viewerAgentId });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_interrupt_failed',
        message: String(error?.message || error),
      });
    }
  });

  // ── 精确停止（session/close 的数据面；控制面与取消状态机在 adapter）──

  app.post('/protoclaw/acp/coder/sessions/:clawSessionId/stop', express.json(), async (req, res) => {
    const clawSessionId = cleanSessionText(req.params.clawSessionId);
    try {
      if (!clawSessionId) {
        throw acpError(400, 'invalid_params', 'clawSessionId is required');
      }
      // 与 interrupt 同一寻址语义：resolveSessionViewerAgentId 含
      // selectedSessionId 扫描兜底（shared 进程注册键漂移 / 线程接力后 head
      // 换代时注册键上没有新 head 条目，selectedSessionId 才是绑定事实）。
      // 找不到 viewer 说明该会话确无运行中 runtime —— 幂等成功。
      // 命中则按条目的注册键停（getAgentRuntime 只按注册键查找；shared 模式
      // remove-session 也依赖条目自身状态）。thread / session 持久数据不动
      // ——归档是 Claw 管理面的动作，不经此层。
      const viewerAgentId = resolveSessionViewerAgentId(ACP_WORKSPACE_AGENT_ID, clawSessionId);
      if (viewerAgentId) {
        const runtimeEntry = getRuntimeByViewerAgentId(viewerAgentId);
        await stopManagedAgent(
          ACP_WORKSPACE_AGENT_ID,
          runtimeEntry?.selectedSessionId || clawSessionId,
        );
      }
      res.json({ ok: true, clawSessionId });
    } catch (error) {
      res.status(Number(error?.statusCode) || 500).json({
        ok: false,
        code: error?.code || 'acp_stop_failed',
        message: String(error?.message || error),
      });
    }
  });
}
