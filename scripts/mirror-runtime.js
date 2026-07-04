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

export const TITLE_RULES = `请从整段会话中识别稳定的主任务，为它生成一个简洁准确的标题。

要求：
- 首先综合整段会话，确定用户真正要解决的问题、项目背景和核心目标，不要只概括最后一句
- 标题应优先说明"在什么背景下，处理什么核心问题或目标"
- 会话靠后的内容权重更高，但只有当它引入新的技术对象、约束、目标、故障现象或明确的方向调整时，才用于修正标题
- 忽略"复述一遍""继续""好的""再看看""按这个做"等低信息量、确认性或仅控制对话过程的表达
- 如果最后一轮只是要求解释、复述或整理已有内容，标题仍应描述被解释、复述或整理的原始主题，而不是"复述内容"本身
- 如果会话包含多个阶段，选择贯穿会话且对当前工作最重要的主线；用靠后的实质性关注点补充细节
- 标题应体现核心对象、问题背景、目标或正在解决的故障，避免"讨论问题""继续处理""复述方案"等空泛措辞
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
