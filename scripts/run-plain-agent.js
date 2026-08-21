#!/usr/bin/env node

/**
 * Plain agent runner — CLI-first, viewer-observable, workspace-free.
 *
 * 与 run-one-shot-agent.js 的区别：
 * - agent 定义来自 agents/<name>/（plain agent 目录，不进 prebuilt-agents）
 * - 默认连接 ViewerWorker 被监视（PROTOCLAW_HEADLESS=1 跳过；连接失败自动降级）
 * - 会话落盘到 ~/.agentdev/AgentDevClaw/agents/<name>/sessions/ 并维护 index.json
 * - 不依赖 Claw server 运行
 *
 * 用法:
 *   node scripts/run-plain-agent.js <agent-name> --goal "..." [--session <id>] [--cwd <dir>] [--headless]
 *                                          [--format result|text|json|quiet|jsonl] [--keep-alive]
 *
 * 输出约定：
 * - 过程日志一律走 stderr；stdout 只承载结果数据，可安全管道化
 * - --format result  单行 PLAIN_AGENT_RESULT:<json>（默认，向后兼容）
 * - --format text    人类可读：分隔线 + 响应全文 + 会话摘要
 * - --format json    pretty-print 全量结果 JSON
 * - --format quiet   stdout 仅响应正文本身（错误走 stderr，exit code 1）
 * - --format jsonl   stdout 输出 codex exec 风格会话事件 JSONL 流（thread/turn/item 事件）
 * - --keep-alive     onCall 完成后不 dispose 不退出，保持 viewer 连接，Ctrl+C 结束
 *
 * 环境变量:
 *   AGENTDEV_VIEWER_PORT       ViewerWorker 端口（默认 2026）
 *   PROTOCLAW_HEADLESS=1       纯 headless，跳过 viewer 连接
 *   PROTOCLAW_AGENT_CWD        agent 工作目录（默认当前目录）
 *   PROTOCLAW_MODEL_PRESET_ROLE 模型角色（默认 default）
 */

// 无头日志契约前导：必须是第一个 import（env 设置 + console 桥须先于
// 一切依赖模块顶层执行，详见 headless-log-preamble.js）。
import './headless-log-preamble.js';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join, resolve } from 'path';
import os from 'os';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { FileSessionStore } from '@agentdev/core';
import { resolveAgentModelLLM } from '../server/model-preset-resolver.js';
import { normalizeAgentMetadata } from '../server/feature-runtime/schemas.js';
import { scanFeatureCatalog } from '../server/feature-runtime/catalog.js';
import { resolveAgentRuntimePlan } from '../server/feature-runtime/resolver.js';
import { provisionRuntimeEnvironment } from '../server/feature-runtime/provisioner.js';
import { mountResolvedFeatures } from '../server/feature-runtime/loader.js';
import { getRegisteredAgent } from '../server/feature-runtime/agent-registry.js';
import { attachSessionEventOutput, emitFatalSessionError } from './headless-session-renderer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const AGENTS_ROOT = join(PROJECT_ROOT, 'agents');
const AGENTS_DATA_ROOT = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'agents');

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

const OUTPUT_FORMATS = ['result', 'text', 'json', 'quiet', 'jsonl'];

function parseArgs(argv) {
  const parsed = { agentName: null, goal: null, session: null, cwd: null, headless: false, debug: false, format: 'result', keepAlive: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--goal' && argv[i + 1] !== undefined) { parsed.goal = argv[i + 1]; i++; }
    else if (arg === '--session' && argv[i + 1] !== undefined) { parsed.session = argv[i + 1]; i++; }
    else if (arg === '--cwd' && argv[i + 1] !== undefined) { parsed.cwd = argv[i + 1]; i++; }
    else if (arg === '--format' && argv[i + 1] !== undefined) { parsed.format = argv[i + 1]; i++; }
    else if (arg === '--headless') { parsed.headless = true; }
    else if (arg === '--debug') { parsed.debug = true; }
    else if (arg === '--keep-alive') { parsed.keepAlive = true; }
    else if (!arg.startsWith('-') && !parsed.agentName) { parsed.agentName = arg; }
  }
  if (!OUTPUT_FORMATS.includes(parsed.format)) {
    console.error(`无效的 --format "${parsed.format}"，可选: ${OUTPUT_FORMATS.join(' | ')}`);
    process.exit(1);
  }
  return parsed;
}

function resolveAgentClass(agentModule) {
  if (typeof agentModule.default === 'function') return agentModule.default;
  const classes = Object.values(agentModule).filter((exported) => typeof exported === 'function');
  return classes.length === 1 ? classes[0] : null;
}

function readJsonIfPresent(filePath) {
  try { return JSON.parse(readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

async function resolvePlainAgentDefinition(requestedId) {
  const builtInDir = join(AGENTS_ROOT, requestedId);
  const builtInAgentPath = join(builtInDir, 'agent.js');
  if (existsSync(builtInAgentPath)) {
    return { id: requestedId, agentDir: builtInDir, agentPath: builtInAgentPath, metadataPath: join(builtInDir, 'metadata.json'), source: 'built-in' };
  }
  const registered = await getRegisteredAgent(requestedId);
  if (!registered) return null;
  const agentPath = join(registered.projectDir, 'agent.js');
  const rawMetadata = readJsonIfPresent(registered.metadataPath);
  const metadata = rawMetadata ? normalizeAgentMetadata(rawMetadata, { requireFeatureVersions: true }) : null;
  if (!metadata) throw new Error(`无法读取已注册 Agent 的 metadata：${registered.metadataPath}`);
  return {
    id: metadata.id,
    agentDir: registered.projectDir,
    agentPath: join(registered.projectDir, metadata.entry),
    metadataPath: registered.metadataPath,
    source: 'registered',
    registered,
    metadata,
  };
}

function getStudioSourceOverrides(studioProjectDir) {
  const project = readJsonIfPresent(join(studioProjectDir, 'agent-studio.json'));
  const features = Array.isArray(project?.features) ? project.features : [];
  return features.map((feature) => {
    if (!feature?.package || feature?.source?.kind !== 'project') return null;
    return {
      package: String(feature.package),
      runtimeName: String(feature.name || ''),
      ...(feature.export ? { export: String(feature.export) } : {}),
      source: {
        kind: 'project',
        projectDir: String(feature.source.projectDir || ''),
        entry: String(feature.source.entry || ''),
      },
    };
  }).filter(Boolean);
}

// ── Session index（与 server 侧 index.json 格式对齐的文件协议）─────────

function getSessionDir(agentId) {
  return join(AGENTS_DATA_ROOT, sanitizeFragment(agentId), 'sessions');
}

function readSessionIndex(agentId) {
  const indexPath = join(getSessionDir(agentId), 'index.json');
  if (!existsSync(indexPath)) return { activeSessionId: null, sessions: [] };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    return {
      activeSessionId: parsed.activeSessionId || null,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { activeSessionId: null, sessions: [] };
  }
}

function writeSessionIndexAtomic(agentId, index) {
  const dir = getSessionDir(agentId);
  mkdirSync(dir, { recursive: true });
  const indexPath = join(dir, 'index.json');
  const tmpPath = join(dir, `.index-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8');
  renameSync(tmpPath, indexPath);
}

function upsertSessionIndex(agentId, record) {
  const index = readSessionIndex(agentId);
  const existing = index.sessions.findIndex(s => s.id === record.id);
  if (existing >= 0) {
    index.sessions[existing] = { ...index.sessions[existing], ...record };
  } else {
    index.sessions.push(record);
  }
  index.activeSessionId = record.id;
  writeSessionIndexAtomic(agentId, index);
}

// ── Main ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const agentId = cleanValue(args.agentName);
const goal = cleanValue(args.goal);
const headless = args.headless || process.env.PROTOCLAW_HEADLESS === '1';

if (!agentId || !goal) {
  console.error('用法: node scripts/run-plain-agent.js <agent-name> --goal \"...\" [--session <id>] [--cwd <dir>] [--headless] [--debug] [--format result|text|json|quiet|jsonl] [--keep-alive]');
  process.exit(1);
}

const plainDefinitionPromise = resolvePlainAgentDefinition(agentId);

const VIEWER_PORT = parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
const workspaceCwd = resolve(args.cwd || process.env.PROTOCLAW_AGENT_CWD || process.cwd());
const sessionDir = getSessionDir(agentId);
mkdirSync(sessionDir, { recursive: true });
const sessionStore = new FileSessionStore(sessionDir);

const sessionId = args.session
  ? sanitizeFragment(args.session)
  : `plain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// quiet 模式在结果输出前独占 stdout：把 process.stdout.write 整体重定向到 stderr，
// 拦截框架 logger / MCP SDK 等绕过 console 的直写；结果经 originalStdoutWrite 走真 stdout
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
if (args.format === 'quiet') {
  process.stdout.write = (...writeArgs) => process.stderr.write(...writeArgs);
}

function writeStdout(text) {
  originalStdoutWrite(text + '\n');
}

function outputResult(result, format) {
  // stdout 只承载结果数据；错误始终落到 stderr 保证管道干净
  if (result.error) {
    console.error(`[PlainAgent] 输出格式 ${format} 下仍发生错误: ${result.error}`);
  }
  switch (format) {
    case 'text': {
      const line = '─'.repeat(60);
      writeStdout(line);
      writeStdout(result.response || '(空响应)');
      writeStdout(line);
      writeStdout(`# agent=${result.agentId} session=${result.sessionId} duration=${result.durationMs}ms ok=${result.ok}`);
      break;
    }
    case 'json':
      writeStdout(JSON.stringify(result, null, 2));
      break;
    case 'quiet':
      if (result.response) writeStdout(result.response);
      break;
    case 'jsonl':
      // 事件流模式：stdout 只承载会话事件 JSONL（thread/turn/item 已由
      // headless-session-renderer 输出），不追加结果行；成败由 exit code 表达
      break;
    case 'result':
    default:
      writeStdout('PLAIN_AGENT_RESULT:' + JSON.stringify(result));
      break;
  }
}

async function main() {
  const definition = await plainDefinitionPromise;
  if (!definition || !existsSync(definition.agentPath)) {
    throw new Error(`未找到独立 Agent：${agentId}。内建 Agent 位于 agents/<name>/；用户 Agent 请先执行 claw agents register <project-dir>。`);
  }
  const agentDir = definition.agentDir;
  console.error(`[PlainAgent] agent=${definition.id} source=${definition.source} session=${sessionId} cwd=${workspaceCwd} headless=${headless} debug=${args.debug}`);
  console.error(`[PlainAgent] goal="${goal.slice(0, 80)}"`);

  // 会话事件流输出：jsonl 模式写 stdout（codex exec --json 形态），
  // 其余模式渲染 human 可读行到 stderr（codex exec 默认形态）
  attachSessionEventOutput({
    format: args.format === 'jsonl' ? 'jsonl' : 'human',
    threadId: sessionId,
  });

  // 1. 解析模型（metadata.json 的 modelPresets，可被 .agentdev/agent-configs/<id>.json 覆盖）
  const modelPresetRole = cleanValue(process.env.PROTOCLAW_MODEL_PRESET_ROLE) || 'default';
  const resolved = resolveAgentModelLLM(agentDir, modelPresetRole, {
    userConfigPath: join(PROJECT_ROOT, '.agentdev', 'agent-configs', `${definition.id}.json`),
  });
  if (!resolved) {
    console.error(`[PlainAgent] 未解析到模型 preset。请配置 ${definition.metadataPath} 的 modelPresets.default，`);
    console.error(`[PlainAgent] 或 .agentdev/agent-configs/${agentId}.json（推荐，不入库）。`);
    process.exit(1);
  }
  console.error(`[PlainAgent] model preset => ${resolved.modelName}`);

  // 2. 现代 metadata Agent 先解析并 provision Feature；遗留内建 Agent 保持静态装配。
  let runtimePlan = null;
  let runtimeEnvironment = null;
  let runtimeAgentPath = definition.agentPath;
  if (definition.metadata?.features) {
    const sourceOverrides = args.debug
      ? (definition.registered?.studioProjectDir ? getStudioSourceOverrides(definition.registered.studioProjectDir) : (() => { throw new Error('--debug 只支持通过 Studio 注册、且带 studioProjectDir 的 Agent。'); })())
      : [];
    const catalog = await scanFeatureCatalog();
    runtimePlan = resolveAgentRuntimePlan({
      agentRoot: definition.agentDir,
      metadata: definition.metadata,
      catalog,
      sourceOverrides,
      mode: args.debug ? 'debug' : 'release',
    });
    runtimeEnvironment = await provisionRuntimeEnvironment({ plan: runtimePlan });
    runtimeAgentPath = runtimeEnvironment.agentEntry;
  }
  const agentModule = await import(pathToFileURL(runtimeAgentPath).href);
  const AgentClass = resolveAgentClass(agentModule);
  if (!AgentClass) {
    throw new Error(`无法在 ${runtimeAgentPath} 中找到唯一 Agent 类导出`);
  }
  const agent = new AgentClass({
    name: definition.id,
    projectRoot: definition.agentDir,
    workspaceDir: workspaceCwd,
    llm: resolved.llm,
    features: runtimePlan ? Object.fromEntries(runtimePlan.features.map((feature) => [feature.runtimeName || feature.package, feature.config || {}])) : undefined,
    runtime: {
      agentId: definition.id,
      sessionId,
      sessionType: 'plain',
      modelPresetRole,
      ...(runtimeEnvironment ? { runtimeEnvironment: runtimeEnvironment.environmentDir } : {}),
    },
  });
  if (runtimePlan) {
    await mountResolvedFeatures(agent, runtimePlan, { environmentDir: runtimeEnvironment.environmentDir });
    console.error(`[PlainAgent] runtime plan=${runtimePlan.mode} features=${runtimePlan.features.length} env=${runtimeEnvironment.environmentDir}`);
  }

  // 3. 连接 ViewerWorker（被监视；失败降级为 headless 继续）
  if (!headless) {
    try {
      await agent.withViewer(definition.id, VIEWER_PORT, false, {
        projectRoot: definition.agentDir,
        inputPolicy: 'none',
      });
      console.error(`[PlainAgent] ✓ 已连接 ViewerWorker (port ${VIEWER_PORT})，可在 Claw 面板监视`);
    } catch (err) {
      console.warn(`[PlainAgent] ViewerWorker 连接失败 (${err?.message || err})，降级为 headless 执行`);
    }
  }

  // 4. 恢复会话（--session 续接时）
  if (args.session) {
    try {
      await agent.loadSession(sessionId, sessionStore);
      console.error(`[PlainAgent] ✓ 已恢复会话: ${sessionId}`);
    } catch {
      console.error(`[PlainAgent] 会话 ${sessionId} 不存在，将新建`);
    }
  }

  // 5. 索引登记（运行前先入索引，面板/后续查询能看到进行中的痕迹）
  const now = new Date().toISOString();
  upsertSessionIndex(definition.id, {
    id: sessionId,
    goal,
    sessionType: 'plain',
    source: 'cli',
    openDirectory: workspaceCwd,
    createdAt: now,
    updatedAt: now,
  });

  // 6. 执行单次 onCall
  const startTime = Date.now();
  let response = null;
  let error = null;
  let callOutcome = null;
  try {
    console.error('[PlainAgent] 开始执行 agent.onCall()...');
    if (typeof agent.onCallDetailed === 'function') {
      callOutcome = await agent.onCallDetailed(goal);
      response = callOutcome.response;
    } else {
      response = await agent.onCall(goal);
    }
    console.error(`[PlainAgent] agent.onCall() 完成，响应长度=${(response || '').length}`);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[PlainAgent] agent.onCall() 失败: ${error}`);
  }
  const durationMs = Date.now() - startTime;

  // 终态判定：CLI 成功 == call outcome.status === 'completed'。
  // 模型请求失败 / 用户中断 / 步数上限等终态不会抛异常，只体现在
  // outcome.status 中——不能以"onCall 没有抛异常"当作成功。
  const status = error ? 'failed' : (callOutcome?.status || 'completed');
  if (!error && status !== 'completed') {
    error = callOutcome?.error?.message
      || `call terminated: ${callOutcome?.reason || status}`;
    console.error(`[PlainAgent] call 未完成: status=${status} reason=${callOutcome?.reason || ''} ${error}`);
  }

  // 7. 落盘 + 更新索引
  try {
    await agent.saveSession(sessionId, sessionStore);
    upsertSessionIndex(definition.id, {
      id: sessionId,
      goal,
      sessionType: 'plain',
      source: 'cli',
      openDirectory: workspaceCwd,
      createdAt: now,
      updatedAt: new Date().toISOString(),
      lastError: error || undefined,
    });
    console.error(`[PlainAgent] ✓ 会话已保存: ${sessionId}`);
  } catch (err) {
    console.error('[PlainAgent] saveSession 失败:', err?.message || err);
  }

  const finalResult = {
    ok: status === 'completed',
    status,
    ...(callOutcome?.reason ? { reason: callOutcome.reason } : {}),
    response: response || null,
    error: error || null,
    ...(callOutcome?.error ? { errorDetail: callOutcome.error } : {}),
    agentId: definition.id,
    sessionId,
    durationMs,
    timestamp: new Date().toISOString(),
  };

  outputResult(finalResult, args.format);

  // --keep-alive：不 dispose 不退出，保持 agent 与 viewer 连接供面板事后查看，
  // Ctrl+C 时再释放资源退出（会话已落盘，随时可 --session 续接）
  if (args.keepAlive && status === 'completed') {
    console.error(`[PlainAgent] --keep-alive：agent 保持运行（viewer 连接不断开），按 Ctrl+C 结束`);
    // 显式保活：不依赖 audio/audit 等隐式句柄，事件循环空了进程也不退出
    const keepAliveTimer = setInterval(() => {}, 1 << 30);
    let interrupted = false;
    const shutdown = async (signal) => {
      if (interrupted) return;
      interrupted = true;
      console.error(`[PlainAgent] 收到 ${signal}，释放资源并退出...`);
      clearInterval(keepAliveTimer);
      try {
        await agent.dispose();
      } catch (err) {
        console.error('[PlainAgent] dispose 失败:', err?.message || err);
      }
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGBREAK', () => shutdown('SIGBREAK')); // Windows Ctrl+Break / taskkill
    return;
  }

  // 8. 释放资源（含 viewer 连接）
  try {
    await agent.dispose();
  } catch (err) {
    console.error('[PlainAgent] dispose 失败:', err?.message || err);
  }

  process.exit(status === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error('[PlainAgent] Fatal:', err);
  emitFatalSessionError(err instanceof Error ? err.message : String(err));
  outputResult({
    ok: false,
    status: 'failed',
    response: null,
    error: err instanceof Error ? err.message : String(err),
    agentId,
    sessionId,
    durationMs: 0,
    timestamp: new Date().toISOString(),
  }, args.format);
  process.exit(1);
});
