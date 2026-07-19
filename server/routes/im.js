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
 *   getUsageContextTokens, findLine, resolveLineTransferConflict, resolvePortalChannelConflict
 */

import { PROJECT_QQBOT_CONFIG_PATH, IM_IPC_MOUNT_RETRY_MS } from '../shared/constants.js';
import { getAgentRuntime, listAgentRuntimes, getManagedRuntimeKey } from '../shared/agent-access.js';
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
  writeProjectFeishuConfig,
  writeProjectWecomConfig,
  writeProjectRokidConfig,
  withIMWorkspaceConfig,
} from './im-config.js';

import {
  buildIMWorkspaceBundle,
  startWeixinBinding,
  refreshWeixinBinding,
  clearWeixinBinding,
  getUsageContextTokens,
  findLine,
  resolveLineTransferConflict,
  resolvePortalChannelConflict,
} from './im-workspace-bundle.js';

// Re-exports for backward compatibility — allows existing imports from
// './server/routes/im.js' to continue working after the split.
export { normalizeIMWorkspaceConfig, getPortalAgentDisplayName, createConfigSerializer } from './im-config.js';
export { readProjectIMWorkspaceConfig } from './im-config.js';
export { getUsageContextTokens, findLine, resolveLineTransferConflict, resolvePortalChannelConflict } from './im-workspace-bundle.js';

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
        sourcePath: PROJECT_QQBOT_CONFIG_PATH,
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
        sourcePath: PROJECT_QQBOT_CONFIG_PATH,
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

      const newChannel = workspaceConfig.selectedChannel || '';
      const channelChanged = newChannel !== (prevConfig.selectedChannel || '');
      let portalRestarted = false;

      // Enforce three-way exclusivity: if portal's new channel conflicts with a line, clear that line
      if (channelChanged && newChannel) {
        const conflicted = resolvePortalChannelConflict(workspaceConfig, newChannel);
        if (conflicted) {
          await writeProjectIMWorkspaceConfig(workspaceConfig);
        }
      }

      if (channelChanged) {
        const runtimes = listAgentRuntimes('qqbot');
        const running = runtimes.filter((rt) => rt?.process && rt.process.exitCode === null && !rt.stopped);
        if (running.length > 0) {
          await stopManagedAgent('qqbot');
          for (const rt of running) {
            await waitForProcessExit(rt.process);
          }
          if (newChannel) {
            // Channel switched to a different non-empty channel: restart
            try {
              const agent = await requireAgentLight('qqbot');
              await startManagedAgent(agent);
              portalRestarted = true;
              console.log(`[ProtoClaw IM] 渠道切换: ${prevConfig.selectedChannel || '(空)'} → ${newChannel}，门户代理已重启`);
            } catch (restartErr) {
              console.error('[ProtoClaw IM] 门户代理重启失败:', restartErr);
            }
          } else {
            // Channel set to empty: stop without restart
            console.log('[ProtoClaw IM] 渠道已置空，门户代理已停止');
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

  app.get('/protoclaw/im_line_binding', async (req, res) => {
    const { agentId: qAgentId, sessionId: qSessionId } = req.query || {};
    if (!qAgentId || !qSessionId) {
      return res.json({ carrier: null });
    }
    try {
      const config = await readProjectIMWorkspaceConfig();
      const match = (config.lines || []).find(
        l => l.carrier && l.boundSession && l.boundSession.agentId === qAgentId && l.boundSession.sessionId === qSessionId
      );
      if (match) {
        const rt = getAgentRuntime(qAgentId, qSessionId);
        if (!rt?.process || rt.process.exitCode !== null || rt.stopped) {
          res.json({ carrier: null });
          return;
        }
      }
      res.json(match ? { carrier: match.carrier, lineId: match.id } : { carrier: null });
    } catch {
      res.json({ carrier: null });
    }
  });

  app.post('/protoclaw/im_line_transfer', express.json(), async (req, res, next) => {
    try {
      const { lineId, carrier, agentId, sessionId } = req.body || {};
      if (!lineId) {
        return res.status(400).json({ error: 'lineId is required' });
      }
      if (carrier && agentId === 'qqbot') {
        return res.status(400).json({ error: 'Portal agent sessions cannot be used as IM transfer targets' });
      }

      // Validate runtime BEFORE mutating config (fail fast, outside serializer)
      if (carrier && agentId && sessionId) {
        const runtime = getAgentRuntime(agentId, sessionId);
        if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
          return res.status(409).json({ error: 'Target runtime is not running' });
        }
      }

      // Serialized read-modify-write: prevents concurrent transfers (or
      // concurrent bundle reads that prune stale bindings) from interleaving
      // their file writes and silently overwriting each other's results.
      let prevBinding = null;
      await withIMWorkspaceConfig((config) => {
        const line = findLine(config, lineId);
        if (!line) {
          throw new Error(`Unknown line: ${lineId}`);
        }

        prevBinding = line.boundSession ? { ...line.boundSession } : null;

        // If clearing the line (no carrier)
        if (!carrier) {
          line.carrier = '';
          line.boundSession = null;
          return true;
        }

        if (agentId && sessionId) {
          line.carrier = carrier;
          line.boundSession = { agentId, sessionId };
        } else {
          line.carrier = carrier;
          line.boundSession = null;
        }

        // Enforce three-way exclusivity: clear conflicting entities
        resolveLineTransferConflict(config, { lineId, carrier });

        return true;
      });

      // After config write: handle IPC side-effects
      // Unmount from the OLD session (if different from new)
      if (prevBinding?.agentId && prevBinding?.sessionId) {
        const isSameSession = (agentId && sessionId
          && prevBinding.agentId === agentId && prevBinding.sessionId === sessionId);
        if (!isSameSession) {
          sendIPCtoSession(prevBinding.agentId, prevBinding.sessionId, { type: 'unmount-im-carrier' });
        }
      }

      // Dynamically mount carrier on the TARGET session via IPC (no restart)
      if (carrier && agentId && sessionId) {
        const mountOK = sendIPCtoSession(agentId, sessionId, { type: 'mount-im-carrier', carrier });
        if (!mountOK) {
          // Retry once after a short delay — the target runtime might still
          // be starting up and its IPC channel not yet ready.
          console.warn(`[ProtoClaw IM] IPC mount to ${agentId}::${sessionId} failed, retrying in 1.5s...`);
          setTimeout(() => {
            const retryOK = sendIPCtoSession(agentId, sessionId, { type: 'mount-im-carrier', carrier });
            if (!retryOK) {
              console.error(`[ProtoClaw IM] IPC mount retry also failed for ${agentId}::${sessionId}`);
            }
          }, IM_IPC_MOUNT_RETRY_MS);
        }
      }

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

        prevBinding = line.boundSession || null;
        line.boundSession = null;
        return true;
      });

      // Notify the previously bound session to unmount its carrier via IPC
      if (prevBinding?.agentId && prevBinding?.sessionId) {
        try {
          sendIPCtoSession(prevBinding.agentId, prevBinding.sessionId, { type: 'unmount-im-carrier' });
        } catch (ipcErr) {
          console.error('[ProtoClaw IM] IPC unmount failed:', ipcErr);
        }
      }

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
  // Aggregated view for the operator feature: workspaces → projects → running
  // sessions, plus current line bindings.

  app.get('/protoclaw/im_routable_targets', async (_req, res, next) => {
    try {
      const [agents, imConfig] = await Promise.all([
        getAgentsLight(),
        readProjectIMWorkspaceConfig(),
      ]);

      // Build workspace → project → session tree
      const workspaces = [];
      for (const agent of agents) {
        if (agent.id === 'qqbot') continue;
        const adapter = getProjectAdapter(agent.id);

        let projects;
        if (adapter) {
          try {
            projects = await adapter.listProjects();
          } catch {
            projects = [];
          }
        } else if (agent.id === 'work-group') {
          projects = [{
            id: 'work-group-admin',
            name: '管理员会话',
            type: 'workspace',
            config: {},
            sessionIds: listAgentRuntimes(agent.id)
              .filter(rt => rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId)
              .map(rt => rt.selectedSessionId),
            latestSessionId: null,
            createdAt: null,
            updatedAt: null,
          }];
        } else {
          continue;
        }
        if (!projects || projects.length === 0) continue;

        // Enrich each project with running sessions
        const runtimes = listAgentRuntimes(agent.id);
        const liveSessionKeys = new Set(
          runtimes
            .filter(rt => rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId)
            .map(rt => getManagedRuntimeKey(agent.id, rt.selectedSessionId))
        );

        // Batch-query ViewerWorker callActive + collect workdir for live runtimes.
        // The envelope-based getRuntimeExecutionState() only tracks the dispatch
        // path; normal messages (viewer-input, IM) bypass it entirely, so we must
        // ask the ViewerWorker for the real busy state.
        const callActiveMap = new Map();   // sessionId → boolean
        const workdirMap = new Map();      // sessionId → workdir string
        await Promise.all(
          runtimes
            .filter(rt => rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId)
            .map(async (rt) => {
              const sid = rt.selectedSessionId;
              if (rt.workspaceDir) {
                workdirMap.set(sid, rt.workspaceDir);
              }
              if (rt.viewerAgentId) {
                try {
                  const notif = await readViewerJson(`/api/agents/${encodeURIComponent(rt.viewerAgentId)}/notification`);
                  callActiveMap.set(sid, notif?.callActive === true);
                } catch {
                  callActiveMap.set(sid, false);
                }
              } else {
                callActiveMap.set(sid, false);
              }
            })
        );

        // Get session metadata from the session index
        let sessionIndex;
        try {
          sessionIndex = await readSessionIndex(agent.id);
        } catch {
          sessionIndex = { sessions: [] };
        }
        const sessionMetaMap = new Map(
          (sessionIndex.sessions || []).map(s => [s.id, s])
        );

        // Resolve model info once per agent
        const modelInfoCache = new Map();
        const getAgentModelInfo = async (sessionType) => {
          const key = sessionType || 'default';
          if (!modelInfoCache.has(key)) {
            modelInfoCache.set(key, await resolveSessionModelInfo(agent.id, key));
          }
          return modelInfoCache.get(key);
        };

        for (const project of projects) {
          const projectSessionIds = project.sessionIds || [];
          const projectSessions = [];

          const buildSessionEntry = async (sid) => {
            const meta = sessionMetaMap.get(sid);
            const sessionType = meta?.sessionType || 'main';
            const agentModelInfo = await getAgentModelInfo(sessionType);
            const tokenUsage = meta?.tokenUsage || null;
            const contextTokens = getUsageContextTokens(tokenUsage);
            const contextLength = agentModelInfo.contextLength || null;
            const contextUsagePct = (contextTokens && contextLength)
              ? Math.round(contextTokens / contextLength * 100) : null;
            // Execution state: ViewerWorker callActive is the primary signal;
            // envelope system (dispatch-only) supplements for queue length.
            const rtKey = getManagedRuntimeKey(agent.id, sid);
            const execState = getRuntimeExecutionState(rtKey);
            const callActive = callActiveMap.get(sid) ?? false;
            const savedAt = typeof meta?.savedAt === 'number' ? meta.savedAt : null;
            const sessionWorkdir = workdirMap.get(sid)
              || (typeof meta?.openDirectory === 'string' ? meta.openDirectory.trim() : '')
              || null;
            const realExecStatus = callActive ? 'running'
              : (execState.queueLength > 0 ? 'queued' : execState.status);
            return {
              id: sid,
              title: meta?.title || sid,
              running: true,
              modelName: agentModelInfo.modelName || '',
              contextLength,
              compressRatio: agentModelInfo.compressRatio || 80,
              messageCount: typeof meta?.messageCount === 'number' ? meta.messageCount : null,
              sessionType: meta?.sessionType || null,
              tokenUsage: tokenUsage ? {
                inputTokens: tokenUsage.inputTokens || 0,
                outputTokens: tokenUsage.outputTokens || 0,
                totalTokens: tokenUsage.totalTokens || 0,
              } : null,
              contextTokens,
              contextUsagePct,
              updatedAt: meta?.updatedAt || null,
              savedAt,
              workdir: sessionWorkdir,
              execStatus: realExecStatus,
              execQueueLength: execState.queueLength,
              execLastActiveAt: execState.lastActiveAt,
            };
          };

          if (projectSessionIds.length > 0) {
            for (const sid of projectSessionIds) {
              const key = getManagedRuntimeKey(agent.id, sid);
              if (liveSessionKeys.has(key)) {
                projectSessions.push(await buildSessionEntry(sid));
              }
            }
          } else {
            // When project has no explicit sessionIds, associate all live runtimes
            for (const rt of runtimes) {
              if (rt?.process && rt.process.exitCode === null && !rt.stopped && rt.selectedSessionId) {
                projectSessions.push(await buildSessionEntry(rt.selectedSessionId));
              }
            }
          }
          project.runningSessions = projectSessions;
        }

        workspaces.push({
          agentId: agent.id,
          name: agent.name || agent.id,
          icon: agent.icon || null,
          projects,
        });
      }

      const activeWorkspaces = workspaces;

      // Build current lines snapshot
      const lines = await Promise.all((imConfig.lines || []).map(async l => {
        const bound = l.boundSession;
        let boundSessionInfo = null;
        if (bound?.agentId && bound?.sessionId) {
          try {
            if (bound.agentId === 'qqbot') {
              return {
                id: l.id,
                name: l.name || l.id,
                carrier: l.carrier || null,
                boundSession: null,
              };
            }
            const idx = readSessionIndexSync(bound.agentId);
            const match = (idx?.sessions || []).find(s => s.id === bound.sessionId);
            const sessionTitle = match?.title || bound.sessionId;
            const tokenUsage = match?.tokenUsage || null;
            const boundModelInfo = await resolveSessionModelInfo(bound.agentId, 'default');
            const contextLength = boundModelInfo.contextLength || null;
            const contextTokens = getUsageContextTokens(tokenUsage);
            const contextUsagePct = (contextTokens && contextLength)
              ? Math.round(contextTokens / contextLength * 100) : null;
            const boundRtKey = getManagedRuntimeKey(bound.agentId, bound.sessionId);
            const boundExecState = getRuntimeExecutionState(boundRtKey);
            const boundRuntime = getAgentRuntime(bound.agentId, bound.sessionId);
            let boundCallActive = false;
            if (boundRuntime?.viewerAgentId) {
              try {
                const boundNotif = await readViewerJson(`/api/agents/${encodeURIComponent(boundRuntime.viewerAgentId)}/notification`);
                boundCallActive = boundNotif?.callActive === true;
              } catch {}
            }
            const boundWorkdir = boundRuntime?.workspaceDir
              || (typeof match?.openDirectory === 'string' ? match.openDirectory.trim() : '')
              || null;
            const boundExecStatus = boundCallActive ? 'running'
              : (boundExecState.queueLength > 0 ? 'queued' : boundExecState.status);
            boundSessionInfo = {
              agentId: bound.agentId,
              sessionId: bound.sessionId,
              sessionTitle,
              modelName: boundModelInfo.modelName || '',
              contextLength,
              compressRatio: boundModelInfo.compressRatio || 80,
              contextTokens,
              contextUsagePct,
              workdir: boundWorkdir,
              execStatus: boundExecStatus,
              execQueueLength: boundExecState.queueLength,
              savedAt: typeof match?.savedAt === 'number' ? match.savedAt : null,
            };
          } catch {
            boundSessionInfo = { agentId: bound.agentId, sessionId: bound.sessionId, sessionTitle: bound.sessionId };
          }
        }
        return {
          id: l.id,
          name: l.name || l.id,
          carrier: l.carrier || null,
          boundSession: boundSessionInfo,
        };
      }));

      res.json({ workspaces: activeWorkspaces, lines });
    } catch (error) {
      next(error);
    }
  });
}
