#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import os from 'os';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { FileSessionStore } from 'agentdev';
import { buildClaudeCompactPrompt, stripCompactAnalysis, scanFilesAndSkills } from '../server/context-continuity/claude-compact-prompts.js';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { execSync } from 'child_process';
import { tuneMirrorLLM } from './mirror-runtime.js';
import { buildModelUsageMeta, reportUsageEvent } from './usage-report.js';
import { WORKSPACE_SESSION_AGENT_IDS } from '../server/shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';
// 权威集合来自 server/shared/constants.js（服务端与所有脚本必须同源）
const WORKSPACE_BOUND_AGENT_IDS = WORKSPACE_SESSION_AGENT_IDS;

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
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
  for (const exported of Object.values(agentModule || {})) {
    if (typeof exported === 'function') {
      return exported;
    }
  }
  return null;
}

function getSessionStoreDir(agentId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (WORKSPACE_BOUND_AGENT_IDS.has(normalizedAgentId)) {
    return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', normalizedAgentId, 'sessions');
  }
  return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions', normalizedAgentId);
}

function resolveSessionWorkspaceCwd(agentId, sessionId) {
  const normalizedSessionId = cleanValue(sessionId);
  if (!normalizedSessionId || normalizedSessionId === '__protoclaw-no-session__') {
    return null;
  }

  const indexPath = join(getSessionStoreDir(agentId), 'index.json');
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
  } catch {
    return null;
  }
}

function resolveWorkspaceCwd(agentId, sessionId = '') {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (!WORKSPACE_BOUND_AGENT_IDS.has(normalizedAgentId)) {
    return PROTOCLAW_ROOT;
  }

  const sessionCwd = resolveSessionWorkspaceCwd(agentId, sessionId);
  if (sessionCwd) {
    return sessionCwd;
  }

  const statePath = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', normalizedAgentId, 'state.json');
  if (!existsSync(statePath)) {
    return PROTOCLAW_ROOT;
  }

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const openDirectory = typeof state?.openDirectory === 'string' ? state.openDirectory.trim() : '';
    if (!openDirectory || !existsSync(openDirectory)) {
      return PROTOCLAW_ROOT;
    }
    return openDirectory;
  } catch {
    return PROTOCLAW_ROOT;
  }
}

function parseOptions(rawOptions) {
  const defaults = {
    maxAttempts: 3,
    additionalInstructions: '',
    promptOverride: '',
    sessionType: '',
  };
  if (!rawOptions) return defaults;
  try {
    const parsed = JSON.parse(String(rawOptions));
    return {
      maxAttempts: Number.isFinite(parsed?.maxAttempts) ? Math.max(1, Math.min(5, Number(parsed.maxAttempts))) : defaults.maxAttempts,
      additionalInstructions: cleanValue(parsed?.additionalInstructions),
      promptOverride: cleanValue(parsed?.promptOverride),
      sessionType: cleanValue(parsed?.sessionType),
    };
  } catch {
    return defaults;
  }
}

function logPhase(message) {
  process.stderr.write(`[compact-mirror] ${message}\n`);
}

function collectGitMeta(workspaceDir) {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspaceDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const commitHash = execSync('git rev-parse --short HEAD', { cwd: workspaceDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const commitMessage = execSync('git log -1 --format=%s', { cwd: workspaceDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const isDirty = execSync('git status --porcelain', { cwd: workspaceDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().length > 0;
    return { branch, commitHash, commitMessage, isDirty };
  } catch {
    return null;
  }
}

function extractSessionTimestamp(sessionDir, sessionId) {
  try {
    const filePath = join(sessionDir, `${sessionId}.json`);
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    // savedAt may be a numeric timestamp (ms) or an ISO string
    const savedAt = raw.savedAt;
    if (typeof savedAt === 'number' && savedAt > 0) {
      return new Date(savedAt).toISOString();
    }
    if (typeof savedAt === 'string' && savedAt) {
      return savedAt;
    }
    return null;
  } catch {
    return null;
  }
}

function shouldPreserveToolSchema(agent) {
  const modelName = cleanValue(
    agent?.getSystemContext?.()?.SYSTEM_CURRENT_MODEL
    || agent?._systemContext?.SYSTEM_CURRENT_MODEL
    || '',
  ).toLowerCase();
  return modelName.includes('claude');
}

async function runSingleAttempt({ agentJsPath, agentName, agentId, sessionId, sessionType, prompt }) {
  logPhase(`load agent module agent=${agentId} session=${sessionId}`);
  const agentModule = await import(pathToFileURL(agentJsPath).href);
  const AgentClass = resolveAgentClass(agentModule);
  if (!AgentClass) {
    throw new Error(`Unable to resolve Agent class from ${agentJsPath}`);
  }

  const workspaceDir = resolveWorkspaceCwd(agentId, sessionId);
  const sessionStore = new FileSessionStore(getSessionStoreDir(agentId));
  const localFeatures = await import(pathToFileURL(join(PROTOCLAW_ROOT, 'local-features', 'dist', 'index.js')).href);
  // 摘要属于辅助任务，走 system 角色模型（与 run-title-mirror 同一约定）；
  // 未配置 system 角色时 resolver 回退 default，行为与旧版一致。
  const modelPresetRole = sessionType === 'exploration'
    ? 'exploration'
    : sessionType === 'sub'
      ? 'sub'
      : 'system';
  const agentDir = resolve(dirname(agentJsPath));
  const resolvedModel = resolveAgentModelLLM(agentDir, modelPresetRole);

  if (typeof localFeatures.ContextCompactionMirrorFeature !== 'function') {
    throw new Error('ContextCompactionMirrorFeature is not built');
  }

  // Set environment variable based on session type before creating Agent
  // This ensures the Agent uses the correct mode (exploration vs normal)
  if (sessionType === 'exploration' || sessionType === 'sub') {
    process.env.PROTOCLAW_SESSION_TYPE = 'exploration';
    logPhase(`set exploration mode for sessionType=${sessionType}`);
  } else {
    delete process.env.PROTOCLAW_SESSION_TYPE;
    logPhase(`set normal mode for sessionType=${sessionType || 'main'}`);
  }

  const agent = new AgentClass({
    name: agentName,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir,
    ...(resolvedModel ? { llm: resolvedModel.llm } : {}),
    maxTurns: 1,
  });
  if (resolvedModel) {
    logPhase(`using model preset role=${modelPresetRole} model=${resolvedModel.modelName}`);
    try {
      const ctx = typeof agent.getSystemContext === 'function' ? agent.getSystemContext() : agent._systemContext;
      if (ctx) ctx.SYSTEM_CURRENT_MODEL = resolvedModel.modelName;
    } catch {}
  }

  try {
    // Mount Feature BEFORE prepareRuntime (same order as main agent)
    if (typeof localFeatures.ContextCompactionControlFeature === 'function') {
      agent.use(new localFeatures.ContextCompactionControlFeature({
        serverOrigin: 'http://127.0.0.1:1420',
        agentId,
        sessionId,
      }));
      logPhase('ContextCompactionControlFeature mounted');
    }

    logPhase('prepare runtime begin');
    if (typeof agent.prepareRuntime === 'function') {
      await agent.prepareRuntime();
    }
    logPhase('prepare runtime done');

    logPhase('load session begin');
    await agent.loadSession(sessionId, sessionStore);
    logPhase('load session done');

    tuneMirrorLLM(agent.llm, 8000);

    const toolRegistry = typeof agent.getTools === 'function' ? agent.getTools() : null;
    const toolEntries = toolRegistry?.getEntries?.() || [];
    logPhase(`disable tools count=${toolEntries.length}`);
    for (const entry of toolEntries) {
      const toolName = typeof entry?.tool?.name === 'string' ? entry.tool.name : '';
      if (!toolName) continue;
      toolRegistry.disable(toolName);
    }
    if (toolRegistry && typeof toolRegistry.enable === 'function') {
      toolRegistry.enable('record_compaction_context');
      logPhase('enabled record_compaction_context');
    }

    const context = typeof agent.getContext === 'function' ? agent.getContext() : null;
    const rawMessages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
    const compactMessages = rawMessages.map((message, index) => ({
      role: message.role,
      content: typeof message?.content === 'string' ? message.content : '',
      turn: Number.isFinite(message?.turn) ? Number(message.turn) : index,
      toolCallId: message?.toolCallId,
      toolCalls: Array.isArray(message?.toolCalls) ? message.toolCalls : undefined,
    }));
    const callIndex = typeof agent?._callIndex === 'number' ? Number(agent._callIndex) + 1 : compactMessages.length;
    const { files: refFiles, skills: refSkills, fileRanges } = scanFilesAndSkills(rawMessages);
    const refLines = [];
    if (refFiles.length > 0) {
      refLines.push('## 本次会话中引用的文件');
      for (const f of refFiles) refLines.push(`- ${f}`);
      refLines.push('');
    }
    if (refSkills.length > 0) {
      refLines.push('## 本次会话中调用的技能');
      for (const s of refSkills) refLines.push(`- ${s}`);
      refLines.push('');
    }
    const enrichedPrompt = refLines.length > 0 ? `${refLines.join('\n')}\n${prompt}` : prompt;
    compactMessages.push({
      role: 'user',
      content: enrichedPrompt,
      turn: callIndex,
    });

    const allTools = toolRegistry?.getAll?.() || [];
    const targetTool = allTools.find(t => t.name === 'record_compaction_context');
    let compiledTools = shouldPreserveToolSchema(agent) ? allTools : [];
    if (targetTool && !compiledTools.includes(targetTool)) {
      compiledTools = [targetTool];
    }
    if (compiledTools.length === 0) {
      logPhase('tool schema omitted for mirror summary call');
    }

    logPhase(`chat begin messages=${compactMessages.length} tools=${compiledTools.length}`);
    const response = await agent.llm.chat(
      compactMessages,
      compiledTools,
      { noStream: true },
    );
    logPhase('chat done');

    if (response?.stopReason === 'max_tokens') {
      throw new Error('Mirror compaction 摘要因 max_tokens 限制被截断（stopReason=max_tokens）');
    }
    await reportUsageEvent(SERVER_ORIGIN, {
      eventId: ['compact-mirror', agentId, sessionId, Date.now()].join(':'),
      timestamp: Date.now(),
      source: 'compact-mirror',
      agentId,
      sessionId,
      jobId: `compact:${sessionId}`,
      requestCount: 1,
      cacheHitRequests: response?.usage?.cacheReadTokens ? 1 : 0,
      model: buildModelUsageMeta(resolvedModel, modelPresetRole),
      usage: response?.usage,
      context: {
        contextInputTokens: response?.usage?.inputTokens || 0,
        messageCount: compactMessages.length,
      },
    });

    const rawResponse = typeof response?.content === 'string' ? response.content : '';
    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    const compactCall = toolCalls.find(tc => tc?.name === 'record_compaction_context');

    if (!compactCall) {
      throw new Error('record_compaction_context tool was not called — retrying');
    }

    const args = typeof compactCall.arguments === 'string'
      ? (() => { try { return JSON.parse(compactCall.arguments); } catch { return {}; } })()
      : (compactCall.arguments || {});

    const importantFiles = Array.isArray(args.important_files)
      ? args.important_files.filter(f => typeof f === 'string')
      : [];
    const importantSkills = Array.isArray(args.important_skills)
      ? args.important_skills.filter(s => typeof s === 'string')
      : [];

    // summary: prefer tool args, fallback to text output
    let summaryText = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summaryText) {
      summaryText = stripCompactAnalysis(rawResponse);
    }

    logPhase(`tool output: files=${importantFiles.length} skills=${importantSkills.length} summary=${summaryText.length}chars`);

    const usedTools = toolCalls.some(tc => tc?.name !== 'record_compaction_context');

    return {
      rawResponse,
      summaryText,
      usedTools,
      importantFiles,
      importantSkills,
      fileRanges,
    };
  } finally {
    // Workaround for nodejs/node#56645 (Windows + Node 23+/24): closing undici
    // keep-alive sockets BEFORE handle teardown avoids the libuv assertion
    // "!(handle->flags & UV_HANDLE_CLOSING)" abort during dispose/exit.
    // close() can hang forever on live SSE/keep-alive connections, so race it
    // with a timeout and force-destroy afterwards.
    try {
      const { getGlobalDispatcher } = await import('undici');
      await Promise.race([
        getGlobalDispatcher().close(),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      getGlobalDispatcher().destroy();
    } catch {}
    if (typeof agent.dispose === 'function') {
      await agent.dispose().catch(e => console.warn(e));
    }
  }
}

async function main() {
  const [agentDir, agentId, sessionId, rawOptions, resultFilePath] = process.argv.slice(2);
  if (!agentDir || !agentId || !sessionId) {
    throw new Error('Usage: node scripts/run-compact-mirror.js <agent-dir> <agent-id> <session-id> [optionsJson] [resultFilePath]');
  }

  const options = parseOptions(rawOptions);
  const sessionType = cleanValue(options.sessionType);
  const agentPath = resolve(PROTOCLAW_ROOT, agentDir);
  const agentJsPath = join(agentPath, 'agent.js');
  const prompt = options.promptOverride || buildClaudeCompactPrompt({
    additionalInstructions: options.additionalInstructions,
    sessionType,
  });

  const workspaceDir = resolveWorkspaceCwd(agentId, sessionId);
  const gitMeta = collectGitMeta(workspaceDir);
  const sessionTimestamp = extractSessionTimestamp(getSessionStoreDir(agentId), sessionId);

  const resultPath = resultFilePath || join(mkdtempSync(join(tmpdir(), 'compact-mirror-')), 'result.json');

  let lastFailure = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      const result = await runSingleAttempt({
        agentJsPath,
        agentName: sanitizeSessionFragment(agentId),
        agentId,
        sessionId,
        sessionType,
        prompt,
      });

      if (result.usedTools) {
        throw new Error('Mirror compaction attempted tool usage');
      }
      if (!cleanValue(result.summaryText)) {
        throw new Error('Mirror compaction returned an empty summary');
      }

      const payload = {
        ok: true,
        attemptCount: attempt,
        summaryText: result.summaryText,
        rawResponse: result.rawResponse,
        importantFiles: result.importantFiles || [],
        importantSkills: result.importantSkills || [],
        fileRanges: result.fileRanges || {},
        sessionTimestamp,
        gitMeta,
      };
      writeFileSync(resultPath, `${JSON.stringify(payload)}\n`, 'utf8');
      // Same workaround as in runSingleAttempt: let libuv finish async handle
      // teardown before exiting on Windows + Node 23+/24 (nodejs/node#56645).
      await new Promise((resolve) => setTimeout(resolve, 150));
      process.exit(0);
    } catch (error) {
      lastFailure = error;
    }
  }

  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown mirror compaction failure'));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[compact-mirror] fatal: ${message}\n`);
  process.exit(1);
});
