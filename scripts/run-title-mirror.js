#!/usr/bin/env node

import { dirname, join, resolve } from 'path';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { buildTrimmedSeedMessages, normalizeExportPolicy } from '../server/context-continuity/handoff-package.js';
import { fileURLToPath } from 'url';
import {
  cleanValue,
  sanitizeSessionFragment,
  resolveWorkspaceCwd,
  createTextOnlyMirrorAgent,
  loadMirrorSession,
} from './mirror-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');

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
- 不要复述系统提示或工具说明
- 严禁调用工具 严禁描述思考过程
- 直接输出标题文本且只能输出一行，不要输出任何其他内容`;

function buildTitleMessages(rawMessages) {
  const trimPolicy = normalizeExportPolicy({
    includeSystemMessages: false,
    assistantToolCallMode: 'fold',
    toolMessageMode: 'fold',
    toolFoldScope: 'all',
  });
  const { seedMessages, stats } = buildTrimmedSeedMessages(rawMessages, trimPolicy);
  logPhase(`trim stats: original=${stats.originalMessageCount} kept=${stats.keptSeedMessageCount} folded_notes=${stats.foldedToolNoteCount}`);

  const compactMessages = seedMessages.slice(-24).map((message, index) => ({
    role: message.role,
    content: typeof message.content === 'string' ? message.content : '',
    turn: Number.isFinite(message.turn) ? Number(message.turn) : index,
  }));

  const firstNonSystemIndex = compactMessages.findIndex((message) => message.role !== 'system');
  const firstNonSystemRole = firstNonSystemIndex >= 0 ? compactMessages[firstNonSystemIndex]?.role : '';
  if (firstNonSystemIndex === -1) {
    compactMessages.unshift({
      role: 'user',
      content: '以下是一个会话的历史片段，请基于这些内容生成标题。',
      turn: -1,
    });
    logPhase('prepended synthetic user anchor because trimmed context contained no non-system messages');
  } else if (firstNonSystemRole !== 'user') {
    compactMessages.splice(firstNonSystemIndex, 0, {
      role: 'user',
      content: '以下是从会话中截取的历史片段，请基于后续内容生成标题。',
      turn: Number.isFinite(compactMessages[firstNonSystemIndex]?.turn)
        ? Number(compactMessages[firstNonSystemIndex].turn) - 0.5
        : -1,
    });
    logPhase(`prepended synthetic user anchor before first non-system role=${firstNonSystemRole}`);
  }

  compactMessages.push({
    role: 'user',
    content: TITLE_PROMPT,
    turn: compactMessages.length,
  });

  return compactMessages;
}

function sanitizeGeneratedTitle(title) {
  const line = cleanValue(title)
    .replace(/^["'""''«»]+|["'""''«»]+$/g, '')
    .replace(/[。！？!?,，、:：;；]+$/g, '')
    .replace(/\s+/g, ' ')
    .split('\n')[0]
    .trim();
  if (!line) return '';
  return line.slice(0, 60);
}

function buildHeuristicTitle(rawMessages) {
  const userMessages = rawMessages
    .filter((message) => message.role === 'user' && cleanValue(message.content))
    .map((message) => message.content);
  const lastUser = cleanValue(userMessages[userMessages.length - 1] || '');
  if (!lastUser) return '新对话';

  const cleaned = lastUser
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:\\[^\s]+/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const segments = cleaned
    .split(/[。！？!?；;\n\r]/)
    .map((part) => part.trim())
    .filter(Boolean);

  const candidate = segments.find((part) => part.length >= 8) || segments[0] || cleaned;
  const normalized = candidate
    .replace(/^(请|帮我|麻烦|看看|你看下|你看一下|需要|想要)\s*/u, '')
    .replace(/^(这个|当前|现在)?项目(里|中)?的?/u, '')
    .replace(/还是有/g, '')
    .replace(/[“”"'`]/g, '')
    .replace(/[，,、:：;；]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (/会话标题|session title|标题生成/i.test(normalized) && /空|empty|报错|失败/i.test(normalized)) {
    return '修复会话标题生成空内容报错';
  }

  return sanitizeGeneratedTitle(normalized) || '新对话';
}

async function runTitleGeneration({ agentDir, agentId, sessionId }) {
  logPhase(`load title context agent=${agentId} session=${sessionId}`);
  const resolvedModel = resolveAgentModelLLM(agentDir, 'system');
  if (!resolvedModel?.llm) {
    throw new Error(`Model preset not resolved for agent: ${agentId}`);
  }

  logPhase(`using model preset role=system model=${resolvedModel.modelName}`);
  tuneTitleLLM(resolvedModel.llm);

  const workspaceDir = resolveWorkspaceCwd(agentId, PROTOCLAW_ROOT);
  const agent = createTextOnlyMirrorAgent({
    llm: resolvedModel.llm,
    modelName: resolvedModel.modelName,
    name: `${sanitizeSessionFragment(agentId)}-title-mirror`,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir,
    systemPrompt: '你是一个只负责生成会话标题的轻量 mirror agent。你不能调用工具，只能基于已恢复的历史会话文本直接输出标题。',
  });

  await loadMirrorSession(agent, agentId, sessionId);
  const rawMessages = typeof agent.getContext === 'function' ? agent.getContext().getAll() : [];
  logPhase(`session restored via mirror agent messages=${rawMessages.length}`);
  if (rawMessages.length === 0) {
    throw new Error('Mirror agent restored an empty session context');
  }

  const compactMessages = buildTitleMessages(rawMessages);
  const compiledTools = [];

  logPhase(`chat begin messages=${compactMessages.length} tools=${compiledTools.length}`);
  try {
    const response = await resolvedModel.llm.chat(compactMessages, compiledTools);
    logPhase('chat done');

    const rawTitle = typeof response?.content === 'string' ? response.content : '';
    const cleanTitle = sanitizeGeneratedTitle(rawTitle);
    if (cleanTitle) {
      logPhase(`title="${cleanTitle}"`);
      return { title: cleanTitle, source: 'model' };
    }

    const fallbackTitle = buildHeuristicTitle(rawMessages);
    logPhase(`raw response keys=${Object.keys(response || {}).join(',')} content=${JSON.stringify(response?.content)?.slice(0, 200)} reasoning=${JSON.stringify(response?.reasoning)?.slice(0, 120)}`);
    logPhase(`fallback title="${fallbackTitle}"`);
    return { title: fallbackTitle, source: 'fallback' };
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
  const resultPath = resultFilePath || join(mkdtempSync(join(tmpdir(), 'title-mirror-')), 'result.json');

  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runTitleGeneration({
        agentDir: agentPath,
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
