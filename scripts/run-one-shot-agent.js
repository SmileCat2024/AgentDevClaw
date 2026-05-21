#!/usr/bin/env node
/**
 * One-shot agent runner for blocking sub-agent execution.
 *
 * Unlike run-prebuilt-agent.js which starts an interactive loop connected
 * to ViewerWorker, this script executes exactly ONE agent.onCall(goal)
 * and exits with a structured result.
 *
 * Usage:
 *   node scripts/run-one-shot-agent.js <agent-dir> <agent-id> <session-id> <goal>
 *
 * Environment:
 *   PROTOCLAW_HANDOFF_PATH    - path to handoff JSON for context injection
 *   PROTOCLAW_SERVER_ORIGIN   - server URL for API calls
 */

import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import os from 'os';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { FileSessionStore } from 'agentdev';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = resolve(__dirname, '..');
const SERVER_ORIGIN = cleanValue(process.env.PROTOCLAW_SERVER_ORIGIN) || 'http://127.0.0.1:1420';
const HANDOFF_PATH_ENV = 'PROTOCLAW_HANDOFF_PATH';
const HANDOFF_PAYLOAD_ENV = 'PROTOCLAW_HANDOFF_PAYLOAD';
const WORKSPACE_BOUND_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseHandoffContent(raw, sourceLabel) {
  const text = cleanValue(raw);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      return { sourceSummary: parsed, seedMessages: [] };
    }
    if (parsed && typeof parsed === 'object') {
      const seedMessages = Array.isArray(parsed.seedMessages)
        ? parsed.seedMessages
            .map((message) => ({
              role: cleanValue(message?.role),
              content: cleanValue(message?.content),
              turn: Number.isFinite(message?.turn) ? Number(message.turn) : null,
            }))
            .filter((message) => message.role && message.content)
        : [];
      const sourceSummary = cleanValue(
        parsed.sourceSummary
        || parsed.summaryText
        || parsed.summary
        || parsed.handoffSummary
        || parsed.text,
      );
      if (seedMessages.length === 0 && !sourceSummary) {
        throw new Error('missing seedMessages/sourceSummary');
      }
      return {
        packageId: cleanValue(parsed.packageId || parsed.handoffId),
        sourceSessionId: cleanValue(parsed.sourceSessionId),
        sourceSummary,
        seedMessages,
        mode: cleanValue(parsed.mode),
        policy: parsed.policy && typeof parsed.policy === 'object' ? parsed.policy : {},
        importantFiles: Array.isArray(parsed.compactOutput?.importantFiles)
          ? parsed.compactOutput.importantFiles.filter(f => typeof f === 'string')
          : [],
        importantSkills: Array.isArray(parsed.compactOutput?.importantSkills)
          ? parsed.compactOutput.importantSkills.filter(s => typeof s === 'string')
          : [],
        fileRanges: typeof parsed.compactOutput?.fileRanges === 'object' && parsed.compactOutput.fileRanges !== null
          ? parsed.compactOutput.fileRanges
          : {},
      };
    }
  } catch (error) {
    if (sourceLabel === HANDOFF_PAYLOAD_ENV) {
      return { sourceSummary: text, seedMessages: [] };
    }
    if (text.startsWith('{') || text.startsWith('[')) {
      throw new Error(`解析 handoff 内容失败 (${sourceLabel}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { sourceSummary: text, seedMessages: [] };
}

function loadRuntimeHandoff() {
  const payloadText = cleanValue(process.env[HANDOFF_PAYLOAD_ENV]);
  if (payloadText) {
    return {
      source: HANDOFF_PAYLOAD_ENV,
      handoff: parseHandoffContent(payloadText, HANDOFF_PAYLOAD_ENV),
    };
  }

  const handoffPath = cleanValue(process.env[HANDOFF_PATH_ENV]);
  if (!handoffPath) return null;
  if (!existsSync(handoffPath)) {
    throw new Error(`handoff 文件不存在: ${handoffPath}`);
  }

  const fileContent = readFileSync(handoffPath, 'utf8');
  return {
    source: handoffPath,
    handoff: parseHandoffContent(fileContent, handoffPath),
  };
}

function sanitizeSessionFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function resolveAgentClass(agentModule) {
  if (typeof agentModule.default === 'function') return agentModule.default;
  for (const exported of Object.values(agentModule)) {
    if (typeof exported === 'function') return exported;
  }
  return null;
}

function getWorkspaceStatePath(agentId) {
  return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', sanitizeSessionFragment(agentId), 'state.json');
}

function resolveWorkspaceCwd(agentId) {
  if (!WORKSPACE_BOUND_AGENT_IDS.has(sanitizeSessionFragment(agentId))) return null;

  if (process.env.PROTOCLAW_ASSEMBLY_RUNTIME === '1') {
    const assemblyCwd = process.env.PROTOCLAW_ASSEMBLY_WORKSPACE;
    if (assemblyCwd) {
      mkdirSync(assemblyCwd, { recursive: true });
      return assemblyCwd;
    }
    const statePath = getWorkspaceStatePath(agentId);
    if (existsSync(statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
        const assemblyName = parsed?.forms?.['assembly-form']?.assembly_name;
        if (assemblyName && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(assemblyName)) {
          const fallbackCwd = join(os.homedir(), '.agentdev', 'agent-dev', assemblyName);
          mkdirSync(fallbackCwd, { recursive: true });
          return fallbackCwd;
        }
      } catch {}
    }
    return null;
  }

  const statePath = getWorkspaceStatePath(agentId);
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    const openDirectory = typeof parsed?.openDirectory === 'string' ? parsed.openDirectory.trim() : '';
    if (!openDirectory || !existsSync(openDirectory)) return null;
    return openDirectory;
  } catch {
    return null;
  }
}

// ========== Main ==========

const [agentDir, agentId, sessionIdArg, ...goalParts] = process.argv.slice(2);
const goal = goalParts.join(' ');

if (!agentDir || !agentId || !sessionIdArg || !goal) {
  console.error('用法: node scripts/run-one-shot-agent.js <agent-dir> <agent-id> <session-id> <goal>');
  process.exit(1);
}

const agentPath = resolve(PROTOCLAW_ROOT, agentDir);
const agentJsPath = join(agentPath, 'agent.js');
const sessionStoreDir = WORKSPACE_BOUND_AGENT_IDS.has(sanitizeSessionFragment(agentId))
  ? join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', sanitizeSessionFragment(agentId), 'sessions')
  : join(os.homedir(), '.agentdev', 'AgentDevClaw', 'prebuilt-sessions', sanitizeSessionFragment(agentId));
mkdirSync(sessionStoreDir, { recursive: true });

const sessionStore = new FileSessionStore(sessionStoreDir);
const sessionId = sessionIdArg && sessionIdArg !== '__protoclaw-no-session__'
  ? sanitizeSessionFragment(sessionIdArg)
  : null;

function outputResult(result) {
  console.log('ONE_SHOT_RESULT:' + JSON.stringify(result));
}

async function main() {
  console.log(`[OneShot] Starting agent=${agentId} session=${sessionId || '(new)'} goal="${goal.slice(0, 80)}"`);

  // 1. Resolve workspace
  const workspaceCwd = resolveWorkspaceCwd(agentId);

  // 2. Load handoff
  const runtimeHandoff = loadRuntimeHandoff();

  // 3. Import and instantiate agent class
  const agentModule = await import(pathToFileURL(agentJsPath).href);
  const AgentClass = resolveAgentClass(agentModule);
  if (!AgentClass) {
    throw new Error(`无法在 ${agentJsPath} 中找到 Agent 类导出`);
  }

  const agent = new AgentClass({
    name: agentId,
    projectRoot: PROTOCLAW_ROOT,
    workspaceDir: workspaceCwd || PROTOCLAW_ROOT,
  });

  // 4. Mount handoff seed feature (same as run-prebuilt-agent.js)
  const localFeatures = await import(pathToFileURL(join(PROTOCLAW_ROOT, 'local-features', 'dist', 'index.js')).href);

  // Skip ContextCompactionControlFeature — not needed for one-shot
  // Only mount handoff seed if handoff data exists
  if (runtimeHandoff?.handoff && (runtimeHandoff.handoff.sourceSummary || runtimeHandoff.handoff.seedMessages?.length)) {
    if (typeof localFeatures.ContextHandoffSeedFeature !== 'function') {
      throw new Error('local ContextHandoffSeedFeature 未构建，无法挂载 handoff seed');
    }
    agent.use(new localFeatures.ContextHandoffSeedFeature({
      handoff: runtimeHandoff.handoff,
    }));
    console.log(`[OneShot] 已挂载 context handoff seed (${runtimeHandoff.source})`);
  }

  // 5. prepareRuntime hook
  if (typeof agent.prepareRuntime === 'function') {
    await agent.prepareRuntime();
  }

  if (workspaceCwd) {
    console.log(`[OneShot] Workspace-bound agent environment => ${workspaceCwd}`);
  }
  console.log(`[OneShot] Agent 实例已创建: ${agentId}`);
  // NO withViewer() — this is the critical difference

  // 6. Load or create session
  if (sessionId) {
    try {
      await agent.loadSession(sessionId, sessionStore);
      console.log(`[OneShot] 已恢复会话: ${sessionId}`);
    } catch {
      console.log(`[OneShot] 创建新会话: ${sessionId}`);
    }
  }

  // 7. Execute ONE onCall
  const startTime = Date.now();
  let response;
  let error = null;

  try {
    console.log('[OneShot] 开始执行 agent.onCall()...');
    response = await agent.onCall(goal);
    console.log(`[OneShot] agent.onCall() 完成，响应长度=${(response || '').length}`);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[OneShot] agent.onCall() 失败: ${error}`);
  }

  const durationMs = Date.now() - startTime;

  // 8. Save session
  if (sessionId) {
    try {
      await agent.saveSession(sessionId, sessionStore);
      console.log(`[OneShot] 会话已保存: ${sessionId}`);
    } catch (err) {
      console.error('[OneShot] saveSession 失败:', err);
    }
  }

  // 9. Dispose
  try {
    await agent.dispose();
  } catch (err) {
    console.error('[OneShot] dispose 失败:', err);
  }

  // 10. Output structured result
  const result = {
    ok: !error,
    response: response || null,
    error: error || null,
    sessionId: sessionId || null,
    durationMs,
    timestamp: new Date().toISOString(),
  };

  outputResult(result);
  process.exit(error ? 1 : 0);
}

main().catch((error) => {
  console.error('[OneShot] Fatal:', error);
  outputResult({
    ok: false,
    response: null,
    error: error instanceof Error ? error.message : String(error),
    sessionId: sessionId || null,
    durationMs: 0,
    timestamp: new Date().toISOString(),
  });
  process.exit(1);
});
