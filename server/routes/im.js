/**
 * IM workspace management: route setup.
 *
 * Extracted from server.js Phase 4.
 * Config normalization & readers/writers → im-config.js
 * Bundle aggregation & weixin binding    → im-workspace-bundle.js
 *
 * Dependencies injected via ctx (only needed inside setupIMRoutes):
 *   stopManagedAgent, requireAgentLight, startManagedAgent,
 *   waitForProcessExit, getAgentsLight, readViewerJson
 *
 * Exports for server.js consumption:
 *   readProjectIMWorkspaceConfig (re-export), getPortalAgentDisplayName (re-export),
 *   setupIMRoutes
 * Re-exports for backward compatibility (tests, other consumers):
 *   normalizeIMWorkspaceConfig, createConfigSerializer,
 *   getUsageContextTokens, findLine, resolveLineTransferConflict, resolveCarrierConflicts
 */

import { APP_QQBOT_CONFIG_PATH } from '../shared/constants.js';
import { listAgentRuntimes } from '../shared/agent-access.js';
import { readSessionIndex, readSessionIndexSync } from '../shared/session-access.js';
import { sendIPCtoSession } from '../shared/ipc.js';
import { resolveSessionModelInfo } from './model-config.js';
import { getProjectAdapter } from './dispatch.js';
import { getRuntimeExecutionState } from '../runtime-call-envelope.js';

import {
  readProjectQQBotConfig,
  writeProjectQQBotConfig,
  readProjectIMWorkspaceConfig,
  writeProjectIMWorkspaceConfig,
  operatorCarrierOf,
  writeProjectFeishuConfig,
  writeProjectWecomConfig,
  writeProjectRokidConfig,
  withIMWorkspaceConfig,
} from './im-config.js';
import { assertThreadBindable } from '../thread-control/input-gateway.js';
import { getThreadIntegration } from '../thread-control/thread-integration.js';

import {
  buildIMWorkspaceBundle,
  startWeixinBinding,
  refreshWeixinBinding,
  clearWeixinBinding,
  getUsageContextTokens,
  findLine,
  resolveLineTransferConflict,
  resolveCarrierConflicts,
} from './im-workspace-bundle.js';

// Re-exports for backward compatibility — allows existing imports from
// './server/routes/im.js' to continue working after the split.
export { normalizeIMWorkspaceConfig, getPortalAgentDisplayName, createConfigSerializer, findOperatorLines, operatorCarrierOf } from './im-config.js';
export { readProjectIMWorkspaceConfig } from './im-config.js';
export { getUsageContextTokens, findLine, resolveLineTransferConflict, resolveCarrierConflicts } from './im-workspace-bundle.js';

// ── Route setup ───────────────────────────────────────────────────

export function setupIMRoutes(app, express, ctx) {
  const {
    stopManagedAgent,
    requireAgentLight,
    startManagedAgent,
    waitForProcessExit,
    getAgentsLight,
    readViewerJson,
  } = ctx;

  // ── QQBot Config ────────────────────────────────────────────────

  app.get('/protoclaw/qqbot_config', async (_req, res, next) => {
    try {
      const config = await readProjectQQBotConfig();
      res.json({
        config,
        configured: !!(config.appId && config.clientSecret),
        sourcePath: APP_QQBOT_CONFIG_PATH,
      });
    } catch (error) {
      next(error);
    }
  });

  app.put('/protoclaw/qqbot_config', express.json(), async (req, res, next) => {
    try {
      const config = await writeProjectQQBotConfig(req.body || {});
      res.json({
        config,
        configured: !!(config.appId && config.clientSecret),
        sourcePath: APP_QQBOT_CONFIG_PATH,
        savedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // ── IM Workspace Bundle ─────────────────────────────────────────

  app.get('/protoclaw/im_workspace_bundle', async (_req, res, next) => {
    try {
      const bundle = await buildIMWorkspaceBundle('qqbot');
      res.json(bundle);
    } catch (error) {
      next(error);
    }
  });

  app.put('/protoclaw/im_workspace_bundle', express.json(), async (req, res, next) => {
    try {
      const prevConfig = await readProjectIMWorkspaceConfig();
      const workspaceConfig = await writeProjectIMWorkspaceConfig(req.body?.workspaceConfig || {});
      const qqConfig = await writeProjectQQBotConfig(req.body?.qqConfig || {});
      const feishuConfig = await writeProjectFeishuConfig(req.body?.feishuConfig || {});
      const wecomConfig = await writeProjectWecomConfig(req.body?.wecomConfig || {});
      const rokidConfig = await writeProjectRokidConfig(req.body?.rokidConfig || {});

      // ADR-0042：门户渠道 = 接线员线路 carrier。重启触发条件从 selectedChannel
      // 变化改为首要接线员 carrier 变化（多线路并发连接到位前的过渡语义）。
      const prevCarrier = operatorCarrierOf(prevConfig);
      const newCarrier = operatorCarrierOf(workspaceConfig);
      const channelChanged = newCarrier !== prevCarrier;
      let portalRestarted = false;

      // Carrier 互斥：保存的配置里线路间 carrier 冲突统一清理（接线员线路也是线路）
      if (resolveCarrierConflicts(workspaceConfig)) {
        await writeProjectIMWorkspaceConfig(workspaceConfig);
      }

      if (channelChanged) {
        const runtimes = listAgentRuntimes('qqbot');
        const running = runtimes.filter((rt) => rt?.process && rt.process.exitCode === null && !rt.stopped);
        if (running.length > 0) {
          await stopManagedAgent('qqbot');
          for (const rt of running) {
            await waitForProcessExit(rt.process);
          }
          if (newCarrier) {
            // 接线员 carrier 切换到非空渠道: restart
            try {
              const agent = await requireAgentLight('qqbot');
              await startManagedAgent(agent);
              portalRestarted = true;
              console.log(`[ProtoClaw IM] 接线员渠道切换: ${prevCarrier || '(空)'} → ${newCarrier}，门户代理已重启`);
            } catch (restartErr) {
              console.error('[ProtoClaw IM] 门户代理重启失败:', restartErr);
            }
          } else {
            // 接线员线路清空: stop without restart
            console.log('[ProtoClaw IM] 接线员线路已清空，门户代理已停止');
          }
        }
      }

      const bundle = await buildIMWorkspaceBundle('qqbot');
      res.json({
        ...bundle,
        savedAt: new Date().toISOString(),
        portalRestarted,
      });
    } catch (error) {
      next(error);
    }
  });

  // ── Weixin Binding ──────────────────────────────────────────────

  app.post('/protoclaw/im_workspace_bundle/weixin_bind/start', async (_req, res, next) => {
    try {
      const binding = await startWeixinBinding('qqbot');
      const bundle = await buildIMWorkspaceBundle('qqbot');
      res.json({
        ...bundle,
        binding,
        savedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/protoclaw/im_workspace_bundle/weixin_bind/status', async (_req, res, next) => {
    try {
      const binding = await refreshWeixinBinding('qqbot');
      const bundle = await buildIMWorkspaceBundle('qqbot');
      res.json({
        ...bundle,
        binding,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/protoclaw/im_workspace_bundle/weixin_logout', async (_req, res, next) => {
    try {
      const binding = await clearWeixinBinding('qqbot');
      const bundle = await buildIMWorkspaceBundle('qqbot');
      res.json({
        ...bundle,
        binding,
        savedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // ── IM Line Transfer ────────────────────────────────────────────
  //
  // A "line" (通道) binds to a carrier (渠道: qq/weixin) and optionally to
  // a target agent session.  The portal agent (receptionist) has its own
  // carrier binding via `selectedChannel`; these endpoints manage the
  // additional logical lines.

  app.post('/protoclaw/im_line_transfer', express.json(), async (req, res, next) => {
    try {
      // ADR-0042 决策 1：线路绑定线程寻址（agentId + threadId 成对出现）。
      // 接线员线程（agentId=qqbot）是合法目标——门户渠道线路就是绑定接线员
      // 线程的线路。
      const { lineId, carrier, agentId, threadId } = req.body || {};
      if (!lineId) {
        return res.status(400).json({ error: 'lineId is required' });
      }
      if (carrier && (agentId || threadId) && !(agentId && threadId)) {
        return res.status(400).json({ error: 'agentId and threadId must be provided together' });
      }

      // Validate thread BEFORE mutating config (fail fast, outside serializer).
      // 判定与 input-gateway 投递接受性同源（assertThreadBindable）。
      if (carrier && agentId && threadId) {
        try {
          const thread = await assertThreadBindable(threadId);
          if (String(thread.agentId || '').trim() !== String(agentId).trim()) {
            return res.status(400).json({ error: 'threadId does not belong to agentId' });
          }
        } catch (verdict) {
          return res.status(verdict.status || 409).json({
            error: verdict.message || 'Target thread is not accepting bindings',
            code: verdict.code || 'thread_not_bindable',
          });
        }
      }

      // Serialized read-modify-write: prevents concurrent transfers (or
      // concurrent bundle reads that prune stale bindings) from interleaving
      // their file writes and silently overwriting each other's results.
      await withIMWorkspaceConfig((config) => {
        const line = findLine(config, lineId);
        if (!line) {
          throw new Error(`Unknown line: ${lineId}`);
        }

        // If clearing the line (no carrier)
        if (!carrier) {
          line.carrier = '';
          line.boundTarget = null;
          return true;
        }

        line.carrier = carrier;
        line.boundTarget = (agentId && threadId)
          ? { agentId, threadId }
          : null;

        // Enforce carrier exclusivity: clear conflicting lines
        resolveLineTransferConflict(config, { lineId, carrier });

        return true;
      });

      // ADR-0042：载体挂载（mount-im-carrier IPC）已随线程寻址退役——投递
      // 改走线程 Inbox（deliverThreadInput），不再向目标 runtime 挂渠道载体。

      const bundle = await buildIMWorkspaceBundle('qqbot');
      res.json({ success: true, bundle });
    } catch (error) {
      if (error.message?.startsWith('Unknown line:')) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  app.post('/protoclaw/im_line_disconnect', express.json(), async (req, res, next) => {
    try {
      const { lineId } = req.body || {};
      if (!lineId) {
        return res.status(400).json({ error: 'lineId is required' });
      }

      // Serialized read-modify-write
      let prevBinding = null;
      await withIMWorkspaceConfig((config) => {
        const line = findLine(config, lineId);
        if (!line) {
          throw new Error(`Unknown line: ${lineId}`);
        }

        line.boundTarget = null;
        return true;
      });

      // ADR-0042：载体挂载退役，断开不再有 unmount IPC 副作用。

      const bundle = await buildIMWorkspaceBundle('qqbot');
      res.json({ success: true, bundle });
    } catch (error) {
      if (error.message?.startsWith('Unknown line:')) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  // ── IM Routable Targets ─────────────────────────────────────────
  //
  // ADR-0042：可绑定线程投影（threads 全局库派生）+ 当前线路绑定。

  app.get('/protoclaw/im_routable_targets', async (_req, res, next) => {
    try {
      const integration = getThreadIntegration();
      const [allThreads, archivedMap, agents] = await Promise.all([
        integration.core.listThreads({}),
        integration.archive.list().catch(() => ({})),
        getAgentsLight(),
      ]);
      const archived = new Set(Object.keys(archivedMap || {}));
      const agentNameById = new Map(agents.map(a => [a.id, a.name || a.id]));
      const threads = allThreads
        .filter(t => t.status !== 'closed' && !archived.has(t.threadId))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map(t => ({
          threadId: t.threadId,
          agentId: t.agentId,
          agentName: agentNameById.get(t.agentId) || t.agentId,
          title: t.title || t.headSessionId,
          status: t.status,
          updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : null,
          headSessionId: t.headSessionId,
        }));

      // 线路投影：绑定信息按 boundTarget（线程寻址）
      const config = await readProjectIMWorkspaceConfig();
      const threadById = new Map(allThreads.map(t => [t.threadId, t]));
      const lines = (config.lines || []).map(l => {
        const bound = l.boundTarget;
        let boundThread = null;
        if (bound?.threadId) {
          const t = threadById.get(bound.threadId);
          boundThread = {
            agentId: bound.agentId,
            threadId: bound.threadId,
            threadTitle: t?.title || bound.threadId,
            status: t?.status || 'unknown',
          };
        }
        return { id: l.id, name: l.name || l.id, carrier: l.carrier || null, boundThread };
      });

      res.json({ workspaces: activeWorkspaces, lines });
    } catch (error) {
      next(error);
    }
  });
}
