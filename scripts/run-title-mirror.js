#!/usr/bin/env node

import { dirname, join, resolve } from 'path';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { fileURLToPath } from 'url';
import { buildModelUsageMeta, reportUsageEvent } from './usage-report.js';
import {
  cleanValue,
  sanitizeSessionFragment,
  resolveWorkspaceCwd,
  createTextOnlyMirrorAgent,
  loadMirrorSession,
  tuneMirrorLLM,
  TITLE_RULES,
  buildTitleMessages,
  sanitizeGeneratedTitle,
} from './mirror-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';

function logPhase(message) {
  process.stderr.write(`[title-mirror] ${message}\n`);
}

const TITLE_TOOL = {
  name: 'record_session_title',
  description: '提交为当前会话生成的简洁标题。这是唯一允许的输出方式。',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '10-30个中文字符或3-8个英文单词的会话标题',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

const LLM_RETRY_BASE_MS = 1000;
const LLM_MAX_RETRIES = 3;

function _isTransientLLMError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (/\b(429|rate.?limit|too many requests)\b/.test(msg)) return true;
  if (/\b(500|502|503|504|internal server error|bad gateway|service unavailable|gateway timeout)\b/.test(msg)) return true;
  if (/\b(econnreset|etimedout|enotfound|eai_again|socket hang up|fetch failed|aborted)\b/.test(msg)) return true;
  return false;
}

async function chatWithRetry(llm, messages, tools, phaseLogger) {
  let lastError = null;
  for (let retry = 0; retry <= LLM_MAX_RETRIES; retry += 1) {
    try {
      return await llm.chat(messages, tools);
    } catch (error) {
      lastError = error;
      if (retry < LLM_MAX_RETRIES && _isTransientLLMError(error)) {
        const delayMs = LLM_RETRY_BASE_MS * Math.pow(2, retry); // 1s → 2s → 4s
        phaseLogger(`llm chat failed (retry ${retry + 1}/${LLM_MAX_RETRIES}): ${error?.message || error} — backing off ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw error;
      }
    }
  }
  throw lastError;
}

async function runTitleGeneration({ agentDir, agentId, sessionId }) {
  logPhase(`load title context agent=${agentId} session=${sessionId}`);
  const modelRole = 'system';
  const resolvedModel = resolveAgentModelLLM(agentDir, modelRole);
  if (!resolvedModel?.llm) {
    throw new Error(`Model preset not resolved for agent: ${agentId} role=${modelRole}`);
  }

  logPhase(`using model preset role=${modelRole} model=${resolvedModel.modelName}`);
  tuneMirrorLLM(resolvedModel.llm, 2048);

  const workspaceDir = resolveWorkspaceCwd(agentId, PROTOCLAW_ROOT, sessionId);
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
  const compiledTools = [TITLE_TOOL];

    logPhase(`chat begin role=${modelRole} messages=${compactMessages.length} tools=${compiledTools.length}`);
  try {
    const response = await chatWithRetry(resolvedModel.llm, compactMessages, compiledTools, logPhase);
    logPhase('chat done');
    await reportUsageEvent(SERVER_ORIGIN, {
      eventId: ['title-mirror', agentId, sessionId, Date.now()].join(':'),
      timestamp: Date.now(),
      source: 'title-mirror',
      agentId,
      sessionId,
      jobId: `title:${sessionId}`,
      requestCount: 1,
      cacheHitRequests: response?.usage?.cacheReadTokens ? 1 : 0,
      model: buildModelUsageMeta(resolvedModel, modelRole),
      usage: response?.usage,
      context: {
        contextInputTokens: response?.usage?.inputTokens || 0,
        messageCount: compactMessages.length,
      },
    });

    const toolCalls = Array.isArray(response?.toolCalls) ? response.toolCalls : [];
    const titleCall = toolCalls.find((toolCall) => toolCall?.name === TITLE_TOOL.name);
    const toolArgs = typeof titleCall?.arguments === 'string'
      ? (() => { try { return JSON.parse(titleCall.arguments); } catch { return {}; } })()
      : (titleCall?.arguments || {});
    const rawTitle = typeof toolArgs?.title === 'string'
      ? toolArgs.title
      : (typeof response?.content === 'string' ? response.content : '');
    const cleanTitle = sanitizeGeneratedTitle(rawTitle);
    if (cleanTitle) {
      logPhase(`title="${cleanTitle}"`);
      return { title: cleanTitle, source: 'model' };
    }

    logPhase(`model returned empty title, role=${modelRole} stopReason=${response?.stopReason || ''} raw response keys=${Object.keys(response || {}).join(',')} toolCalls=${toolCalls.length} content=${JSON.stringify(response?.content)?.slice(0, 200)} reasoning=${JSON.stringify(response?.reasoning)?.slice(0, 120)}`);
    throw new Error(`System title model "${resolvedModel.modelName}" returned an empty response`);
  } finally {
    if (typeof agent.dispose === 'function') {
      await agent.dispose().catch(e => console.warn(e));
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
        source: result.source || 'model',
      };
      writeFileSync(resultPath, `${JSON.stringify(payload)}\n`, 'utf8');
      process.exit(0);
    } catch (error) {
      lastFailure = error;
      logPhase(`attempt ${attempt}/${maxAttempts} failed: ${error?.message || error}`);
      if (attempt < maxAttempts) {
        const delayMs = 2000 * Math.pow(2, attempt - 1); // 2s → 4s → 8s
        logPhase(`backoff ${delayMs}ms before retry`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown title mirror failure'));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[title-mirror] fatal: ${message}\n`);
  process.exit(1);
});
