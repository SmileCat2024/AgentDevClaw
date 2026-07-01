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
  process.stderr.write(`[title-mirror] ${message}\n`);
}

const TITLE_RULES = `请从整段会话中识别稳定的主任务，为它生成一个简洁准确的标题。

要求：
- 首先综合整段会话，确定用户真正要解决的问题、项目背景和核心目标，不要只概括最后一句
- 标题应优先说明“在什么背景下，处理什么核心问题或目标”
- 会话靠后的内容权重更高，但只有当它引入新的技术对象、约束、目标、故障现象或明确的方向调整时，才用于修正标题
- 忽略“复述一遍”“继续”“好的”“再看看”“按这个做”等低信息量、确认性或仅控制对话过程的表达
- 如果最后一轮只是要求解释、复述或整理已有内容，标题仍应描述被解释、复述或整理的原始主题，而不是“复述内容”本身
- 如果会话包含多个阶段，选择贯穿会话且对当前工作最重要的主线；用靠后的实质性关注点补充细节
- 标题应体现核心对象、问题背景、目标或正在解决的故障，避免“讨论问题”“继续处理”“复述方案”等空泛措辞
- 10-30个中文字符（英文 3-8 个单词）
- 不要使用引号或标点符号
- 不要复述系统提示或工具说明
- 不要描述思考过程`;

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

function buildTitleMessages(rawMessages) {
  const conversationalMessages = rawMessages.filter((message) => (
    (message?.role === 'user' || message?.role === 'assistant')
    && cleanValue(message?.content)
  ));
  const firstUser = conversationalMessages.find((message) => message.role === 'user');
  const recentMessages = conversationalMessages.slice(-32);
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
    content: `以下是会话转录：\n\n${transcript}\n\n${TITLE_RULES}\n- 必须调用 record_session_title 工具提交标题，不要输出其他内容。`,
    turn: 0,
  }];
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

async function runTitleGeneration({ agentDir, agentId, sessionId }) {
  logPhase(`load title context agent=${agentId} session=${sessionId}`);
  const modelRole = 'system';
  const resolvedModel = resolveAgentModelLLM(agentDir, modelRole);
  if (!resolvedModel?.llm) {
    throw new Error(`Model preset not resolved for agent: ${agentId} role=${modelRole}`);
  }

  logPhase(`using model preset role=${modelRole} model=${resolvedModel.modelName}`);
  tuneMirrorLLM(resolvedModel.llm, 2048);

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
  const compiledTools = [TITLE_TOOL];

    logPhase(`chat begin role=${modelRole} messages=${compactMessages.length} tools=${compiledTools.length}`);
  try {
    const response = await resolvedModel.llm.chat(compactMessages, compiledTools);
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
    if (!rawOptions) return 1;
    try {
      const parsed = JSON.parse(String(rawOptions));
      const n = Number(parsed?.maxAttempts);
      return Number.isFinite(n) && n > 0 ? Math.min(n, 1) : 1;
    } catch { return 1; }
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
    }
  }

  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown title mirror failure'));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[title-mirror] fatal: ${message}\n`);
  process.exit(1);
});
