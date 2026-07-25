#!/usr/bin/env node
/**
 * ProtoClaw prebuilt agent runtime.
 *
 * This script owns the runtime contract for internal prebuilt agents:
 * - load the agent class from ProtoClaw's prebuilt source tree
 * - attach to the local ViewerWorker
 * - restore/persist session state in a stable ProtoClaw-owned location
 * - drive the agent through UserInputFeature
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import os from 'os';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { DebugHub, FileSessionStore } from 'agentdev';
import { setTimeout as sleep } from 'timers/promises';
import { importFeatureContinuity } from '../server/context-continuity/feature-continuity.js';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { buildModelUsageMeta, reportUsageEvent } from './usage-report.js';
import { CallArbiter, setDebugHubClass } from '../server/call-arbiter.js';
import { createIMBridge } from './runtime-im-bridge.js';
import { createSummaryHandlers } from './runtime-summary.js';

// Inject DebugHub into the extracted CallArbiter module
setDebugHubClass(DebugHub);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const VIEWER_PORT = parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';
const NO_SESSION_TOKEN = '__protoclaw-no-session__';
const HANDOFF_PATH_ENV = 'PROTOCLAW_HANDOFF_PATH';
const HANDOFF_PAYLOAD_ENV = 'PROTOCLAW_HANDOFF_PAYLOAD';
const WORKSPACE_BOUND_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);
const PREBUILT_AGENT_MAX_TOKENS_CAP = 8000; // 预制 agent maxTokens 上限（应与 server/shared/constants.js 保持一致）
const IS_EXPLORATION = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';
const runtimeInstanceId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const reportedUsageEventIds = new Set();
let resolvedUsageModel = null;

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseHandoffContent(raw, sourceLabel) {
  const text = cleanValue(raw);
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      return { sourceSummary: parsed, seedMessages: [] };
    }
    if (parsed && typeof parsed === 'object') {
      const seedMessages = Array.isArray(parsed.seedMessages)
        ? parsed.seedMessages
            .filter((message) => {
              if (!message || typeof message !== 'object') return false;
              const role = typeof message.role === 'string' ? message.role.trim() : '';
              if (!role) return false;
              const hasContent = message.content != null && message.content !== '';
              const hasToolCalls = Array.isArray(message.toolCalls) && message.toolCalls.length > 0;
              return hasContent || hasToolCalls;
            })
            .map((message) => ({
              ...message,
              role: message.role.trim(),
              turn: Number.isFinite(message.turn) ? Number(message.turn) : null,
            }))
        : [];
      const sourceSummary = cleanValue(
        parsed.sourceSummary
        || parsed.summaryText
        || parsed.summary
        || parsed.handoffSummary
        || parsed.text,
      );
      if (seedMessages.length === 0 && !sourceSummary) {
        throw new Error('missing seedMessages/sourceSummary');
      }
      return {
        packageId: cleanValue(parsed.packageId || parsed.handoffId),
        sourceSessionId: cleanValue(parsed.sourceSessionId),
        sourceSummary,
        seedMessages,
        mode: cleanValue(parsed.mode),
        policy: parsed.policy && typeof parsed.policy === 'object' ? parsed.policy : {},
        importantFiles: Array.isArray(parsed.compactOutput?.importantFiles)
          ? parsed.compactOutput.importantFiles.filter(f => typeof f === 'string')
          : [],
        importantSkills: Array.isArray(parsed.compactOutput?.importantSkills)
          ? parsed.compactOutput.importantSkills.filter(s => typeof s === 'string')
          : [],
        fileRanges: typeof parsed.compactOutput?.fileRanges === 'object' && parsed.compactOutput.fileRanges !== null
          ? parsed.compactOutput.fileRanges
          : {},
        featureContinuity: parsed.featureContinuity && typeof parsed.featureContinuity === 'object'
          ? parsed.featureContinuity
          : null,
      };
    }
  } catch (error) {
    if (sourceLabel === HANDOFF_PAYLOAD_ENV) {
      return { sourceSummary: text, seedMessages: [] };
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      throw new Error(`解析 handoff 内容失败 (${sourceLabel}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { sourceSummary: text, seedMessages: [] };
}

function loadRuntimeHandoff() {
  const payloadText = cleanValue(process.env[HANDOFF_PAYLOAD_ENV]);
  if (payloadText) {
    return {
      source: HANDOFF_PAYLOAD_ENV,
      handoff: parseHandoffContent(payloadText, HANDOFF_PAYLOAD_ENV),
    };
  }

  const handoffPath = cleanValue(process.env[HANDOFF_PATH_ENV]);
  if (!handoffPath) {
    return null;
  }
  if (!existsSync(handoffPath)) {
    throw new Error(`handoff 文件不存在: ${handoffPath}`);
  }

  const fileContent = readFileSync(handoffPath, 'utf8');
  return {
    source: handoffPath,
    handoff: parseHandoffContent(fileContent, handoffPath),
  };
}

function sanitizeSessionFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function resolveAgentClass(agentModule) {
  if (typeof agentModule.default === 'function') {
    return agentModule.default;
  }

  for (const exported of Object.values(agentModule)) {
    if (typeof exported === 'function') {
      return exported;
    }
  }

  return null;
}

function getWorkspaceStatePath(agentId) {
  return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', sanitizeSessionFragment(agentId), 'state.json');
}

function getSessionIndexPath(agentId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const sessionRoot = WORKSPACE_BOUND_AGENT_IDS.has(normalizedAgentId)
    ? join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', normalizedAgentId, 'sessions')
    : join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions', normalizedAgentId);
  return join(sessionRoot, 'index.json');
}

function resolveSessionWorkspaceCwd(agentId, sessionId) {
  const normalizedSessionId = cleanValue(sessionId);
  if (!normalizedSessionId || normalizedSessionId === NO_SESSION_TOKEN) {
    return null;
  }

  const indexPath = getSessionIndexPath(agentId);
  if (!existsSync(indexPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const record = sessions.find((session) => sanitizeSessionFragment(session?.id) === sanitizeSessionFragment(normalizedSessionId));
    const openDirectory = cleanValue(record?.openDirectory);
    if (!openDirectory || !existsSync(openDirectory)) {
      return null;
    }
    return openDirectory;
  } catch (error) {
    console.warn('[ProtoClaw Runtime] 读取 session 工作目录失败:', error);
    return null;
  }
}

function resolveWorkspaceCwd(agentId, sessionId = '') {
  if (!WORKSPACE_BOUND_AGENT_IDS.has(sanitizeSessionFragment(agentId))) {
    return null;
  }

  // --- Assembly mode: compute cwd from env var or assembly form ---
  if (process.env.PROTOCLAW_ASSEMBLY_RUNTIME === '1') {
    const assemblyCwd = process.env.PROTOCLAW_ASSEMBLY_WORKSPACE;
    if (assemblyCwd) {
      mkdirSync(assemblyCwd, { recursive: true });
      const claudeMdPath = join(assemblyCwd, 'CLAUDE.md');
      if (!existsSync(claudeMdPath)) {
        writeFileSync(claudeMdPath, '# Chatbot Workspace\n\nAssembly workspace.\n', 'utf8');
      }
      return assemblyCwd;
    }
    // Fallback: read from state.json
    const statePath = getWorkspaceStatePath(agentId);
    if (existsSync(statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
        const assemblyName = parsed?.forms?.['assembly-form']?.assembly_name;
        if (assemblyName && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(assemblyName)) {
          const fallbackCwd = join(os.homedir(), '.agentdev', 'agent-dev', assemblyName);
          mkdirSync(fallbackCwd, { recursive: true });
          const claudeMdPath = join(fallbackCwd, 'CLAUDE.md');
          if (!existsSync(claudeMdPath)) {
            writeFileSync(claudeMdPath, `# ${assemblyName}\n\nAssembly workspace.\n`, 'utf8');
          }
          return fallbackCwd;
        }
      } catch (error) {
        console.warn('[ProtoClaw Runtime] Assembly 模式读取状态失败:', error);
      }
    }
    return null;
  }

  // --- Project mode: prefer the target session's own openDirectory ---
  const sessionCwd = resolveSessionWorkspaceCwd(agentId, sessionId);
  if (sessionCwd) {
    return sessionCwd;
  }

  // Fallback for workspace home/no-session mode: use current openDirectory from state.
  const statePath = getWorkspaceStatePath(agentId);
  if (!existsSync(statePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const openDirectory = typeof parsed?.openDirectory === 'string' ? parsed.openDirectory.trim() : '';
    if (!openDirectory || !existsSync(openDirectory)) {
      return null;
    }
    return openDirectory;
  } catch (error) {
    console.warn('[ProtoClaw Runtime] 读取工作空间状态失败:', error);
    return null;
  }
}

const [agentDir, agentId, agentNameArg, sessionIdArg] = process.argv.slice(2);

if (!agentDir || !agentId) {
  console.error('用法: node scripts/run-prebuilt-agent.js <agent-dir> <agent-id> [agent-name] [session-id]');
  process.exit(1);
}

const agentPath = resolve(PROTOCLAW_ROOT, agentDir);
const agentJsPath = join(agentPath, 'agent.js');
const agentName = agentNameArg || agentId;
const sessionStoreDir = WORKSPACE_BOUND_AGENT_IDS.has(sanitizeSessionFragment(agentId))
  ? join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', sanitizeSessionFragment(agentId), 'sessions')
  : join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions', sanitizeSessionFragment(agentId));
mkdirSync(sessionStoreDir, { recursive: true });

const sessionStore = new FileSessionStore(sessionStoreDir);
const sessionId = sessionIdArg && sessionIdArg !== NO_SESSION_TOKEN
  ? sanitizeSessionFragment(sessionIdArg)
  : null;
const INPUT_PROMPT = '请输入: ';
const NEXT_TURN_ACTIONS = [
  {
    id: 'rollback_to_call',
    label: '回滚到指定轮次',
    kind: 'rollback',
    variant: 'secondary',
  },
  {
    id: 'compact_from_call',
    label: '从指定轮次压缩',
    kind: 'compact',
    variant: 'secondary',
  },
];

let agent = null;
let disposed = false;

// CallArbiter extracted to server/call-arbiter.js

let callArbiter = null;

// ── Mutable context for extracted modules ──────────────────────────
// `agent` and `callArbiter` are populated during main(); the context
// objects below are shared by reference so module functions see the
// latest values.  `postJson` is a hoisted function declaration, so it
// is already available here despite being defined further down.
const imBridgeCtx = {
  agentId,
  sessionId,
  IS_EXPLORATION,
  SERVER_ORIGIN,
  agent: null,
  callArbiter: null,
};

const summaryCtx = {
  agentId,
  sessionId,
  PREBUILT_AGENT_MAX_TOKENS_CAP,
  agent: null,
  sessionStore,
  postJson,
};

const imBridge = createIMBridge(imBridgeCtx);
const summaryHandlers = createSummaryHandlers(summaryCtx);

// Register IPC handler for dynamic carrier mount/unmount + todo-control
imBridge.setupIPCMessageHandler();

function getNextTurnActions() {
  const checkpoints = Array.isArray(agent?._callCheckpoints) ? agent._callCheckpoints : [];
  if (checkpoints.length === 0) return undefined;
  const availableCallIndices = checkpoints.map(cp => cp.callIndex);
  // Return actions enriched with availableCallIndices so the frontend can
  // determine which user messages actually have rollback targets.
  return NEXT_TURN_ACTIONS.map(action => ({
    ...action,
    data: { availableCallIndices },
  }));
}

async function disposeAgent(exitCode = 0) {
  if (disposed) return;
  disposed = true;

  if (agent) {
    if (sessionId) {
      // 先禁用 step auto-save，再手动做一次最终保存
      if (typeof agent.disableStepAutoSave === 'function') {
        agent.disableStepAutoSave();
      }
      try {
        await agent.saveSession(sessionId, sessionStore);
      } catch (error) {
        console.error('[ProtoClaw Runtime] 保存会话失败:', error);
      }
    }

    try {
      await agent.dispose();
    } catch (error) {
      console.error('[ProtoClaw Runtime] 释放资源失败:', error);
    }
  }

  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void disposeAgent(0);
});

process.on('SIGTERM', () => {
  void disposeAgent(0);
});

async function postJson(pathname, payload) {
  const response = await fetch(`${SERVER_ORIGIN}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  const data = bodyText ? JSON.parse(bodyText) : {};
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : `${pathname} failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}


async function main() {
  const workspaceCwd = resolveWorkspaceCwd(agentId, sessionId);
  const runtimeHandoff = loadRuntimeHandoff();

  const agentModule = await import(pathToFileURL(agentJsPath).href);
  const AgentClass = resolveAgentClass(agentModule);

  if (!AgentClass) {
    throw new Error(`无法在 ${agentJsPath} 中找到 Agent 类导出`);
  }

  let resolved = resolveAgentModelLLM(agentPath, 'default');
  resolvedUsageModel = resolved || null;
  agent = new AgentClass({
    name: agentName,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir: workspaceCwd || PROTOCLAW_ROOT,
    ...(agentId === 'programming-helper' ? {
      contextGuard: {
        contextLength: resolved?.contextLength ?? null,
        compressRatio: resolved?.compressRatio ?? 80,
      },
    } : {}),
    ...(resolved ? { llm: resolved.llm } : {}),
  });
  // Propagate agent reference to extracted module contexts
  imBridgeCtx.agent = agent;
  summaryCtx.agent = agent;
  if (resolved) {
    console.log(`[ProtoClaw Runtime] Using model preset from metadata.json => ${resolved.modelName}`);
    try {
      const ctx = typeof agent.getSystemContext === 'function' ? agent.getSystemContext() : agent._systemContext;
      if (ctx) ctx.SYSTEM_CURRENT_MODEL = resolved.modelName;
    } catch {}
  } else {
    // No preset in metadata.json — BasicAgent resolved its own LLM internally.
    // Capture model info from the running LLM so usage events record the real model name.
    const fallbackModelName = agent?.llm?.modelName;
    if (fallbackModelName) {
      resolvedUsageModel = { modelName: fallbackModelName };
      console.log(`[ProtoClaw Runtime] No model preset found, using agent LLM model => ${fallbackModelName}`);
    }
  }

  const localFeatures = await import(pathToFileURL(join(PROTOCLAW_ROOT, 'local-features', 'dist', 'index.js')).href);

  if (typeof localFeatures.ContextCompactionControlFeature === 'function') {
    agent.use(new localFeatures.ContextCompactionControlFeature({
      serverOrigin: SERVER_ORIGIN,
      agentId,
      sessionId,
    }));
    console.log('[ProtoClaw Runtime] 已挂载 context compaction control feature');
  }

  if (runtimeHandoff?.handoff && (runtimeHandoff.handoff.sourceSummary || runtimeHandoff.handoff.seedMessages?.length)) {
    if (typeof localFeatures.ContextHandoffSeedFeature !== 'function') {
      throw new Error('local ContextHandoffSeedFeature 未构建，无法挂载 handoff seed');
    }
    agent.use(new localFeatures.ContextHandoffSeedFeature({
      handoff: runtimeHandoff.handoff,
    }));
    console.log(`[ProtoClaw Runtime] 已挂载 context handoff seed (${runtimeHandoff.source})`);
  }

  if (typeof agent.prepareRuntime === 'function') {
    await agent.prepareRuntime();
  }

  if (workspaceCwd) {
    console.log(`[ProtoClaw Runtime] Workspace-bound agent environment => ${workspaceCwd}`);
  }

  console.log(`[ProtoClaw Runtime] Host workdir => ${process.cwd()}`);

  console.log(`[ProtoClaw Runtime] Agent 实例已创建: ${agentName}`);

  // Exploration agents run headlessly — no ViewerWorker, no IM gateway.
  // ClawDispatchFeature polls via HTTP and is independent of ViewerWorker.
  if (IS_EXPLORATION) {
    console.log('[ProtoClaw Runtime] Exploration mode — skipping ViewerWorker connection');
  } else {
    console.log(`[ProtoClaw Runtime] 正在连接到 ViewerWorker (端口 ${VIEWER_PORT})...`);
    await agent.withViewer(agentName, VIEWER_PORT, false, {
      projectRoot: PROTOCLAW_ROOT,
    });
    console.log('[ProtoClaw Runtime] ✓ 已连接到 ViewerWorker');
    console.log(`[ProtoClaw Runtime] Viewer Agent ID: ${agent.agentId ?? 'unknown'}`);
  }

  if (sessionId) {
    let sessionLoaded = false;
    try {
      await agent.loadSession(sessionId, sessionStore);
      sessionLoaded = true;
      console.log('[ProtoClaw Runtime] ✓ 已恢复会话: ' + sessionId);
    } catch {
      console.log('[ProtoClaw Runtime] 创建新会话: ' + sessionId);

      // 对新 session 预注入 CallStart 钩子内容（CLAUDE.md、交接摘要等），
      // 使首次加载时就能展示注入的上下文，而非空白。
      if (typeof agent['preInjectCallStart'] === 'function') {
        try {
          await agent['preInjectCallStart']();
          // preInjectCallStart 注入了 seedMessages 到内存 context，
          // 需立即落盘，否则 title mirror 等独立子进程从磁盘加载时会 ENOENT
          await agent.saveSession(sessionId, sessionStore);
          console.log('[ProtoClaw Runtime] ✓ preInjectCallStart 内容已落盘');
        } catch (error) {
          console.warn('[ProtoClaw Runtime] preInjectCallStart 失败:', error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (!sessionLoaded && runtimeHandoff?.handoff?.featureContinuity) {
      try {
        const imported = await importFeatureContinuity(agent, runtimeHandoff.handoff.featureContinuity, {
          sourceSessionId: runtimeHandoff.handoff.sourceSessionId,
        });
        if (imported.length > 0) {
          await agent.saveSession(sessionId, sessionStore);
          console.log(`[ProtoClaw Runtime] ✓ 已导入 continuity feature state: ${imported.join(', ')}`);
        }
      } catch (error) {
        console.warn('[ProtoClaw Runtime] continuity feature state 导入失败:', error instanceof Error ? error.message : String(error));
      }
    }
    // 启用 step 级自动保存：每个 StepFinish 后自动落盘
    if (typeof agent.enableStepAutoSave === 'function') {
      agent.enableStepAutoSave(sessionId, sessionStore);
      console.log('[ProtoClaw Runtime] ✓ 已启用 step 级自动保存');
    }
  } else {
    console.log('[ProtoClaw Runtime] 当前未绑定对话会话，运行在工作空间首页模式。');
  }

  // `loadSession()` only restores in-memory state. Push the restored state to Viewer
  // so history is visible immediately without waiting for the next user input.
  if (!IS_EXPLORATION) {
    try {
      const messages = typeof agent.getContext === 'function' ? agent.getContext().getAll() : [];
      agent['pushToDebug']?.(messages);
      agent['syncRegisteredToolsToDebug']?.();
      agent['pushInspectorSnapshot']?.();
      agent['pushOverviewSnapshot']?.();
    } catch (error) {
      console.warn('[ProtoClaw Runtime] 恢复会话后同步调试状态失败:', error);
    }
  }

  console.log('[ProtoClaw Runtime] READY session=' + (sessionId || 'none'));

  // ── CallArbiter: initialize AFTER session restore, BEFORE runtime inputs open ──
  callArbiter = new CallArbiter(agent);
  const contextGuardFeature = agent.features?.get?.('context-guard');
  if (contextGuardFeature && typeof contextGuardFeature.setCallArbiter === 'function') {
    contextGuardFeature.setCallArbiter(callArbiter);
  }
  imBridgeCtx.callArbiter = callArbiter;
  DebugHub.getInstance().setInterruptHandler((targetAgentId, clearQueue) => {
    if (!callArbiter || !agent?.agentId || targetAgentId !== agent.agentId) {
      return;
    }
    const result = callArbiter.interruptActive('cancelled by interrupt', { clearQueue });
    if (result.active || result.cleared > 0) {
      console.log(`[ProtoClaw Runtime] interrupt marked active=${result.active}, cleared=${result.cleared}`);
    }
  });

  callArbiter.on('callFinished', (_envelope) => {
    if (!sessionId) return;
    agent.saveSession(sessionId, sessionStore).then(async () => {
      // Push fresh metadata to server so session list can skip reading full files
      try {
        const context = typeof agent.getContext === 'function' ? agent.getContext() : null;
        const messages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
        const lastMessage = [...messages].reverse().find((m) => m && typeof m.content === 'string' && m.role !== 'system') || null;
        const preview = lastMessage?.content ? String(lastMessage.content).replace(/\s+/g, ' ').slice(0, 140) : '';
        const usageStats = typeof agent.getUsage === 'function' ? agent.getUsage().toSnapshot() : null;
        const totalUsage = usageStats?.totalUsage;
        const callIndex = typeof agent?._callIndex === 'number' ? agent._callIndex : null;
        const callSummary = Array.isArray(usageStats?.calls)
          ? usageStats.calls.find((call) => call?.callIndex === callIndex)
          : null;
        if (callSummary?.totalUsage && callIndex !== null) {
          const usageEventId = [
            'agent-call',
            agentId,
            sessionId,
            runtimeInstanceId,
            callIndex,
            callSummary.endTime || Date.now(),
          ].join(':');
          if (!reportedUsageEventIds.has(usageEventId)) {
            reportedUsageEventIds.add(usageEventId);
            const usageResult = await reportUsageEvent(SERVER_ORIGIN, {
              eventId: usageEventId,
              timestamp: callSummary.endTime || Date.now(),
              source: IS_EXPLORATION ? 'exploration-call' : 'agent-call',
              agentId,
              sessionId,
              runtimeInstanceId,
              callIndex,
              requestCount: callSummary.stepCount || 1,
              cacheHitRequests: callSummary.cacheHitRequests || 0,
              model: buildModelUsageMeta(resolvedUsageModel, IS_EXPLORATION ? 'exploration' : 'default'),
              usage: callSummary.totalUsage,
              context: {
                contextInputTokens: usageStats?.lastRequestUsage?.inputTokens || 0,
                messageCount: messages.length,
              },
            });
            if (usageResult?.ok === false) {
              console.warn('[ProtoClaw Runtime] usage event sync failed:', usageResult.error || usageResult.status);
            }
          }
        }
        await fetch(`${SERVER_ORIGIN}/protoclaw/session_meta_sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId,
            sessionId,
            messageCount: messages.length,
            preview,
            tokenUsage: {
              inputTokens: totalUsage?.inputTokens || 0,
              outputTokens: totalUsage?.outputTokens || 0,
              totalTokens: totalUsage?.totalTokens || 0,
              lastRequestUsage: usageStats?.lastRequestUsage || null,
            },
            contextGuard: typeof contextGuardFeature?.getState === 'function'
              ? contextGuardFeature.getState() : null,
            modelName: resolved?.modelName || resolvedUsageModel?.modelName || undefined,
            contextLength: resolved?.contextLength ?? undefined,
            compressRatio: resolved?.compressRatio ?? undefined,
            savedAt: Date.now(),
          }),
        });
      } catch (metaErr) {
        console.warn('[ProtoClaw Runtime] session meta sync failed (will auto-heal on next list):', metaErr.message);
      }
    }).catch(e => {
      console.warn('[ProtoClaw Runtime] 保存 session 失败:', e.message);
    });
  });

  callArbiter.on('callFinished', (envelope) => {
    imBridge.dispatchIMCallFinish(envelope).catch(err => {
      console.error('[ProtoClaw Runtime] IM callfinish delivery error:', err);
    });
  });

  if (typeof agent.setCallArbiter === 'function') {
    agent.setCallArbiter(callArbiter);
  }

  // Wire session save for checkpoint/rollback continuation barriers
  callArbiter.sessionSaveFn = async () => {
    if (!sessionId) return;
    await agent.saveSession(sessionId, sessionStore);
  };

  console.log('[ProtoClaw Runtime] ✓ CallArbiter 已初始化');

  // ── IPC: model hot-swap (no process restart) ──
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object' || msg.type !== 'swap-model') return;

    if (typeof agent?.setLLM !== 'function') {
      console.warn('[ProtoClaw Runtime] swap-model: agent.setLLM not available (framework too old)');
      return;
    }
    if (typeof agent.isRunning === 'function' && agent.isRunning()) {
      console.warn('[ProtoClaw Runtime] swap-model: agent is running, skipped');
      return;
    }

    const newResolved = resolveAgentModelLLM(agentPath, 'default');
    if (!newResolved?.llm) {
      console.error('[ProtoClaw Runtime] swap-model: failed to resolve new model preset');
      return;
    }

    const oldName = resolved?.modelName || resolvedUsageModel?.modelName || 'unknown';
    agent.setLLM(newResolved.llm, {
      modelName: newResolved.modelName,
      contextLength: newResolved.contextLength,
      compressRatio: newResolved.compressRatio,
    });

    resolved = newResolved;
    resolvedUsageModel = newResolved;

    console.log(`[ProtoClaw Runtime] ✓ Model swapped: ${oldName} → ${newResolved.modelName || 'unknown'}`);
  });

  if (!IS_EXPLORATION) {
    try {
      if (typeof agent.startSelectedIMGateway === 'function') {
        const channel = await agent.startSelectedIMGateway();
        if (channel === 'none') {
          console.log('[ProtoClaw Runtime] • IM Gateway 未启动（未选择渠道），仅调试模式运行');
        } else {
          console.log(`[ProtoClaw Runtime] ✓ 已启动 IM Gateway (${channel || 'unknown'})`);
        }
      } else if (typeof agent.startQQBotGateway === 'function') {
        await agent.startQQBotGateway();
        console.log('[ProtoClaw Runtime] ✓ 已启动 QQBot Gateway');
      } else {
        const qqbotFeature = agent.features?.get?.('qqbot');
        if (qqbotFeature && typeof qqbotFeature.startGateway === 'function') {
          await qqbotFeature.startGateway(agent);
          console.log('[ProtoClaw Runtime] ✓ 已启动 QQBot Gateway');
        }
      }
    } catch (error) {
      console.error('[ProtoClaw Runtime] IM Gateway 启动失败，已降级为仅调试运行:', error);
    }

  }

  // If this session is bound to an IM line, mount the carrier feature + gateway
  await imBridge.mountIMLineCarrierIfBound();

  try {
    const dispatchFeature = agent.features?.get?.('claw-dispatch');
    if (dispatchFeature && typeof dispatchFeature.startDispatchLoop === 'function') {
      await dispatchFeature.startDispatchLoop(agent, callArbiter);
      console.log('[ProtoClaw Runtime] ✓ 已启动 ClawDispatch loop (via arbiter)');
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] ClawDispatch 启动失败:', error);
  }

  try {
    const gcBridgeFeature = agent.features?.get?.('group-chat-bridge');
    if (gcBridgeFeature && typeof gcBridgeFeature.startBridgeLoop === 'function') {
      await gcBridgeFeature.startBridgeLoop(agent, callArbiter);
      console.log('[ProtoClaw Runtime] ✓ 已启动 GroupChatBridge loop');
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] GroupChatBridge 启动失败:', error);
  }

  const userInput = agent.features?.get?.('user-input');
  const hasUserInput = Boolean(userInput && typeof userInput.getUserInput === 'function');

  if (!hasUserInput) {
    console.log('');
    console.log('当前 Agent 不使用 UserInputFeature，运行在被动事件模式。');
    await new Promise(() => {});
    return;
  }

  console.log('');
  console.log('等待调试界面输入...');

  while (true) {
    let response;
    try {
      response = await userInput.getUserInputEvent(INPUT_PROMPT, undefined, getNextTurnActions());
    } catch (error) {
      console.error('[ProtoClaw Runtime] 等待用户输入失败，稍后重试:', error);
      await sleep(500);
      continue;
    }

    let handled;
    try {
      handled = await summaryHandlers.handleInputResponse(userInput, response);
    } catch (error) {
      console.error('[ProtoClaw Runtime] 处理输入动作失败，已忽略本次请求:', error);
      console.error(error?.stack || error);
      continue;
    }

    if (handled.kind === 'continue') {
      continue;
    }

    if (handled.kind === 'exit') {
      console.log('[ProtoClaw Runtime] 收到退出指令，正在关闭...');
      break;
    }

    try {
      const entry = callArbiter.enqueue({
        source: 'viewer-input',
        text: handled.text,
        ...(Array.isArray(handled.images) && handled.images.length > 0 ? { images: handled.images } : {}),
      });
      await callArbiter.waitForCompletion(entry.id);
    } catch (error) {
      console.error('[ProtoClaw Runtime] CallArbiter 入队失败:', error);
    }

    // 只有当前一轮 viewer 输入对应的调用真正结束后，
    // 才重新挂出下一轮 input-request。
    // 这样可以保留原本“运行中显示暂停/队列态”的前端语义。
  }

  await disposeAgent(0);
}

main().catch(async (error) => {
  console.error('[ProtoClaw Runtime] 启动失败:', error);
  await disposeAgent(1);
});
