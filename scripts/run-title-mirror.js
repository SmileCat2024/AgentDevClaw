#!/usr/bin/env node

import { dirname, join, resolve } from 'path';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { fileURLToPath } from 'url';
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

function logPhase(message) {
  process.stderr.write(`[title-mirror] ${message}\n`);
}

const TITLE_PROMPT = `以上是一段对话的历史记录。请从整段会话中识别稳定的主任务，为它生成一个简洁准确的标题。

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
- 不要描述思考过程
- 必须调用 record_session_title 工具提交标题，不要输出其他内容`;

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

  const compactMessages = recentMessages.map((message, index) => ({
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

  logPhase(`chat begin messages=${compactMessages.length} tools=${compiledTools.length}`);
  try {
    const response = await resolvedModel.llm.chat(compactMessages, compiledTools);
    logPhase('chat done');

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

    logPhase(`model returned empty title, raw response keys=${Object.keys(response || {}).join(',')} toolCalls=${toolCalls.length} content=${JSON.stringify(response?.content)?.slice(0, 200)} reasoning=${JSON.stringify(response?.reasoning)?.slice(0, 120)}`);
    throw new Error('Model returned empty title after sanitization — will retry');
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
  let rawMessagesRef = null;

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
      // Capture rawMessages for heuristic fallback if available on the error
      if (error?.rawMessages && Array.isArray(error.rawMessages)) {
        rawMessagesRef = error.rawMessages;
      }
      logPhase(`attempt ${attempt}/${maxAttempts} failed: ${error?.message || error}`);
    }
  }

  // All retries exhausted — use heuristic fallback as last resort
  logPhase(`all ${maxAttempts} attempts failed, using heuristic fallback`);
  try {
    // Re-restore session to get raw messages for heuristic
    const resolvedModel = resolveAgentModelLLM(agentPath, 'system');
    const workspaceDir = resolveWorkspaceCwd(agentId, PROTOCLAW_ROOT);
    const fallbackAgent = createTextOnlyMirrorAgent({
      llm: resolvedModel.llm,
      modelName: resolvedModel.modelName,
      name: `${sanitizeSessionFragment(agentId)}-title-mirror-fallback`,
      projectRoot: PROTOCLAW_ROOT,
      workspaceDir,
      systemPrompt: '备用标题生成',
    });
    await loadMirrorSession(fallbackAgent, agentId, sessionId);
    const fbRawMessages = typeof fallbackAgent.getContext === 'function' ? fallbackAgent.getContext().getAll() : [];
    if (typeof fallbackAgent.dispose === 'function') await fallbackAgent.dispose().catch(() => {});

    const fallbackTitle = buildHeuristicTitle(fbRawMessages);
    logPhase(`heuristic fallback title="${fallbackTitle}"`);
    if (cleanValue(fallbackTitle)) {
      const payload = {
        ok: true,
        attemptCount: maxAttempts,
        title: fallbackTitle,
        source: 'fallback',
      };
      writeFileSync(resultPath, `${JSON.stringify(payload)}\n`, 'utf8');
      process.exit(0);
    }
  } catch (fbError) {
    logPhase(`heuristic fallback also failed: ${fbError?.message || fbError}`);
  }

  throw lastFailure instanceof Error ? lastFailure : new Error(String(lastFailure || 'Unknown title mirror failure'));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`[title-mirror] fatal: ${message}\n`);
  process.exit(1);
});
