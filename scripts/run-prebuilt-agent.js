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
import { FileSessionStore } from 'agentdev';
import { setTimeout as sleep } from 'timers/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const VIEWER_PORT = parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
const NO_SESSION_TOKEN = '__protoclaw-no-session__';
const HANDOFF_PATH_ENV = 'PROTOCLAW_HANDOFF_PATH';
const HANDOFF_PAYLOAD_ENV = 'PROTOCLAW_HANDOFF_PAYLOAD';
const WORKSPACE_BOUND_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);

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
            .map((message) => ({
              role: cleanValue(message?.role),
              content: cleanValue(message?.content),
              turn: Number.isFinite(message?.turn) ? Number(message.turn) : null,
            }))
            .filter((message) => message.role && message.content)
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

function resolveWorkspaceCwd(agentId) {
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

  // --- Project mode: use openDirectory from state ---
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
];

let agent = null;
let disposed = false;

function getNextTurnActions() {
  const checkpoints = Array.isArray(agent?._callCheckpoints) ? agent._callCheckpoints : [];
  return checkpoints.length > 0 ? NEXT_TURN_ACTIONS : undefined;
}

async function disposeAgent(exitCode = 0) {
  if (disposed) return;
  disposed = true;

  if (agent) {
    if (sessionId) {
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

async function handleInputResponse(userInput, response) {
  if (!response) {
    return { kind: 'continue' };
  }

  if (response.kind === 'text') {
    const text = response.text ?? '';
    if (!text) {
      return { kind: 'continue' };
    }
    if (text === '/exit') {
      return { kind: 'exit' };
    }
    return { kind: 'text', text };
  }

  if (response.kind === 'action' && response.actionId === 'rollback_to_call') {
    const callIndex = response.payload?.callIndex;
    if (typeof callIndex !== 'number') {
      console.warn('[ProtoClaw Runtime] rollback_to_call 缺少有效的 callIndex');
      return { kind: 'continue' };
    }

    if (typeof agent?.rollbackToCall !== 'function') {
      console.warn('[ProtoClaw Runtime] 当前 Agent 不支持 rollbackToCall');
      return { kind: 'continue' };
    }

    const result = await agent.rollbackToCall(callIndex);
    const draftInput =
      typeof response.payload?.draftInput === 'string'
        ? response.payload.draftInput
        : (typeof result?.draftInput === 'string' ? result.draftInput : '');

    if (typeof userInput.setNextDraftInput === 'function') {
      userInput.setNextDraftInput(draftInput);
    }

    if (sessionId) {
      await agent.saveSession(sessionId, sessionStore);
      console.log(`[ProtoClaw Runtime] 已回滚到 call ${callIndex}`);
    }
    return { kind: 'continue' };
  }

  console.warn('[ProtoClaw Runtime] 收到未处理的输入动作:', response.actionId ?? response.kind);
  return { kind: 'continue' };
}

async function main() {
  const workspaceCwd = resolveWorkspaceCwd(agentId);
  const runtimeHandoff = loadRuntimeHandoff();

  const agentModule = await import(pathToFileURL(agentJsPath).href);
  const AgentClass = resolveAgentClass(agentModule);

  if (!AgentClass) {
    throw new Error(`无法在 ${agentJsPath} 中找到 Agent 类导出`);
  }

  agent = new AgentClass({
    name: agentName,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir: workspaceCwd || PROTOCLAW_ROOT,
  });

  if (runtimeHandoff?.handoff && (runtimeHandoff.handoff.sourceSummary || runtimeHandoff.handoff.seedMessages?.length)) {
    const localFeatures = await import(pathToFileURL(join(PROTOCLAW_ROOT, 'local-features', 'dist', 'index.js')).href);
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
  console.log(`[ProtoClaw Runtime] 正在连接到 ViewerWorker (端口 ${VIEWER_PORT})...`);

  await agent.withViewer(agentName, VIEWER_PORT, false, {
    projectRoot: PROTOCLAW_ROOT,
  });

  console.log('[ProtoClaw Runtime] ✓ 已连接到 ViewerWorker');
  console.log(`[ProtoClaw Runtime] Viewer Agent ID: ${agent.agentId ?? 'unknown'}`);

  try {
    if (typeof agent.startQQBotGateway === 'function') {
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
    console.error('[ProtoClaw Runtime] QQBot Gateway 启动失败，已降级为仅调试运行:', error);
  }

  const userInput = agent.features?.get?.('user-input');
  const hasUserInput = Boolean(userInput && typeof userInput.getUserInput === 'function');

  if (sessionId) {
    try {
      await agent.loadSession(sessionId, sessionStore);
      console.log('[ProtoClaw Runtime] ✓ 已恢复会话: ' + sessionId);
    } catch {
      console.log('[ProtoClaw Runtime] 创建新会话: ' + sessionId);
    }
  } else {
    console.log('[ProtoClaw Runtime] 当前未绑定对话会话，运行在工作空间首页模式。');
  }

  // `loadSession()` only restores in-memory state. Push the restored state to Viewer
  // so history is visible immediately without waiting for the next user input.
  try {
    const messages = typeof agent.getContext === 'function' ? agent.getContext().getAll() : [];
    agent['pushToDebug']?.(messages);
    agent['syncRegisteredToolsToDebug']?.();
    agent['pushInspectorSnapshot']?.();
    agent['pushOverviewSnapshot']?.();
  } catch (error) {
    console.warn('[ProtoClaw Runtime] 恢复会话后同步调试状态失败:', error);
  }

  console.log('[ProtoClaw Runtime] READY session=' + (sessionId || 'none'));

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
      handled = await handleInputResponse(userInput, response);
    } catch (error) {
      console.error('[ProtoClaw Runtime] 处理输入动作失败，已忽略本次请求:', error);
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
      await agent.onCall(handled.text);
      if (sessionId) {
        await agent.saveSession(sessionId, sessionStore);
      }
    } catch (error) {
      console.error('[ProtoClaw Runtime] Agent 调用失败:', error);
    }
  }

  await disposeAgent(0);
}

main().catch(async (error) => {
  console.error('[ProtoClaw Runtime] 启动失败:', error);
  await disposeAgent(1);
});
