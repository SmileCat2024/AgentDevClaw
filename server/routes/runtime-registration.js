/**
 * runtime-registration.js — 外部 runtime 平台注册协议（ADR-0037 决策 4）
 *
 * 托管 runtime 的归属经 spawn 内嵌 IPC 握手（ADR-0010 修订一：归属先于
 * Viewer 可见性）；外部 runtime（TCP / 容器接入）没有父子 IPC 通道，经本
 * 协议向平台声明身份：
 *
 *   POST /protoclaw/runtime/register        外部 runtime 注册（机器通道）
 *   POST /protoclaw/runtime/exited           外部 runtime 退出上报（机器通道）
 *   POST /protoclaw/external_runtime/stop    前端停止通道（浏览器会话）
 *
 * register 携可选 ticket 时走托管容器身份交接路径（ADR-0037 M6，见
 * runtime-spawn-tickets.js）：不建外部记录、不受冒充规则约束；exited 携
 * sessionId 时向对应容器 handle 转发 session-exited 语义事件。
 *
 * 机器通道无条件要求 internal bearer token（与 ViewerWorker TCP 控制通道
 * 同口径），不受登录保护开关影响——server 监听全部网卡，登录保护未启用时
 * 全局中间件放行 /protoclaw 域，机器通道的信任不能依赖该开关。注册应在
 * runtime 连接 ViewerWorker 之前完成并等 accepted，保持与托管 IPC 握手同
 * 次序；停止指令经 ViewerWorker 连接下发（POST /api/agents/:id/stop →
 * stop-agent 消息），runtime 宿主注册停止回调决定优雅退出路径。
 */
import { authenticateInternalToken } from '../auth.js';
import { getRuntimeByViewerAgentId } from '../shared/agent-access.js';
import { cleanSessionText } from '../shared/string-helpers.js';
import {
  registerExternalRuntime,
  removeExternalRuntime,
  getExternalRuntime,
} from '../shared/external-runtime-registry.js';
import { consumeManagedSpawnTicket } from '../shared/runtime-spawn-tickets.js';

// viewerAgentId 是 ViewerWorker 注册表的键与 URL 片段：限制为既有 fragment
// 语法（agent-access 同一字符集），拒绝而不是静默改写，避免注册键与实际
// viewer 注册身份错位。
const VIEWER_AGENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function extractViewerAgentId(value) {
  const trimmed = cleanSessionText(value);
  return VIEWER_AGENT_ID_PATTERN.test(trimmed) ? trimmed : '';
}

export function setupRuntimeRegistrationRoutes(app, express, deps = {}) {
  const {
    viewerOrigin,
    // 预检回调：返回 prebuilt agent id 列表，用于保留身份冲突拒绝。
    getPrebuiltAgentIds = async () => [],
  } = deps;

  const jsonParser = express.json({ limit: '16kb' });

  function requireInternalToken(req, res) {
    if (authenticateInternalToken(req)) return true;
    res.status(401).json({ ok: false, error: 'Internal token required', code: 'AUTH_REQUIRED' });
    return false;
  }

  app.post('/protoclaw/runtime/register', jsonParser, async (req, res, next) => {
    try {
      if (!requireInternalToken(req, res)) return;
      const viewerAgentId = extractViewerAgentId(req.body?.viewerAgentId);
      if (!viewerAgentId) {
        res.status(400).json({
          ok: false,
          error: 'viewerAgentId is required ([A-Za-z0-9_-], max 128 chars)',
          code: 'INVALID_RUNTIME_IDENTITY',
        });
        return;
      }
      // ── 托管容器身份交接（ADR-0037 M6）──────────────────────
      // 携 ticket = 托管 spawn 的容器 runtime：宿主启动容器前已签发 ticket 并
      // 建 pending 交接回调，注册即身份交接（等价本地 IPC 的 runtime-identity
      // + accepted），不占用外部 runtime 注册表、不受下方冒充规则约束——其
      // viewerAgentId 是框架分配的唯一实例 id，归属由 ticket 证明。
      const ticket = cleanSessionText(req.body?.ticket);
      if (ticket) {
        const handled = await consumeManagedSpawnTicket({
          ticket,
          agentId: cleanSessionText(req.body?.agentId),
          sessionId: cleanSessionText(req.body?.sessionId),
          viewerAgentId,
        });
        if (!handled) {
          res.status(409).json({
            ok: false,
            error: 'Runtime ticket is invalid, expired, or mismatched',
            code: 'INVALID_RUNTIME_TICKET',
          });
          return;
        }
        res.json({ ok: true, accepted: true, viewerAgentId });
        return;
      }
      // 身份冲突拒绝：viewerAgentId 不得占用运行中托管 runtime 或 prebuilt
      // APP 身份，防止冒充托管身份混入侧栏投影。
      if (getRuntimeByViewerAgentId(viewerAgentId)) {
        res.status(409).json({
          ok: false,
          error: 'viewerAgentId is claimed by a managed runtime',
          code: 'VIEWER_AGENT_ID_CONFLICT',
        });
        return;
      }
      const prebuiltIds = await getPrebuiltAgentIds();
      if (prebuiltIds.some((id) => cleanSessionText(id) === viewerAgentId)) {
        res.status(409).json({
          ok: false,
          error: 'viewerAgentId is reserved by a prebuilt agent',
          code: 'VIEWER_AGENT_ID_CONFLICT',
        });
        return;
      }
      const record = registerExternalRuntime({
        viewerAgentId,
        name: cleanSessionText(req.body?.name),
        projectRoot: cleanSessionText(req.body?.projectRoot),
      });
      res.json({ ok: true, accepted: true, viewerAgentId: record.viewerAgentId });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/runtime/exited', jsonParser, (req, res) => {
    if (!requireInternalToken(req, res)) return;
    const viewerAgentId = extractViewerAgentId(req.body?.viewerAgentId);
    if (!viewerAgentId) {
      res.status(400).json({
        ok: false,
        error: 'viewerAgentId is required ([A-Za-z0-9_-], max 128 chars)',
        code: 'INVALID_RUNTIME_IDENTITY',
      });
      return;
    }
    // 幂等：未注册的退出上报同样回 ok（runtime 可能在 server 重启后退出）。
    // 托管容器形态的 session 级退役上报（ADR-0037 M6）：sessionId 附带时，
    // 转发给对应容器 handle 的语义事件面（emitHostEvent 仅容器后端实现），
    // 宿主消费面与本地 IPC 的 session-exited 完全同构。
    const sessionId = cleanSessionText(req.body?.sessionId);
    if (sessionId) {
      const runtime = getRuntimeByViewerAgentId(viewerAgentId);
      if (typeof runtime?.process?.emitHostEvent === 'function') {
        runtime.process.emitHostEvent('session-exited', {
          sessionId,
          persisted: req.body?.persisted === true,
        });
      }
    }
    removeExternalRuntime(viewerAgentId);
    res.json({ ok: true });
  });

  app.post('/protoclaw/external_runtime/stop', jsonParser, async (req, res, next) => {
    try {
      const viewerAgentId = extractViewerAgentId(req.body?.runtimeId);
      const record = viewerAgentId ? getExternalRuntime(viewerAgentId) : null;
      if (!record) {
        res.status(404).json({
          ok: false,
          error: 'External runtime is not registered',
          code: 'RUNTIME_NOT_REGISTERED',
        });
        return;
      }
      let viewerResponse;
      try {
        viewerResponse = await fetch(
          `${viewerOrigin}/api/agents/${encodeURIComponent(record.viewerAgentId)}/stop`,
          { method: 'POST' },
        );
      } catch (error) {
        res.status(502).json({
          ok: false,
          error: `ViewerWorker unreachable: ${error?.message || error}`,
          code: 'VIEWER_UNREACHABLE',
        });
        return;
      }
      if (viewerResponse.status === 404 || viewerResponse.status === 409) {
        // runtime 已不在连接上：注册记录失去停止目标，顺带收敛记录。
        removeExternalRuntime(record.viewerAgentId);
        res.status(409).json({
          ok: false,
          error: 'Agent runtime is not connected',
          code: 'runtime_not_accepting_input',
        });
        return;
      }
      if (!viewerResponse.ok) {
        res.status(502).json({
          ok: false,
          error: `ViewerWorker stop failed: HTTP ${viewerResponse.status}`,
          code: 'VIEWER_STOP_FAILED',
        });
        return;
      }
      // 停止是请求不是结果：完成以连接断开与退出上报为准。
      res.json({ ok: true, status: 'stop-requested', viewerAgentId: record.viewerAgentId });
    } catch (error) {
      next(error);
    }
  });
}
