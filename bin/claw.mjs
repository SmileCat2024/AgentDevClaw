#!/usr/bin/env node

/**
 * claw - AgentDevClaw workspace CLI (thin shell)
 *
 * Routes all commands through claw-core provider registry.
 * Legacy commands (exp, subs, show, spawn, compact, resume)
 * are aliases for the default workspace operations.
 */

import { spawn } from 'child_process';
import { setTimeout as sleep } from 'timers/promises';
import { join, resolve } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import os from 'os';
import process from 'process';

import { fileURLToPath } from 'url';
import {
  loadProviders, listProviders, getProvider, getDefaultWorkspaceId,
  dispatch, cleanText, truncate, formatDate,
} from '../server/claw-core.mjs';
import {
  listRegisteredAgents,
  registerAgentProject,
  unregisterAgentProject,
} from '../server/feature-runtime/agent-registry.js';
import { renderSessionEventHuman } from '../scripts/headless-session-renderer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '..');
const PLAIN_AGENT_RUNNER = join(PROJECT_ROOT, 'scripts', 'run-plain-agent.js');
const CODER_ACP_RUNNER = join(PROJECT_ROOT, 'scripts', 'run-coder-acp.js');
const PLAIN_AGENTS_ROOT = join(PROJECT_ROOT, 'agents');

function sanitizeFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

function handleAcp(args = []) {
  const [agentName] = args;
  if (agentName !== 'coder' || args.length !== 1) {
    console.error('用法: claw acp coder');
    process.exit(1);
  }

  const child = spawn(process.execPath, [CODER_ACP_RUNNER], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.on('error', (err) => {
    console.error('Failed to start coder ACP adapter:', err.message);
    process.exit(1);
  });
  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}

// ── Plain agents (workspace-free, CLI-first) ─────────────────────

async function listPlainAgents() {
  const agents = [];
  const entries = existsSync(PLAIN_AGENTS_ROOT) ? readdirSync(PLAIN_AGENTS_ROOT, { withFileTypes: true }) : [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentJs = join(PLAIN_AGENTS_ROOT, entry.name, 'agent.js');
    if (!existsSync(agentJs)) continue;
    let meta = {};
    try {
      meta = JSON.parse(readFileSync(join(PLAIN_AGENTS_ROOT, entry.name, 'metadata.json'), 'utf8')) || {};
    } catch {}
    agents.push({
      id: entry.name,
      name: cleanText(meta.name) || entry.name,
      description: cleanText(meta.description),
    });
  }
  const registered = await listRegisteredAgents();
  for (const record of registered) {
    if (agents.some((agent) => agent.id === record.id)) continue;
    let meta = {};
    try { meta = JSON.parse(readFileSync(record.metadataPath, 'utf8')) || {}; } catch {}
    agents.push({
      id: record.id,
      name: cleanText(meta.name) || record.id,
      description: cleanText(meta.description),
      source: 'registered',
      projectDir: record.projectDir,
    });
  }
  return agents.sort((left, right) => left.id.localeCompare(right.id));
}

function handleRun(args) {
  const agentName = args.find(a => !a.startsWith('-'));
  if (!agentName) {
    console.error('用法: claw run <agent-name> --goal "..." [--session <id>] [--cwd <dir>] [--config-group <name>] [--headless] [--debug] [--format result|text|json|quiet|jsonl] [--keep-alive]');
    process.exit(1);
  }

  const hasGoal = args.includes('--goal');
  if (!hasGoal) {
    console.error('缺少 --goal 参数');
    console.error('用法: claw run <agent-name> --goal "..." [--session <id>] [--cwd <dir>] [--config-group <name>] [--headless] [--debug] [--format result|text|json|quiet|jsonl] [--keep-alive]');
    process.exit(1);
  }

  const child = spawn(process.execPath, [PLAIN_AGENT_RUNNER, ...args], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });

  child.on('error', (err) => {
    console.error('Failed to start plain agent runner:', err.message);
    process.exit(1);
  });
  child.on('exit', (code) => {
    process.exit(code ?? 1);
  });
}

async function handleAgents(args = []) {
  const [subcommand, value] = args;
  if (subcommand === 'register') {
    if (!value) throw new Error('用法: claw agents register <agent-project-dir> [--studio <studio-project-dir>]');
    const studioIndex = args.indexOf('--studio');
    const studioProjectDir = studioIndex >= 0 ? args[studioIndex + 1] || '' : '';
    const record = await registerAgentProject({ projectDir: value, studioProjectDir });
    console.log(`Registered standalone agent: ${record.id}`);
    console.log(`  project: ${record.projectDir}`);
    return;
  }
  if (subcommand === 'unregister') {
    if (!value) throw new Error('用法: claw agents unregister <agent-id>');
    const record = await unregisterAgentProject(value);
    console.log(`Unregistered standalone agent: ${record.id}`);
    return;
  }
  if (subcommand === 'inspect') {
    if (!value) throw new Error('用法: claw agents inspect <agent-id>');
    const agents = await listPlainAgents();
    const agent = agents.find((entry) => entry.id === value);
    if (!agent) throw new Error(`Plain agent not found: ${value}`);
    console.log(JSON.stringify(agent, null, 2));
    return;
  }
  if (subcommand) throw new Error(`未知 agents 子命令: ${subcommand}（可用: register / unregister / inspect）`);
  const agents = await listPlainAgents();
  if (agents.length === 0) {
    console.log('No plain agents registered.');
    console.log('Create one at agents/<name>/agent.js or run claw agents register <project-dir>.');
    return;
  }
  console.log(`Plain agents (${agents.length}):`);
  console.log('');
  for (const a of agents) {
    console.log(`  ${a.id}${a.source === 'registered' ? ' (registered)' : ''}`);
    if (a.description) console.log(`    ${truncate(a.description, 100)}`);
    if (a.projectDir) console.log(`    project: ${a.projectDir}`);
    console.log(`    usage: claw run ${a.id} --goal "..."`);
    console.log('');
  }
}

// ── Config groups (ticket 04: read-only listing) ────────────────

// 配置组目录约定（ticket 00/04）：~/.agentdev/AgentDevClaw/workspaces/<agentId>/feature-config/groups/<name>.json
// 组名即文件名（去扩展名）；每组一个稀疏 FeatureConfig。管理靠文件，这里只读。
async function handleConfigGroups(args = []) {
  const agentId = args.find(a => !a.startsWith('-'));
  if (!agentId) throw new Error('用法: claw config-groups <agent-id>');
  const groupsDir = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', sanitizeFragment(agentId), 'feature-config', 'groups');
  const groups = existsSync(groupsDir)
    ? readdirSync(groupsDir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort()
    : [];
  let selected = null;
  const selectedPath = join(groupsDir, '..', 'selected.json');
  if (existsSync(selectedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(selectedPath, 'utf8'));
      if (typeof parsed?.group === 'string') selected = parsed.group;
    } catch {
      // 损坏的 selected.json 不影响只读列表展示，视为未选中
    }
  }
  console.log(`Config groups for ${agentId} (${groups.length}):`);
  for (const group of groups) {
    console.log(`  ${group}${group === selected ? '  (selected)' : ''}`);
  }
  if (groups.length === 0) {
    console.log(`  (无 — 在 ${groupsDir}/ 下创建 <name>.json 即可新增配置组)`);
  }
}

// ── Claw server API access (threads control plane) ─────────────

const CLAW_SERVER_BASE = `http://127.0.0.1:${process.env.PORT || 1420}`;

async function clawServerFetch(pathname, options = {}) {
  let response;
  try {
    response = await fetch(`${CLAW_SERVER_BASE}${pathname}`, options);
  } catch {
    throw new Error(`Claw server not reachable at ${CLAW_SERVER_BASE} — start it with \`npm start\` first`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || payload.message || `HTTP ${response.status}`);
  }
  return payload;
}

// ── generic Thread control (product-independent) ────────────────

function optionValue(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

function requireOption(args, name) {
  const value = optionValue(args, name);
  if (!value) throw new Error(`缺少 ${name} 参数`);
  return value;
}

function threadFormat(args, fallback = 'text') {
  const format = optionValue(args, '--format', fallback);
  if (!['text', 'json', 'jsonl'].includes(format)) {
    throw new Error(`无效的 --format "${format}"，可选: text | json | jsonl`);
  }
  return format;
}

function printThreadText(thread) {
  console.log(`Thread ${thread.threadId || '(unknown)'}`);
  if (thread.agentId) console.log(`  agent: ${thread.agentId}`);
  if (thread.workspaceId) console.log(`  workspace: ${thread.workspaceId}`);
  if (thread.status) console.log(`  status: ${thread.status}`);
  if (thread.mode) console.log(`  mode: ${thread.mode}`);
  if (thread.rootSessionId) console.log(`  root: ${thread.rootSessionId}`);
  if (thread.headSessionId) console.log(`  head: ${thread.headSessionId}`);
  if (Array.isArray(thread.sessionChain)) console.log(`  sessions: ${thread.sessionChain.length}`);
  if (Array.isArray(thread.commands)) {
    const pending = thread.commands.filter((command) => command.status === 'pending').length;
    console.log(`  commands: ${thread.commands.length} (${pending} pending)`);
  }
  if (thread.revision !== undefined) console.log(`  revision: ${thread.revision}`);
  if (thread.lastLifecycleEvent?.type) {
    console.log(`  last event: ${thread.lastLifecycleEvent.type}`);
  }
}

function printThreadsHelp() {
  console.log('用法:');
  console.log('  claw threads list [--agent ID] [--format text|json]');
  console.log('  claw threads create --agent ID --session ID [--title T] [--mode interactive|autonomous]');
  console.log('  claw threads show <thread-id> [--format text|json]');
  console.log('  claw threads events <thread-id> [--after N] [--format text|json|jsonl]');
  console.log('  claw threads send <thread-id> --text TEXT [--kind K] [--source S] [--idempotency-key K]');
  console.log('  claw threads deliver <thread-id> [--format text|json]');
  console.log('  claw threads advance <thread-id> --to-session ID [--from-session ID] [--expected-revision N] [--end-kind K]');
  console.log('  claw threads handoff-failed <thread-id> [--reason R] [--stage S] [--error E]');
  console.log('  claw threads resume <thread-id> [--source S]');
  console.log('  claw threads close <thread-id> [--reason R]');
}

function writeThreadPayload(payload, format = 'text') {
  if (format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload?.threads) {
    const threads = payload.threads;
    console.log(`Threads (${threads.length}):`);
    for (const thread of threads) {
      console.log(`  ${thread.threadId}  [${thread.status || 'unknown'}]  agent=${thread.agentId || '?'}  head=${thread.headSessionId || 'none'}`);
    }
    return;
  }
  if (payload?.thread) {
    printThreadText(payload.thread);
    return;
  }
  if (payload?.threadId) {
    printThreadText(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function handleThreads(args = []) {
  const [subcommand, threadId] = args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printThreadsHelp();
    return;
  }
  const format = threadFormat(args);

  if (subcommand === 'list' || subcommand === 'ls') {
    const agentId = optionValue(args, '--agent');
    const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    const payload = await clawServerFetch(`/protoclaw/threads${query}`);
    writeThreadPayload(payload, format);
    return;
  }

  if (subcommand === 'create') {
    const body = {
      agentId: requireOption(args, '--agent'),
      sessionId: requireOption(args, '--session'),
    };
    const title = optionValue(args, '--title');
    const mode = optionValue(args, '--mode');
    const workspaceId = optionValue(args, '--workspace');
    if (title) body.title = title;
    if (mode) body.mode = mode;
    if (workspaceId) body.workspaceId = workspaceId;
    const payload = await clawServerFetch('/protoclaw/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    writeThreadPayload(payload, format);
    return;
  }

  if (!threadId) {
    throw new Error('用法: claw threads <list|create|show|events|send|deliver|advance|handoff-failed|resume|close> ...');
  }

  if (subcommand === 'show') {
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}`);
    writeThreadPayload(payload, format);
    return;
  }

  if (subcommand === 'events') {
    const after = optionValue(args, '--after');
    const query = after === '' ? '' : `?after=${encodeURIComponent(after)}`;
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events${query}`);
    if (format === 'json') {
      console.log(JSON.stringify(payload, null, 2));
    } else if (format === 'jsonl') {
      for (const event of payload.events || []) console.log(JSON.stringify(event));
    } else {
      console.log(`Events (${(payload.events || []).length}), cursor=${payload.cursor ?? 0}`);
      for (const event of payload.events || []) {
        console.log(`  ${event.type || 'event'}${event.turn !== undefined ? ` turn=${event.turn}` : ''}`);
      }
    }
    return;
  }

  if (subcommand === 'send') {
    const body = {
      text: requireOption(args, '--text'),
      ...(optionValue(args, '--kind') ? { kind: optionValue(args, '--kind') } : {}),
      ...(optionValue(args, '--source') ? { source: optionValue(args, '--source') } : {}),
      ...(optionValue(args, '--idempotency-key') ? { idempotencyKey: optionValue(args, '--idempotency-key') } : {}),
    };
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    writeThreadPayload(payload, format);
    return;
  }

  if (subcommand === 'deliver') {
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    writeThreadPayload(payload, format);
    return;
  }

  if (subcommand === 'advance') {
    const body = { toSessionId: requireOption(args, '--to-session') };
    const fromSessionId = optionValue(args, '--from-session');
    const expectedRevision = optionValue(args, '--expected-revision');
    const endKind = optionValue(args, '--end-kind');
    if (fromSessionId) body.fromSessionId = fromSessionId;
    if (expectedRevision !== '') {
      const revision = Number(expectedRevision);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error('--expected-revision 必须是非负整数');
      }
      body.expectedRevision = revision;
    }
    if (endKind) body.endKind = endKind;
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/head`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    writeThreadPayload(payload, format);
    return;
  }

  if (subcommand === 'handoff-failed') {
    const body = {
      ...(optionValue(args, '--reason') ? { reason: optionValue(args, '--reason') } : {}),
      ...(optionValue(args, '--stage') ? { stage: optionValue(args, '--stage') } : {}),
      ...(optionValue(args, '--error') ? { error: optionValue(args, '--error') } : {}),
    };
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/handoff-failed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    writeThreadPayload(payload, format);
    return;
  }

  if (subcommand === 'resume' || subcommand === 'close') {
    const endpoint = subcommand === 'resume' ? 'resume' : 'close';
    const body = subcommand === 'resume'
      ? { source: optionValue(args, '--source', 'cli') }
      : { reason: optionValue(args, '--reason', 'cli') };
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    writeThreadPayload(payload, format);
    return;
  }

  throw new Error(`未知 threads 子命令: ${subcommand || '(空)'}（可用: list / create / show / events / send / deliver / advance / handoff-failed / resume / close）`);
}

const LEGACY_ALIASES = {
  'exp': 'explorations',
  'explorations': 'explorations',
  'subs': 'subs',
  'sub': 'subs',
  'show': 'show',
  'get': 'show',
  'spawn': 'spawn',
  'compact': 'compact',
  'compress': 'compact',
  'resume': 'resume',
  'new-session': 'create_session',
  'new-chat': 'create_session',
};

// ── Main ────────────────────────────────────────────────────────

async function main() {
  await loadProviders();

  const args = process.argv.slice(2);
  const command = args[0] || '';
  const defaultWs = getDefaultWorkspaceId();

  if (command === '') {
    await cmdOverview(defaultWs);
    return;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'ws') {
    await handleWs(args.slice(1));
    return;
  }

  if (command === 'run') {
    handleRun(args.slice(1));
    return;
  }

  if (command === 'acp') {
    handleAcp(args.slice(1));
    return;
  }

  if (command === 'agents') {
    await handleAgents(args.slice(1));
    return;
  }

  if (command === 'config-groups') {
    await handleConfigGroups(args.slice(1));
    return;
  }

  if (command === 'threads') {
    await handleThreads(args.slice(1));
    return;
  }

  if (LEGACY_ALIASES[command]) {
    await handleLegacy(defaultWs, LEGACY_ALIASES[command], args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run claw help for usage');
  process.exit(1);
}

// ── Help ────────────────────────────────────────────────────────

function printHelp() {
  const providers = listProviders();
  console.log('claw - AgentDevClaw workspace CLI');
  console.log('');
  console.log('Workspaces:');
  for (const p of providers) {
    console.log(`  ${p.id}   ${p.name} - ${p.description}`);
  }
  console.log('');
  console.log('Commands:');
  console.log('  claw                                   Overview');
  console.log('  claw ws                                List all workspaces');
  console.log('  claw ws <id> [command] [args]          Workspace operation');
  console.log('  claw ws <id> help                      Workspace operations list');
  console.log('  claw agents                            List plain agents (workspace-free)');
  console.log('  claw config-groups <agent-id>          List feature config groups of an agent (ticket 04, read-only)');
  console.log('  claw agents register <project-dir>     Register a metadata-based standalone Agent');
  console.log('  claw agents unregister <agent-id>      Remove a registered Agent');
  console.log('  claw agents inspect <agent-id>         Show Agent source and project metadata');
  console.log('  claw threads list [--agent ID]         List persisted work threads');
  console.log('  claw threads create --agent ID --session ID [--title T] [--mode MODE]');
  console.log('  claw threads show <thread-id>           Show a persisted thread');
  console.log('  claw threads events <thread-id> [--after N] [--format jsonl]');
  console.log('  claw threads send <thread-id> --text TEXT [--idempotency-key KEY]');
  console.log('  claw threads deliver <thread-id>         Retry pending command delivery');
  console.log('  claw threads advance <thread-id> --to-session ID [--from-session ID]');
  console.log('  claw threads handoff-failed <thread-id> [--reason R] [--stage S]');
  console.log('  claw threads resume <thread-id> [--source S]');
  console.log('  claw threads close <thread-id> [--reason R]');
  console.log('  claw run <name> --goal "..." [...]     Run a plain agent (viewer-observable; --debug uses Studio source overrides)');
  console.log('  claw acp coder                         Start the coder ACP stdio adapter');
  console.log('');
  console.log('Legacy aliases (default workspace):');
  console.log('  claw exp [--limit N] [--file F] [--keyword K]');
  console.log('  claw subs');
  console.log('  claw show <id>');
  console.log('  claw spawn --goal "..." [--blocking]');
  console.log('  claw spawn <exp-id>... --goal "..."');
  console.log('  claw compact <exp-id>');
  console.log('  claw resume <sub-id> --msg "..."');
  console.log('  claw new-session <project-path>');
}

// ── Overview ────────────────────────────────────────────────────

async function cmdOverview(defaultWs) {
  if (!defaultWs) {
    console.log('No workspace providers registered.');
    return;
  }
  const { ok, result } = await dispatch(defaultWs, 'overview');
  console.log('AgentDevClaw  workspace CLI');
  console.log('');
  if (ok) {
    console.log(`  Workspace: ${defaultWs}`);
    console.log(`  Directory: ${result.workingDirectory}`);
    console.log(`  Explorations: ${result.explorationCount}`);
    console.log(`  Sub-agents: ${result.subAgentCount}`);
  }
  console.log('');
  console.log('  claw ws                List all workspaces');
  console.log('  claw exp               List explorations');
  console.log('  claw spawn --goal ...  Spawn exploration');
  console.log('  claw compact <id>      Compact exploration');
  console.log('  claw resume <id> --msg Resume sub-agent');
  console.log('  claw new-session <path> Create new session');
}

// ── ws command ──────────────────────────────────────────────────

async function handleWs(args) {
  if (args.length === 0) {
    const providers = listProviders();
    console.log(`Workspaces (${providers.length}):`);
    console.log('');
    for (const p of providers) {
      console.log(`  ${p.id}   ${p.name}`);
      console.log(`    ${truncate(p.description, 100)}`);
      console.log(`    operations: ${p.operations.map(op => op.name).join(', ')}`);
      console.log('');
    }
    return;
  }

  const wsId = args[0];
  const provider = getProvider(wsId);
  if (!provider) {
    console.error(`Unknown workspace: ${wsId}`);
    console.error('Available: ' + listProviders().map(p => p.id).join(', '));
    process.exit(1);
  }

  const subCommand = args[1] || 'overview';

  if (subCommand === 'help') {
    console.log(`${provider.name} (${provider.id})`);
    console.log(provider.description);
    console.log('');
    console.log('Operations:');
    for (const op of provider.operations) {
      const paramStr = (op.params || []).map(p =>
        p.required ? `--${p.name} <required>` : `[--${p.name}]`
      ).join(' ');
      console.log(`  claw ws ${wsId} ${op.name}${paramStr ? ' ' + paramStr : ''}`);
      console.log(`    ${op.description}`);
    }
    return;
  }

  const operation = provider.operations.find(op => op.name === subCommand);
  if (!operation) {
    console.error(`Unknown operation: ${subCommand}`);
    console.error('Available: ' + provider.operations.map(op => op.name).join(', '));
    process.exit(1);
  }

  const params = parseOpParams(operation, args.slice(2));
  const { ok, result, error } = await dispatch(wsId, subCommand, params);

  if (!ok) {
    console.error('Error: ' + error);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

// ── Legacy command handlers ─────────────────────────────────────

async function handleLegacy(wsId, opName, args) {
  const params = parseLegacyArgs(opName, args);
  const { ok, result, error } = await dispatch(wsId, opName, params);

  if (!ok) {
    console.error('Error: ' + error);
    process.exit(1);
  }

  formatLegacyOutput(opName, result, params);
}

function parseOpParams(operation, args) {
  const params = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i + 1]) {
      params[args[i].slice(2)] = args[i + 1];
      i++;
    } else if (!args[i].startsWith('-') && operation.params && operation.params.length > 0) {
      params[operation.params[0].name] = args[i];
    }
  }
  return params;
}

function parseLegacyArgs(opName, args) {
  const params = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--goal' && args[i + 1]) { params.goal = args[i + 1]; i++; }
    else if (args[i] === '--msg' && args[i + 1]) { params.message = args[i + 1]; i++; }
    else if (args[i] === '--limit' && args[i + 1]) { params.limit = parseInt(args[i + 1], 10) || 20; i++; }
    else if (args[i] === '--file' && args[i + 1]) { params.file = args[i + 1]; i++; }
    else if (args[i] === '--keyword' && args[i + 1]) { params.keyword = args[i + 1]; i++; }
    else if (args[i] === '--path' && args[i + 1]) { params.path = args[i + 1]; i++; }
    else if (args[i] === '--blocking' || args[i] === '--wait') { params.blocking = true; }
    else if (!args[i].startsWith('-')) { positional.push(args[i]); }
  }

  if (opName === 'show' || opName === 'compact') {
    if (positional.length > 0) params.sessionId = positional[0];
  } else if (opName === 'spawn') {
    if (positional.length > 0) params.from = positional.join(',');
  } else if (opName === 'resume') {
    if (positional.length > 0) params.sessionId = positional[0];
  } else if (opName === 'create_session') {
    if (positional.length > 0) params.path = positional[0];
  }

  return params;
}

function formatLegacyOutput(opName, result, params) {
  // Provider-level error (result has error but no ok/records/type)
  if (result && result.error && result.ok === undefined && !result.records && !result.type) {
    console.error('Error: ' + result.error);
    process.exit(1);
  }

  switch (opName) {
    case 'explorations': {
      const records = result.records || [];
      if (records.length === 0) {
        console.log(params.file || params.keyword ? 'No matching explorations found' : 'No explorations yet');
        console.log('Use claw spawn --goal "..." to start');
        return;
      }
      const filterDesc = params.file || params.keyword
        ? ' (filter: ' + (params.file ? 'file="' + params.file + '"' : '') +
          (params.file && params.keyword ? ', ' : '') +
          (params.keyword ? 'keyword="' + params.keyword + '"' : '') + ')'
        : '';
      console.log(`Explorations (${result.total}${result.total > records.length ? ', showing ' + records.length : ''}${filterDesc})`);
      console.log('');
      for (const r of records) {
        const shortId = r.id.length > 30 ? '...' + r.id.slice(-24) : r.id;
        console.log('  ' + shortId);
        console.log('    ' + truncate(r.goal, 80));
        if (r.importantFiles && r.importantFiles.length > 0) {
          const fp = r.importantFiles.slice(0, 4).map(f => (f.split('/').pop() || f)).join(', ');
          console.log('    explored: ' + truncate(fp, 100) + (r.importantFiles.length > 4 ? ' +' + (r.importantFiles.length - 4) + ' more' : ''));
        } else if (r.hasSummary) {
          console.log('    (has summary)');
        } else {
          console.log('    (no summary)');
        }
        if (r.domains && r.domains.length > 0) console.log('    domains: ' + r.domains.join(', '));
        const date = r.timestamp ? formatDate(r.timestamp) : '';
        const gitInfo = r.gitMeta ? ' · ' + (r.gitMeta.branch || '?') + '@' + (r.gitMeta.commitHash || '?') : '';
        console.log('    ' + (r.status === 'locked' ? '已锁定' : '运行中') + ' · ' + date + gitInfo);
        console.log('');
      }
      return;
    }

    case 'subs': {
      const records = result.records || [];
      if (records.length === 0) {
        console.log('暂无子代理对话');
        console.log('使用 claw spawn <exp-id> --goal "..." 启动子代理');
        return;
      }
      console.log(`子代理对话 (${records.length} 个)`);
      console.log('');
      for (const r of records) {
        const shortId = r.id.length > 30 ? '...' + r.id.slice(-24) : r.id;
        console.log('  ' + shortId);
        console.log('    ' + truncate(r.goal, 80));
        if (r.domains && r.domains.length > 0) console.log('    领域: ' + r.domains.join(', '));
        if (r.sourceExplorationIds && r.sourceExplorationIds.length > 0) console.log('    来源: ' + r.sourceExplorationIds.join(', '));
        console.log('    ' + formatDate(r.createdAt));
        console.log('');
      }
      return;
    }

    case 'show': {
      if (result.error) {
        console.error(result.error);
        process.exit(1);
      }
      if (result.type === 'exploration') {
        console.log(`探索记录 · ${result.id}`);
        console.log('目标: ' + result.goal);
        console.log('状态: ' + (result.status === 'locked' ? '已锁定' : '运行中'));
        if (result.domains && result.domains.length > 0) console.log('领域: ' + result.domains.join(', '));
        console.log('摘要: ' + (result.hasSummary ? '已生成' : '未生成（claw compact 生成）'));
        console.log('消息: ' + result.messageCount + ' 条');
        if (result.result) {
          console.log('');
          console.log('--- 探索结果 ---');
          console.log(result.result);
          console.log('--- 结束 ---');
        }
      } else {
        console.log(`子代理对话 · ${result.id}`);
        console.log('目标: ' + result.goal);
        if (result.sourceExplorationIds && result.sourceExplorationIds.length > 0) {
          console.log('来源探索: ' + result.sourceExplorationIds.join(', '));
        }
        console.log('消息: ' + result.messageCount + ' 条');
        if (result.finalOutput) {
          console.log('');
          console.log('--- 最终输出 ---');
          console.log(result.finalOutput);
          console.log('--- 结束 ---');
        }
      }
      return;
    }

    case 'spawn': {
      if (result.error) {
        console.error(params.from ? '子代理执行失败' : '探索执行失败');
        console.error('  错误: ' + result.error);
        process.exit(1);
      }
      console.log(params.from ? '子代理执行完成' : '探索完成');
      console.log('  会话 ID: ' + result.sessionId);
      console.log('  类型: ' + result.sessionType);
      console.log('  耗时: ' + (result.durationMs / 1000).toFixed(1) + 's');
      if (result.response) {
        console.log('');
        console.log('--- 执行结果 ---');
        console.log(result.response);
        console.log('--- 结束 ---');
      }
      return;
    }

    case 'compact': {
      if (result.error) {
        console.error('压缩失败: ' + result.error);
        process.exit(1);
      }
      console.log('压缩完成');
      console.log('  摘要长度: ' + result.summaryLength + ' 字符');
      if (result.sessionTitle) console.log('  对话标题: ' + result.sessionTitle);
      if (result.importantFiles && result.importantFiles.length > 0) {
        console.log('  重要文件:');
        for (const f of result.importantFiles) console.log('    - ' + f);
      }
      console.log('');
      console.log(result.summaryText);
      return;
    }

    case 'resume': {
      if (result.error) {
        console.error('续接失败');
        console.error('  错误: ' + result.error);
        process.exit(1);
      }
      console.log('子代理续接完成');
      console.log('  耗时: ' + (result.durationMs / 1000).toFixed(1) + 's');
      if (result.response) {
        console.log('');
        console.log('--- 执行结果 ---');
        console.log(result.response);
        console.log('--- 结束 ---');
      }
      return;
    }

    case 'create_session': {
      if (result.error) {
        console.error('创建会话失败: ' + result.error);
        process.exit(1);
      }
      console.log('会话已创建');
      console.log('  会话 ID: ' + result.sessionId);
      console.log('  标题: ' + (result.title || '(未命名)'));
      console.log('  项目路径: ' + result.openDirectory);
      console.log('  运行时状态: ' + result.runtimeStatus);
      if (result.viewerAgentId) {
        console.log('  Viewer Agent: ' + result.viewerAgentId);
      }
      return;
    }

    default:
      console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(err => {
  console.error(err?.message || err);
  process.exit(1);
});
