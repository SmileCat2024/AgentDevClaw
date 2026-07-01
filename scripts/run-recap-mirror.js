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
} from './mirror-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';

function logPhase(message) {
  process.stderr.write(`[recap-mirror] ${message}\n`);
}

const RECAP_RULES = `用户刚刚回到终端，可能已经忘记之前在做什么。请根据会话历史，写一段简短的回顾，帮助用户快速恢复上下文。

要求：
- 只写 1-3 句话
- 第一句说明高层任务目标——用户在构建或调试什么，不要纠缠实现细节
- 第二句（如果有）说明具体的下一步或当前卡点
- 语言简洁直接，不要使用"根据会话记录""从对话来看"等元描述
- 不要写状态报告、提交记录或进度百分比
- 不要使用列表格式，直接用自然语言
- 用中文输出`;

const RECAP_TOOL = {
  name: 'record_recap',
  description: '提交为当前会话生成的简短回顾。这是唯一允许的输出方式。',
  parameters: {
    type: 'object',
    properties: {
      recap: {
        type: 'string',
        description: '1-3 句话的会话回顾，帮助用户回忆正在做什么和下一步',
      },
    },
    required: ['recap'],
    additionalProperties: false,
  },
};

const RECENT_MESSAGE_WINDOW = 30;

function buildRecapMessages(rawMessages) {
  const conversationalMessages = rawMessages.filter((message) => (
    (message?.role === 'user' || message?.role === 'assistant')
    && cleanValue(message?.content)
  ));
  const firstUser = conversationalMessages.find((message) => message.role === 'user');
  const recentMessages = conversationalMessages.slice(-RECENT_MESSAGE_WINDOW);
  if (firstUser && !recentMessages.includes(firstUser)) {
    recentMessages.unshift(firstUser);
  }
  logPhase(`context stats: original=${rawMessages.length} conversational=${conversationalMessages.length} kept=${recentMessages.length}`);

  const transcript = recentMessages.length > 0
    ? recentMessages.map((message, index) => {
      const speaker = message.role === 'user' ? '用户' : '助手';
      return `【${speaker} ${index + 1}】\n${cleanValue(message.content)}`;
    }).join('\n\n')
    : '（会话中没有可用的用户或助手正文）';
  return [{
    role: 'user',
    content: `以下是会话转录：\n\n${transcript}\n\n${RECAP_RULES}\n- 必须调用 record_recap 工具提交回顾，不要输出其他内容。`,
    turn: 0,
  }];
}

function sanitizeRecap(recap) {
  const text = cleanValue(recap)
    .replace(/^["'""''«»]+|["'""''«»]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.slice(0, 500);
}

async function runRecapGeneration({ agentDir, agentId, sessionId }) {
  logPhase(`load recap context agent=${agentId} session=${sessionId}`);
  const modelRole = 'system';
  const resolvedModel = resolveAgentModelLLM(agentDir, modelRole);
  if (!resolvedModel?.llm) {
    throw new Error(`Model preset not resolved for agent: ${agentId} role=${modelRole}`);
  }

  logPhase(`using model preset role=${modelRole} model=${resolvedModel.modelName}`);
  tuneMirrorLLM(resolvedModel.llm, 1024);

  const workspaceDir = resolveWorkspaceCwd(agentId, PROTOCLAW_ROOT);
  const agent = createTextOnlyMirrorAgent({
    llm: resolvedModel.llm,
    modelName: resolvedModel.modelName,
    name: `${sanitizeSessionFragment(agentId)}-recap-mirror`,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir,
    systemPrompt: '你是一个只负责生成会话回顾的轻量 mirror agent。你不能调用工具，只能基于已恢复的历史会话文本直接输出回顾。',
  });

  await loadMirrorSession(agent, agentId, sessionId);
  const rawMessages = typeof agent.getContext === 'function' ? agent.getContext().getAll() : [];
  logPhase(`session restored via mirror agent messages=${rawMessages.length}`);
  if (rawMessages.length === 0) {
    throw new Error('Mirror agent restored an empty session context');
  }

  const compactMessages = buildRecapMessages(rawMessages);
  const compiledTools = [RECAP_TOOL];

  logPhase(`chat begin role=${modelRole} messages=${compactMessages.length} tools=${compiledTools.length}`);
  try {
    const response = await resolvedModel.llm.chat(compactMessages, compiledTools);
    logPhase('chat done');
    await reportUsageEvent(SERVER_ORIGIN, {
      eventId: ['recap-mirror', agentId, sessionId, Date.now()].join(':'),
      timestamp: Date.now(),
      source: 'recap-mirror',
      agentId,
      sessionId,
      jobId: `recap:${sessionId}`,
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
    const recapCall = toolCalls.find((toolCall) => toolCall?.name === RECAP_TOOL.name);
    const toolArgs = typeof recapCall?.arguments === 'string'
      ? (() => { try { return JSON.parse(recapCall.arguments); } catch { return {}; } })()
      : (recapCall?.arguments || {});
    const rawRecap = typeof toolArgs?.recap === 'string'
      ? toolArgs.recap
      : (typeof response?.content === 'string' ? response.content : '');
    const cleanRecap = sanitizeRecap(rawRecap);
    if (cleanRecap) {
      logPhase(`recap="${cleanRecap.slice(0, 120)}..."`);
      return { recap: cleanRecap, source: 'model' };
    }

    logPhase(`model returned empty recap, role=${modelRole} stopReason=${response?.stopReason || ''}`);
    throw new Error(`System recap model "${resolvedModel.modelName}" returned an empty response`);
  } finally {
    if (typeof agent.dispose === 'function') {
      await agent.dispose().catch(() => {});
    }
  }
}

async function main() {
  const [agentDir, agentId, sessionId, rawOptions, resultFilePath] = process.argv.slice(2);
  if (!agentDir || !agentId || !sessionId) {
    throw new Error('Usage: node scripts/run-recap-mirror.js <agent-dir> <agent-id> <session-id> [optionsJson] [resultFilePath]');
  }

  const maxAttempts = (() => {
    if (!rawOptions) return 1;
    try {
      const parsed = JSON.parse(String(rawOptions));
      const n = Number(parsed?.maxAttempts);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 1) : 1;
    } catch { return 1; }
  })();

  const agentPath = resolve(PROTOCLAW_ROOT, agentDir);
  const resultPath = resultFilePath || join(mkdtempSync(join(tmpdir(), 'recap-mirror-')), 'result.json');

  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await runRecapGeneration({
        agentDir: agentPath,
        agentId,
        sessionId,
      });

      if (!cleanValue(result.recap)) {
        throw new Error('Recap generation returned empty result — retrying');
      }

      const payload = {
        ok: true,
        attemptCount: attempt,
        recap: result.recap,
        source: result.source || 'model',
      };
      writeFileSync(resultPath, `${JSON.stringify(payload)}\n`, 'utf8');
      process.exit(0);
    } catch (error) {
      lastFailure = error;
      logPhase(`attempt ${attempt}/${maxAttempts} failed: ${error?.message || error}`);
    }
  }

  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown recap mirror failure'));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[recap-mirror] fatal: ${message}\n`);
  process.exit(1);
});
