#!/usr/bin/env node
/**
 * One-shot agent runner for blocking sub-agent execution.
 *
 * Unlike run-prebuilt-agent.js which starts an interactive loop connected
 * to ViewerWorker, this script executes exactly ONE agent.onCall(goal)
 * and exits with a structured result.
 *
 * Usage:
 *   node scripts/run-one-shot-agent.js <agent-dir> <agent-id> <session-id> <goal>
 *
 * Environment:
 *   PROTOCLAW_HANDOFF_PATH    - path to handoff JSON for context injection
 *   PROTOCLAW_SERVER_ORIGIN   - server URL for API calls
 */

// 无头日志契约前导：必须是第一个 import（env 设置 + console 桥须先于
// 一切依赖模块顶层执行，详见 headless-log-preamble.js）。
import './headless-log-preamble.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import os from 'os';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { FileSessionStore } from 'agentdev';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { attachSessionEventOutput, emitFatalSessionError } from './headless-session-renderer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';
const HANDOFF_PATH_ENV = 'PROTOCLAW_HANDOFF_PATH';
const HANDOFF_PAYLOAD_ENV = 'PROTOCLAW_HANDOFF_PAYLOAD';
const WORKSPACE_BOUND_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'agent-studio', 'programming-helper', 'flow-workspace']);

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseHandoffContent(raw, sourceLabel) {
  const text = cleanValue(raw);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      return { sourceSummary: parsed, seedMessages: [] };
    }
    if (parsed && typeof parsed === 'object') {
      const seedMessages = Array.isArray(parsed.seedMessages)
        ? parsed.seedMessages
            .map((message) => {
              const mapped = {
                role: cleanValue(message?.role),
                content: cleanValue(message?.content),
                turn: Number.isFinite(message?.turn) ? Number(message.turn) : null,
              };
              // Preserve toolCalls and toolCallId for conversation fidelity
              if (Array.isArray(message?.toolCalls) && message.toolCalls.length > 0) {
                mapped.toolCalls = message.toolCalls;
              }
              if (message?.toolCallId) {
                mapped.toolCallId = cleanValue(message.toolCallId);
              }
              return mapped;
            })
            .filter((message) => message.role && (message.content || message.toolCalls || message.toolCallId))
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
  if (!handoffPath) return null;
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
  if (typeof agentModule.default === 'function') return agentModule.default;
  for (const exported of Object.values(agentModule)) {
    if (typeof exported === 'function') return exported;
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
  if (!normalizedSessionId || normalizedSessionId === '__protoclaw-no-session__') return null;

  const indexPath = getSessionIndexPath(agentId);
  if (!existsSync(indexPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const record = sessions.find((session) => sanitizeSessionFragment(session?.id) === sanitizeSessionFragment(normalizedSessionId));
    const openDirectory = cleanValue(record?.openDirectory);
    if (!openDirectory || !existsSync(openDirectory)) return null;
    return openDirectory;
  } catch {
    return null;
  }
}

function resolveWorkspaceCwd(agentId, sessionId = '') {
  if (!WORKSPACE_BOUND_AGENT_IDS.has(sanitizeSessionFragment(agentId))) return null;

  if (process.env.PROTOCLAW_ASSEMBLY_RUNTIME === '1') {
    const assemblyCwd = process.env.PROTOCLAW_ASSEMBLY_WORKSPACE;
    if (assemblyCwd) {
      mkdirSync(assemblyCwd, { recursive: true });
      return assemblyCwd;
    }
    const statePath = getWorkspaceStatePath(agentId);
    if (existsSync(statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
        const assemblyName = parsed?.forms?.['assembly-form']?.assembly_name;
        if (assemblyName && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(assemblyName)) {
          const fallbackCwd = join(os.homedir(), '.agentdev', 'agent-dev', assemblyName);
          mkdirSync(fallbackCwd, { recursive: true });
          return fallbackCwd;
        }
      } catch {}
    }
    return null;
  }

  const sessionCwd = resolveSessionWorkspaceCwd(agentId, sessionId);
  if (sessionCwd) return sessionCwd;

  const statePath = getWorkspaceStatePath(agentId);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const openDirectory = typeof parsed?.openDirectory === 'string' ? parsed.openDirectory.trim() : '';
    if (!openDirectory || !existsSync(openDirectory)) return null;
    return openDirectory;
  } catch {
    return null;
  }
}

// ========== Main ==========

// --format jsonl：stdout 输出会话事件 JSONL 流（替代 ONE_SHOT_RESULT 行）
const rawArgs = process.argv.slice(2);
const hasJsonlFlag = rawArgs.includes('--format') && rawArgs[rawArgs.indexOf('--format') + 1] === 'jsonl';
const positionalArgs = hasJsonlFlag
  ? rawArgs.filter((arg, i) => arg !== '--format' && rawArgs[i - 1] !== '--format')
  : rawArgs;

const [agentDir, agentId, sessionIdArg, ...goalParts] = positionalArgs;
const goal = goalParts.join(' ');

if (!agentDir || !agentId || !sessionIdArg || !goal) {
  console.error('用法: node scripts/run-one-shot-agent.js <agent-dir> <agent-id> <session-id> <goal>');
  process.exit(1);
}

const agentPath = resolve(PROTOCLAW_ROOT, agentDir);
const agentJsPath = join(agentPath, 'agent.js');
const sessionStoreDir = WORKSPACE_BOUND_AGENT_IDS.has(sanitizeSessionFragment(agentId))
  ? join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', sanitizeSessionFragment(agentId), 'sessions')
  : join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions', sanitizeSessionFragment(agentId));
mkdirSync(sessionStoreDir, { recursive: true });

const sessionStore = new FileSessionStore(sessionStoreDir);
const sessionId = sessionIdArg && sessionIdArg !== '__protoclaw-no-session__'
  ? sanitizeSessionFragment(sessionIdArg)
  : null;

function outputResult(result) {
  // jsonl 模式下 stdout 只承载会话事件流，不追加结果行；成败由 exit code 表达
  if (hasJsonlFlag) return;
  console.log('ONE_SHOT_RESULT:' + JSON.stringify(result));
}

async function main() {
  console.error(`[OneShot] Starting agent=${agentId} session=${sessionId || '(new)'} goal="${goal.slice(0, 80)}"`);

  // 会话事件流输出：jsonl 模式写 stdout，其余模式渲染 human 可读行到 stderr
  attachSessionEventOutput({
    format: hasJsonlFlag ? 'jsonl' : 'human',
    threadId: sessionId || agentId,
  });

  // 1. Resolve workspace
  const workspaceCwd = resolveWorkspaceCwd(agentId, sessionId);

  // 2. Load handoff
  const runtimeHandoff = loadRuntimeHandoff();

  // 3. Import and instantiate agent class
  const agentModule = await import(pathToFileURL(agentJsPath).href);
  const AgentClass = resolveAgentClass(agentModule);
  if (!AgentClass) {
    throw new Error(`无法在 ${agentJsPath} 中找到 Agent 类导出`);
  }

  const modelPresetRole = cleanValue(process.env.PROTOCLAW_MODEL_PRESET_ROLE) || 'sub';
  const resolved = resolveAgentModelLLM(agentPath, modelPresetRole);
  const agent = new AgentClass({
    name: agentId,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir: workspaceCwd || PROTOCLAW_ROOT,
    ...(resolved ? { llm: resolved.llm } : {}),
  });
  if (resolved) {
    console.error(`[OneShot] Using model preset role="${modelPresetRole}" => ${resolved.modelName}`);
    try {
      const ctx = typeof agent.getSystemContext === 'function' ? agent.getSystemContext() : agent._systemContext;
      if (ctx) ctx.SYSTEM_CURRENT_MODEL = resolved.modelName;
    } catch {}
  }

  // 4. Mount handoff seed feature (same as run-prebuilt-agent.js)
  const localFeatures = await import(pathToFileURL(join(PROTOCLAW_ROOT, 'local-features', 'dist', 'index.js')).href);

  // Only mount handoff seed if handoff data exists
  if (runtimeHandoff?.handoff && (runtimeHandoff.handoff.sourceSummary || runtimeHandoff.handoff.seedMessages?.length)) {
    if (typeof localFeatures.ContextHandoffSeedFeature !== 'function') {
      throw new Error('local ContextHandoffSeedFeature 未构建，无法挂载 handoff seed');
    }
    agent.use(new localFeatures.ContextHandoffSeedFeature({
      handoff: runtimeHandoff.handoff,
    }));
    console.error(`[OneShot] 已挂载 context handoff seed (${runtimeHandoff.source})`);
  }

  // 5. prepareRuntime hook
  if (typeof agent.prepareRuntime === 'function') {
    await agent.prepareRuntime();
  }

  if (workspaceCwd) {
    console.error(`[OneShot] Workspace-bound agent environment => ${workspaceCwd}`);
  }
  console.error(`[OneShot] Agent 实例已创建: ${agentId}`);

  // 6. Load or create session
  if (sessionId) {
    try {
      await agent.loadSession(sessionId, sessionStore);
      console.error(`[OneShot] 已恢复会话: ${sessionId}`);
    } catch {
      console.error(`[OneShot] 创建新会话: ${sessionId}`);
    }
  }

  // 7. Execute ONE onCall
  const startTime = Date.now();
  let response;
  let error = null;
  let callOutcome = null;

  try {
    console.error('[OneShot] 开始执行 agent.onCall()...');
    if (typeof agent.onCallDetailed === 'function') {
      callOutcome = await agent.onCallDetailed(goal);
      response = callOutcome.response;
    } else {
      response = await agent.onCall(goal);
    }
    console.error(`[OneShot] agent.onCall() 完成，响应长度=${(response || '').length}`);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[OneShot] agent.onCall() 失败: ${error}`);
  }

  const durationMs = Date.now() - startTime;

  // 终态判定：CLI 成功 == call outcome.status === 'completed'。
  // 模型请求失败 / 用户中断 / 步数上限等终态不会抛异常，只体现在
  // outcome.status 中——不能以"onCall 没有抛异常"当作成功。
  const status = error ? 'failed' : (callOutcome?.status || 'completed');
  if (!error && status !== 'completed') {
    error = callOutcome?.error?.message
      || `call terminated: ${callOutcome?.reason || status}`;
    console.error(`[OneShot] call 未完成: status=${status} reason=${callOutcome?.reason || ''} ${error}`);
  }

  // 8. Save session
  if (sessionId) {
    try {
      await agent.saveSession(sessionId, sessionStore);
      console.error(`[OneShot] 会话已保存: ${sessionId}`);
    } catch (err) {
      console.error('[OneShot] saveSession 失败:', err);
    }
  }

  // 9. Dispose
  try {
    await agent.dispose();
  } catch (err) {
    console.error('[OneShot] dispose 失败:', err);
  }

  // 10. Output structured result
  const result = {
    ok: status === 'completed',
    status,
    ...(callOutcome?.reason ? { reason: callOutcome.reason } : {}),
    response: response || null,
    error: error || null,
    ...(callOutcome?.error ? { errorDetail: callOutcome.error } : {}),
    sessionId: sessionId || null,
    durationMs,
    timestamp: new Date().toISOString(),
  };

  outputResult(result);
  process.exit(status === 'completed' ? 0 : 1);
}

main().catch((error) => {
  console.error('[OneShot] Fatal:', error);
  emitFatalSessionError(error instanceof Error ? error.message : String(error));
  outputResult({
    ok: false,
    status: 'failed',
    response: null,
    error: error instanceof Error ? error.message : String(error),
    sessionId: sessionId || null,
    durationMs: 0,
    timestamp: new Date().toISOString(),
  });
  process.exit(1);
});
