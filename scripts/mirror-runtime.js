import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { Agent, FileSessionStore } from 'agentdev';

export const WORKSPACE_BOUND_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);

export function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
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
