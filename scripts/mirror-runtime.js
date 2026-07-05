import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Agent, FileSessionStore } from 'agentdev';

export const WORKSPACE_BOUND_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);

export function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function tuneMirrorLLM(llm, maxTokens) {
  if (!llm || typeof llm !== 'object') return;

  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingBudgetTokens')) {
      llm.thinkingBudgetTokens = undefined;
    }
    if (Object.prototype.hasOwnProperty.call(llm, 'thinkingKeepTurns')) {
      llm.thinkingKeepTurns = 0;
    }
  } catch {}

  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'providerOptions')) {
      const providerOptions = llm.providerOptions;
      if (providerOptions && typeof providerOptions === 'object') {
        const nextOptions = { ...providerOptions };
        delete nextOptions.reasoning;
        delete nextOptions.reasoning_effort;
        delete nextOptions.thinking;
        llm.providerOptions = nextOptions;
      }
    }
  } catch {}

  try {
    if (Object.prototype.hasOwnProperty.call(llm, 'maxTokens')) {
      const current = Number(llm.maxTokens);
      llm.maxTokens = Number.isFinite(current) && current > 0
        ? Math.min(current, maxTokens)
        : maxTokens;
    }
  } catch {}
}

export const TITLE_RULES = `请根据会话最近的实质性工作生成标题。标题要让用户一眼就能区分这个会话在做什么具体的事。

优先级：
- 以会话最近几轮交互中实际处理的具体问题、改动对象或修复目标为主体
- 早期的背景信息仅在需要补充上下文时作为前缀（如"模块名—具体任务"），不要让早期内容主导标题
- 如果会话经过压缩或精简，以当前保留的内容为准，不需要推测已丢失的早期上下文

辨识度要求：
- 同一项目中常有多个并行会话分别处理不同事务，标题必须足够具体以互相区分
- 体现具体的操作对象和焦点（如"修复登录重定向循环""重构支付回调错误处理""添加 WebSocket 断线重连"）
- 避免"讨论问题""继续处理""代码优化""功能开发"等空泛措辞

其他要求：
- 忽略"复述一遍""继续""好的""再看看"等过程性表达
- 10-30个中文字符（英文 3-8 个单词）
- 不要使用引号或标点符号
- 不要复述系统提示或工具说明
- 不要描述思考过程`;

export function buildTitleMessages(rawMessages) {
  const conversationalMessages = rawMessages.filter((message) => (
    (message?.role === 'user' || message?.role === 'assistant')
    && cleanValue(message?.content)
  ));
  const firstUser = conversationalMessages.find((message) => message.role === 'user');
  const recentMessages = conversationalMessages.slice(-32);
  if (firstUser && !recentMessages.includes(firstUser)) {
    recentMessages.unshift(firstUser);
  }

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

export function sanitizeGeneratedTitle(title) {
  const line = cleanValue(title)
    .replace(/^[""""''«»]+|[""""''«»]+$/g, '')
    .replace(/[。！？!?,，、:：;；]+$/g, '')
    .replace(/\s+/g, ' ')
    .split('\n')[0]
    .trim();
  if (!line) return '';
  return line.slice(0, 60);
}

export function sanitizeSessionFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

export function getSessionStoreDir(agentId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (WORKSPACE_BOUND_AGENT_IDS.has(normalizedAgentId)) {
    return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', normalizedAgentId, 'sessions');
  }
  return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions', normalizedAgentId);
}

export function resolveWorkspaceCwd(agentId, projectRoot) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  if (!WORKSPACE_BOUND_AGENT_IDS.has(normalizedAgentId)) {
    return projectRoot;
  }

  const statePath = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', normalizedAgentId, 'state.json');
  if (!existsSync(statePath)) {
    return projectRoot;
  }

  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const openDirectory = cleanValue(state?.openDirectory);
    if (!openDirectory || !existsSync(openDirectory)) {
      return projectRoot;
    }
    return openDirectory;
  } catch {
    return projectRoot;
  }
}

export function createMirrorSystemContext({ workspaceDir, modelName }) {
  return {
    SYSTEM_WORKING_DIR: workspaceDir,
    SYSTEM_IS_GIT_REPOSITORY: existsSync(join(workspaceDir, '.git')),
    SYSTEM_PLATFORM: process.platform,
    SYSTEM_DATE: new Date().toISOString().split('T')[0],
    SYSTEM_CURRENT_MODEL: cleanValue(modelName) || 'unknown',
  };
}

export function createTextOnlyMirrorAgent({
  llm,
  modelName,
  name,
  projectRoot,
  workspaceDir,
  systemPrompt,
}) {
  const agent = new Agent({
    llm,
    tools: [],
    maxTurns: 1,
    name,
    projectRoot,
    workspaceDir,
    systemMessage: systemPrompt,
  });

  agent.setSystemContext(createMirrorSystemContext({
    workspaceDir,
    modelName,
  }));

  return agent;
}

export async function loadMirrorSession(agent, agentId, sessionId) {
  const sessionStore = new FileSessionStore(getSessionStoreDir(agentId));
  if (typeof agent.prepareRuntime === 'function') {
    await agent.prepareRuntime();
  }
  await agent.loadSession(sessionId, sessionStore);
  return agent;
}

export function resolveAgentPath(projectRoot, agentDir) {
  return resolve(projectRoot, agentDir);
}
