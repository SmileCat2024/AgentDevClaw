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
import { buildClaudeCompactPrompt, stripCompactAnalysis, scanFilesAndSkills } from '../server/context-continuity/claude-compact-prompts.js';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const VIEWER_PORT = parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';
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
let compactSummaryInFlight = false;

function getNextTurnActions() {
  const checkpoints = Array.isArray(agent?._callCheckpoints) ? agent._callCheckpoints : [];
  return checkpoints.length > 0 ? NEXT_TURN_ACTIONS : undefined;
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

function tuneSummaryLLM(llm) {
  if (!llm || typeof llm !== 'object') return () => {};
  const restore = new Map();
  const remember = (key) => {
    if (Object.prototype.hasOwnProperty.call(llm, key)) {
      restore.set(key, llm[key]);
    }
  };
  remember('thinkingBudgetTokens');
  remember('maxTokens');
  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingBudgetTokens')) {
      llm.thinkingBudgetTokens = undefined;
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'maxTokens')) {
      const current = Number(llm.maxTokens);
      llm.maxTokens = Number.isFinite(current) && current > 0 ? Math.min(current, 2500) : 2500;
    }
  } catch {}
  return () => {
    for (const [key, value] of restore.entries()) {
      try { llm[key] = value; } catch {}
    }
  };
}

function shouldPreserveSummaryTools(agentInstance) {
  const modelName = cleanValue(
    agentInstance?.getSystemContext?.()?.SYSTEM_CURRENT_MODEL
    || agentInstance?._systemContext?.SYSTEM_CURRENT_MODEL
    || '',
  ).toLowerCase();
  return modelName.includes('claude');
}

async function generateInProcessSummary(extraInstructions = '') {
  const context = typeof agent?.getContext === 'function' ? agent.getContext() : null;
  const rawMessages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
  if (rawMessages.length === 0) {
    throw new Error('当前上下文为空，无法生成摘要');
  }

  const prompt = buildClaudeCompactPrompt({
    additionalInstructions: extraInstructions,
  });
  const messages = rawMessages.map((message, index) => ({
    role: message.role,
    content: typeof message?.content === 'string' ? message.content : '',
    turn: Number.isFinite(message?.turn) ? Number(message.turn) : index,
    toolCallId: message?.toolCallId,
    toolCalls: Array.isArray(message?.toolCalls) ? message.toolCalls : undefined,
    reasoning: typeof message?.reasoning === 'string' ? message.reasoning : undefined,
    thinkingBlocks: Array.isArray(message?.thinkingBlocks) ? message.thinkingBlocks : undefined,
  }));
  messages.push({
    role: 'user',
    content: prompt,
    turn: typeof agent?._callIndex === 'number' ? Number(agent._callIndex) + 1 : messages.length,
  });

  const toolRegistry = typeof agent?.getTools === 'function' ? agent.getTools() : null;
  const allTools = toolRegistry?.getAll?.() || [];
  const compactTool = allTools.find(t => t.name === 'record_compaction_context');
  let tools = shouldPreserveSummaryTools(agent) ? allTools : [];
  if (compactTool && !tools.includes(compactTool)) {
    tools = [compactTool];
  }
  const restoreLLM = tuneSummaryLLM(agent?.llm);
  try {
    console.log(`[ProtoClaw Runtime] 开始进程内摘要压缩 messages=${messages.length} tools=${tools.length}`);
    const response = await agent.llm.chat(messages, tools);
    const rawResponse = typeof response?.content === 'string' ? response.content : '';
    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    if (toolCalls.some(tc => tc?.name !== 'record_compaction_context')) {
      throw new Error('摘要模型错误地触发了工具调用');
    }
    const compactCall = toolCalls.find(tc => tc?.name === 'record_compaction_context');

    let importantFiles = [];
    let importantSkills = [];
    let sessionTitle = '';
    let summaryText = '';

    if (compactCall && compactCall.arguments) {
      const args = typeof compactCall.arguments === 'string'
        ? (() => { try { return JSON.parse(compactCall.arguments); } catch { return {}; } })()
        : compactCall.arguments;
      summaryText = typeof args.summary === 'string' ? args.summary.trim() : '';
      sessionTitle = typeof args.session_title === 'string' ? args.session_title.trim() : '';
      importantFiles = Array.isArray(args.important_files)
        ? args.important_files.filter(f => typeof f === 'string')
        : [];
      importantSkills = Array.isArray(args.important_skills)
        ? args.important_skills.filter(s => typeof s === 'string')
        : [];
    }

    if (!summaryText) {
      summaryText = stripCompactAnalysis(rawResponse);
    }

    if (!summaryText.trim()) {
      throw new Error('摘要模型返回了空结果');
    }
    const { fileRanges } = scanFilesAndSkills(rawMessages);
    return {
      rawResponse,
      summaryText,
      importantFiles,
      importantSkills,
      sessionTitle,
      fileRanges,
    };
  } finally {
    restoreLLM();
  }
}

async function triggerSummaryCompaction(extraInstructions = '') {
  if (compactSummaryInFlight) {
    console.warn('[ProtoClaw Runtime] 已有 compact summary 正在进行，本次请求已忽略。');
    return;
  }
  if (!sessionId) {
    console.warn('[ProtoClaw Runtime] 当前 runtime 未绑定 session，无法触发 compact summary。');
    return;
  }

  compactSummaryInFlight = true;
  try {
    await agent.saveSession(sessionId, sessionStore);
    console.log('[ProtoClaw Runtime] 已保存当前 session，开始进程内摘要压缩...');
    const summaryResult = await generateInProcessSummary(extraInstructions);

    const result = await postJson('/protoclaw/context_handoffs/summary_export', {
      agentId,
      sessionId,
      summaryText: summaryResult.summaryText,
      rawResponse: summaryResult.rawResponse,
      importantFiles: summaryResult.importantFiles || [],
      importantSkills: summaryResult.importantSkills || [],
      sessionTitle: summaryResult.sessionTitle || '',
      fileRanges: summaryResult.fileRanges || {},
      policy: {
        strategy: 'summarized-nine-section',
        additionalInstructions: extraInstructions || '',
      },
    });

    const handoffId = cleanValue(result?.handoff?.handoffId);
    const handoffPath = cleanValue(result?.handoffPath);
    const mode = cleanValue(result?.handoff?.mode);
    console.log(`[ProtoClaw Runtime] Compact summary 已生成: mode=${mode || 'summarized-nine-section'} handoffId=${handoffId || '(none)'}`);
    if (handoffPath) {
      console.log(`[ProtoClaw Runtime] Handoff path: ${handoffPath}`);
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] Compact summary 失败:', error);
  } finally {
    compactSummaryInFlight = false;
  }
}

async function triggerSummaryCompactionResume(extraInstructions = '') {
  if (compactSummaryInFlight) {
    console.warn('[ProtoClaw Runtime] 已有 compact summary 正在进行，本次请求已忽略。');
    return;
  }
  if (!sessionId) {
    console.warn('[ProtoClaw Runtime] 当前 runtime 未绑定 session，无法触发 compact summary resume。');
    return;
  }

  compactSummaryInFlight = true;
  try {
    await agent.saveSession(sessionId, sessionStore);
    console.log('[ProtoClaw Runtime] 已保存当前 session，开始进程内摘要并创建新的 resume 会话...');
    const summaryResult = await generateInProcessSummary(extraInstructions);

    const result = await postJson('/protoclaw/context_handoffs/summary_resume', {
      agentId,
      sessionId,
      summaryText: summaryResult.summaryText,
      rawResponse: summaryResult.rawResponse,
      importantFiles: summaryResult.importantFiles || [],
      importantSkills: summaryResult.importantSkills || [],
      sessionTitle: summaryResult.sessionTitle || '',
      fileRanges: summaryResult.fileRanges || {},
      policy: {
        strategy: 'summarized-nine-section',
        additionalInstructions: extraInstructions || '',
      },
    });

    const nextSessionId = cleanValue(result?.session?.id);
    console.log(`[ProtoClaw Runtime] 摘要 resume 已创建: newSession=${nextSessionId || '(none)'}`);
  } catch (error) {
    console.error('[ProtoClaw Runtime] compact summary resume 失败:', error);
  } finally {
    compactSummaryInFlight = false;
  }
}

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
    if (text.startsWith('/compact-summary-resume')) {
      const extraInstructions = text.slice('/compact-summary-resume'.length).trim();
      void triggerSummaryCompactionResume(extraInstructions);
      return { kind: 'continue' };
    }
    if (text.startsWith('/compact-summary')) {
      const extraInstructions = text.slice('/compact-summary'.length).trim();
      void triggerSummaryCompaction(extraInstructions);
      return { kind: 'continue' };
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

  const resolved = resolveAgentModelLLM(agentPath, 'default');
  agent = new AgentClass({
    name: agentName,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir: workspaceCwd || PROTOCLAW_ROOT,
    ...(resolved ? { llm: resolved.llm } : {}),
  });
  if (resolved) {
    console.log(`[ProtoClaw Runtime] Using model preset from metadata.json => ${resolved.modelName}`);
    try {
      const ctx = typeof agent.getSystemContext === 'function' ? agent.getSystemContext() : agent._systemContext;
      if (ctx) ctx.SYSTEM_CURRENT_MODEL = resolved.modelName;
    } catch {}
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
  console.log(`[ProtoClaw Runtime] 正在连接到 ViewerWorker (端口 ${VIEWER_PORT})...`);

  await agent.withViewer(agentName, VIEWER_PORT, false, {
    projectRoot: PROTOCLAW_ROOT,
  });

  console.log('[ProtoClaw Runtime] ✓ 已连接到 ViewerWorker');
  console.log(`[ProtoClaw Runtime] Viewer Agent ID: ${agent.agentId ?? 'unknown'}`);

  try {
    if (typeof agent.startSelectedIMGateway === 'function') {
      const channel = await agent.startSelectedIMGateway();
      console.log(`[ProtoClaw Runtime] ✓ 已启动 IM Gateway (${channel || 'unknown'})`);
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

  // Start ClawDispatch loop if feature is mounted
  try {
    const dispatchFeature = agent.features?.get?.('claw-dispatch');
    if (dispatchFeature && typeof dispatchFeature.startDispatchLoop === 'function') {
      await dispatchFeature.startDispatchLoop(agent);
      console.log('[ProtoClaw Runtime] ✓ 已启动 ClawDispatch loop');
    }
  } catch (error) {
    console.error('[ProtoClaw Runtime] ClawDispatch 启动失败:', error);
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
    } catch (error) {
      console.error('[ProtoClaw Runtime] Agent 调用失败:', error);
    }
    if (sessionId) {
      await agent.saveSession(sessionId, sessionStore).catch(e => {
        console.warn('[ProtoClaw Runtime] 保存 session 失败:', e.message);
      });
    }

    // 注意：队列消息现在在 step 级别检查（react-loop 内部），不再在这里处理
  }

  await disposeAgent(0);
}

main().catch(async (error) => {
  console.error('[ProtoClaw Runtime] 启动失败:', error);
  await disposeAgent(1);
});
