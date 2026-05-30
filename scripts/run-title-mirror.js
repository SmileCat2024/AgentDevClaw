#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import os from 'os';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { FileSessionStore } from 'agentdev';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { buildTrimmedSeedMessages, normalizeExportPolicy } from '../server/context-continuity/handoff-package.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const WORKSPACE_BOUND_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);

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

function resolveWorkspaceCwd(agentId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (!WORKSPACE_BOUND_AGENT_IDS.has(normalizedAgentId)) {
    return PROTOCLAW_ROOT;
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

function logPhase(message) {
  process.stderr.write(`[title-mirror] ${message}\n`);
}

function tuneTitleLLM(llm) {
  if (!llm || typeof llm !== 'object') return;
  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingBudgetTokens')) {
      llm.thinkingBudgetTokens = undefined;
    }
  } catch {}
  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'maxTokens')) {
      const current = Number(llm.maxTokens);
      llm.maxTokens = Number.isFinite(current) && current > 0
        ? Math.min(current, 1024)
        : 1024;
    }
  } catch {}
}

const TITLE_PROMPT = `以上是一段对话的完整历史记录。请直接为这段对话生成一个简洁的标题并输出。

要求：
- 以用户最后一轮输入的请求为核心叙述点
- 标题应体现当前工作进展和涉及的关键内容
- 10-30个中文字符（英文 3-8 个单词）
- 不要使用引号或标点符号
- 直接输出标题文本，不要输出任何其他内容，不要调用任何工具`;

async function runTitleGeneration({ agentJsPath, agentName, agentId, sessionId }) {
  logPhase(`load agent module agent=${agentId} session=${sessionId}`);
  const agentModule = await import(pathToFileURL(agentJsPath).href);
  const AgentClass = resolveAgentClass(agentModule);
  if (!AgentClass) {
    throw new Error(`Unable to resolve Agent class from ${agentJsPath}`);
  }

  const workspaceDir = resolveWorkspaceCwd(agentId);
  const sessionStore = new FileSessionStore(getSessionStoreDir(agentId));
  const agentDir = resolve(dirname(agentJsPath));
  const resolvedModel = resolveAgentModelLLM(agentDir, 'system');

  delete process.env.PROTOCLAW_SESSION_TYPE;

  const agent = new AgentClass({
    name: agentName,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir,
    ...(resolvedModel ? { llm: resolvedModel.llm } : {}),
    maxTurns: 1,
  });
  if (resolvedModel) {
    logPhase(`using model preset role=system model=${resolvedModel.modelName}`);
    try {
      const ctx = typeof agent.getSystemContext === 'function' ? agent.getSystemContext() : agent._systemContext;
      if (ctx) ctx.SYSTEM_CURRENT_MODEL = resolvedModel.modelName;
    } catch {}
  }

  try {
    logPhase('prepare runtime begin');
    if (typeof agent.prepareRuntime === 'function') {
      await agent.prepareRuntime();
    }
    logPhase('prepare runtime done');

    logPhase('load session begin');
    await agent.loadSession(sessionId, sessionStore);
    logPhase('load session done');

    tuneTitleLLM(agent.llm);

    // Disable all tools — title generation is pure text output
    const toolRegistry = typeof agent.getTools === 'function' ? agent.getTools() : null;
    const toolEntries = toolRegistry?.getEntries?.() || [];
    logPhase(`disable tools count=${toolEntries.length}`);
    for (const entry of toolEntries) {
      const toolName = typeof entry?.tool?.name === 'string' ? entry.tool.name : '';
      if (!toolName) continue;
      toolRegistry.disable(toolName);
    }
    // Title generation needs no tools — compiledTools stays empty
    const compiledTools = [];

    const context = typeof agent.getContext === 'function' ? agent.getContext() : null;
    const rawMessages = Array.isArray(context?.getAll?.()) ? context.getAll() : [];
    logPhase(`raw messages count=${rawMessages.length}`);

    // Run the same trim pipeline used by compact/trim operations
    // to fold tool activity and produce clean text-only context
    const trimPolicy = normalizeExportPolicy({
      includeSystemMessages: true,
      assistantToolCallMode: 'fold',
      toolMessageMode: 'fold',
      toolFoldScope: 'all',
    });
    const { seedMessages, stats } = buildTrimmedSeedMessages(rawMessages, trimPolicy);
    logPhase(`trim stats: original=${stats.originalMessageCount} kept=${stats.keptSeedMessageCount} folded_notes=${stats.foldedToolNoteCount}`);

    const compactMessages = seedMessages;
    const callIndex = compactMessages.length;

    compactMessages.push({
      role: 'user',
      content: TITLE_PROMPT,
      turn: callIndex,
    });

    logPhase(`chat begin messages=${compactMessages.length} tools=${compiledTools.length}`);
    const response = await agent.llm.chat(compactMessages, compiledTools);
    logPhase('chat done');

    let title = typeof response?.content === 'string' ? response.content.trim() : '';
    if (!title) {
      logPhase(`raw response keys=${Object.keys(response || {}).join(',')} content=${JSON.stringify(response?.content)?.slice(0, 200)}`);
      throw new Error('Title generation returned empty result');
    }

    const cleanTitle = title
      .replace(/^["'""''«»]+|["'""''«»]+$/g, '')
      .replace(/\n.*/g, '')
      .trim()
      .slice(0, 60);

    logPhase(`title="${cleanTitle}"`);
    return { title: cleanTitle };
  } finally {
    if (typeof agent.dispose === 'function') {
      await agent.dispose().catch(() => {});
    }
  }
}

async function main() {
  const [agentDir, agentId, sessionId, rawOptions, resultFilePath] = process.argv.slice(2);
  if (!agentDir || !agentId || !sessionId) {
    throw new Error('Usage: node scripts/run-title-mirror.js <agent-dir> <agent-id> <session-id> [optionsJson] [resultFilePath]');
  }

  const maxAttempts = (() => {
    if (!rawOptions) return 3;
    try {
      const parsed = JSON.parse(String(rawOptions));
      const n = Number(parsed?.maxAttempts);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 5) : 3;
    } catch { return 3; }
  })();

  const agentPath = resolve(PROTOCLAW_ROOT, agentDir);
  const agentJsPath = join(agentPath, 'agent.js');
  const resultPath = resultFilePath || join(mkdtempSync(join(tmpdir(), 'title-mirror-')), 'result.json');

  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runTitleGeneration({
        agentJsPath,
        agentName: sanitizeSessionFragment(agentId),
        agentId,
        sessionId,
      });

      if (!cleanValue(result.title)) {
        throw new Error('Title generation returned empty result — retrying');
      }

      const payload = {
        ok: true,
        attemptCount: attempt,
        title: result.title,
      };
      writeFileSync(resultPath, `${JSON.stringify(payload)}\n`, 'utf8');
      process.exit(0);
    } catch (error) {
      lastFailure = error;
      logPhase(`attempt ${attempt}/${maxAttempts} failed: ${error?.message || error}`);
    }
  }

  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown title mirror failure'));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[title-mirror] fatal: ${message}\n`);
  process.exit(1);
});
