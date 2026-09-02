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
import process from 'process';
import { pathToFileURL, fileURLToPath } from 'url';
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
import { resolveUserDataDir } from '../server/shared/constants.js';

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
  const groupsDir = join(resolveUserDataDir(), 'workspaces', sanitizeFragment(agentId), 'feature-config', 'groups');
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
  // 单密码认证开启时，runtime 环境自带的内部服务令牌等价于已认证会话
  // （server/auth.js authenticateInternal）；未设置则维持匿名语义。
  const internalToken = String(process.env.PROTOCLAW_INTERNAL_TOKEN || '').trim();
  const headers = { ...(options.headers || {}) };
  if (internalToken && !headers.Authorization) {
    headers.Authorization = `Bearer ${internalToken}`;
  }
  let response;
  try {
    response = await fetch(`${CLAW_SERVER_BASE}${pathname}`, { ...options, headers });
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

function requireOption(args, name, detail) {
  const value = optionValue(args, name);
  if (!value) throw new Error(detail || `缺少 ${name} 参数`);
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
  if (thread.title) console.log(`  title: ${thread.title}`);
  if (thread.agentId) console.log(`  agent: ${thread.agentId}`);
  if (thread.workspaceId) console.log(`  workspace: ${thread.workspaceId}`);
  if (thread.status) console.log(`  status: ${thread.status}`);
  if (thread.lifeState) console.log(`  lifeState: ${thread.lifeState}`);
  if (thread.failed !== undefined) console.log(`  failed: ${thread.failed}`);
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
  console.log('用法（每行都是一个工作线程 Thread，operating key 一律是 thread-id；');
  console.log('执行对象是线程而非会话，响应以 threadId/cleanup 等如实反映实际对象）:');
  console.log('  claw threads list [--agent ID] [--format text|json]');
  console.log('  claw threads create --agent ID --session ID [--title T] [--mode interactive|autonomous]');
  console.log('  claw threads show <thread-id> [--format text|json]');
  console.log('  claw threads events <thread-id> [--after N] [--format text|json|jsonl]');
  console.log('  claw threads send <thread-id> --text TEXT [--kind K] [--source S] [--idempotency-key K]');
  console.log('  claw threads watch <thread-id>... [--interval S] [--timeout S] [--with-result]   阻塞监控至落定/失败/超时（退出码 0/3/2/1），--with-result 附带末轮回复；多个 thread-id 时任一落定即返回（any-settle）');
  console.log('  claw threads deliver <thread-id> [--format text|json]');
  console.log('  claw threads advance <thread-id> --to-session ID --from-session ID [--expected-revision N] [--end-kind K]');
  console.log('  claw threads handoff-failed <thread-id> [--reason R] [--stage S] [--error E]');
  console.log('  claw threads resume <thread-id> [--source S]        # 恢复 failed 线程的调度');
  console.log('  claw threads close <thread-id> [--reason R]         # 关闭线程（清理残迹）');
  console.log('  claw threads archive <thread-id>                     # 归档=取消性操作：取消未开始指令');
  console.log('  claw threads unarchive <thread-id>                  # 恢复可调度资格；不复活已取消指令');
  console.log('');
  console.log('目标对象说明：archive/unarchive/close/resume 都作用于整个 Thread（其全部成员会话），');
  console.log('不是单个 Session。归档响应携带 cleanup（commandsCancelled / inflightDrain / handoffConverged），');
  console.log('足以让调用者从响应知道实际对象与取消结果。delete 不在 CLI 暴露：删除是带确认的破坏性');
  console.log('操作（级联清理全部会话，见 threads delete 的 UI 面），脚本化 CLI 不绕过确认。');
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
      const life = thread.lifeState ? `|${thread.lifeState}` : '';
      const title = thread.title ? `  "${thread.title}"` : '';
      console.log(`  ${thread.threadId}  [${thread.status || 'unknown'}${life}]  agent=${thread.agentId || '?'}  head=${thread.headSessionId || 'none'}${title}`);
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
    throw new Error('用法: claw threads <list|create|show|events|send|watch|deliver|advance|handoff-failed|resume|close> ...');
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
    // --wait-started [秒]：投递后等待 turn 真正开始（delivered ≠ started），
    // 判据是线程 lifeState 翻到 executing。适用于向 idle 线程派遣的标准
    // 流程；向执行中线程追加指令时此等待会立即通过，需以 events 复核。
    if (args.includes('--wait-started')) {
      const raw = optionValue(args, '--wait-started');
      const waitSeconds = raw === '' ? 15 : Math.min(60, Math.max(1, Number(raw) || 15));
      const started = await waitForTurnStarted(threadId, waitSeconds);
      payload.started = started.started;
      if (started.lifeState) payload.lifeState = started.lifeState;
      if (!started.started && format === 'text') {
        console.error(`等待 ${waitSeconds}s 内未观察到 turn.started（lifeState=${started.lifeState || 'unknown'}）；指令已投递，可用 claw threads events 复核`);
      }
    }
    if (format === 'json' || format === 'jsonl') {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    // 紧凑输出：只给调度判断所需字段，不回显工单全文（长文本会迫使调用方
    // 截断输出，进而丢失其他字段——真实派遣复盘中踩过）。
    const command = payload.command || {};
    const delivered = payload.delivery?.delivered;
    console.log(`sent ${command.commandId || '(unknown)'}  kind=${command.kind || 'user_message'}  duplicate=${payload.duplicate === true}${delivered !== undefined ? `  delivered=${delivered}` : ''}`);
    if (payload.runtimeWake && payload.runtimeWake.ok === false) {
      // head runtime 唤起失败：指令虽入箱但当前无承接进程，属于需要调度的
      // 明确故障（head_session_missing / runtime_ready_timeout），不是正常暂存。
      console.log(`  runtimeWake=failed (${payload.runtimeWake.code}): ${payload.runtimeWake.message}`);
      process.exitCode = 4;
    }
    if (payload.started !== undefined || payload.lifeState) {
      console.log(`  started=${payload.started}  lifeState=${payload.lifeState || 'unknown'}`);
    }
    return;
  }

  if (subcommand === 'watch') {
    const interval = Math.max(0.2, Number(optionValue(args, '--interval')) || 10);
    const timeout = Math.min(590, Math.max(0.5, Number(optionValue(args, '--timeout')) || 540));
    const jsonl = format === 'jsonl' || format === 'json';
    const withResult = args.includes('--with-result');
    // 多线程 any-settle：watch 可接受多个 thread-id，任一线程落定/失败/终态
    // 即整条调用返回（并发跑多个单线程 watch，第一个 settle 的胜出）。
    // 单线程路径行为不变（结果不带 threadId 前缀）。
    const watchTargets = [threadId, ...args.filter((a) => a.startsWith('wt-') && a !== threadId)];
    if (watchTargets.length === 1) {
      const result = await watchThread(threadId, { interval, timeout, jsonl });
      const reply = withResult ? await fetchLastReply(threadId).catch(() => null) : null;
      const summary = `watch done: ${result.reason} | life=${result.lifeState} failed=${result.failed} | newEvents=${result.newEvents} | elapsed=${result.elapsed}s`;
      if (jsonl) console.log(JSON.stringify({ watch: 'done', ...result, ...(reply ? { lastReply: reply } : {}) }));
      else {
        console.log(summary);
        if (result.detail) console.log(`  detail: ${result.detail}`);
        if (reply) printLastReply(reply);
      }
      process.exitCode = result.exitCode;
      return;
    }
    // any-settle：并发单线程监视，quiet 模式下事件不透传（避免多线程交错
    // 难以归属），第一个 settle 的胜出，其余监视被放弃（进程即将退出）。
    const settled = await new Promise((resolve) => {
      let pending = watchTargets.length;
      for (const id of watchTargets) {
        watchThread(id, { interval, timeout, jsonl, quiet: true }).then((result) => {
          if (pending > 0) { pending = 0; resolve({ threadId: id, ...result }); }
        });
      }
    });
    const reply = withResult ? await fetchLastReply(settled.threadId).catch(() => null) : null;
    const summary = `watch done: ${settled.reason} | thread=${settled.threadId} | life=${settled.lifeState} failed=${settled.failed} | newEvents=${settled.newEvents} | elapsed=${settled.elapsed}s`;
    if (jsonl) console.log(JSON.stringify({ watch: 'done', ...settled, ...(reply ? { lastReply: reply } : {}) }));
    else {
      console.log(summary);
      if (reply) printLastReply(reply);
    }
    process.exitCode = settled.exitCode;
    return;
  }

  if (subcommand === 'deliver') {
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/deliver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // 恢复闸唤起失败：与 send 同语义显式提示（指令在箱、无承接 runtime）
    if (payload?.runtimeWake?.ok === false) {
      if (format === 'text') {
        console.error(`runtime 唤起失败（${payload.runtimeWake.code}）：${payload.runtimeWake.message}；指令保持 pending，不重复 deliver`);
      }
      process.exitCode = 4;
    }
    writeThreadPayload(payload, format);
    return;
  }

  if (subcommand === 'advance') {
    const body = { toSessionId: requireOption(args, '--to-session') };
    const fromSessionId = requireOption(args, '--from-session', '--from-session 必填（head CAS：K23 起 head 推进必须显式携带当前 head，可用 `claw threads show` 查看）');
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

  if (subcommand === 'resume' || subcommand === 'close' || subcommand === 'archive' || subcommand === 'unarchive') {
    const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/${subcommand}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subcommand === 'resume'
        ? { source: optionValue(args, '--source', 'cli') }
        : subcommand === 'close'
          ? { reason: optionValue(args, '--reason', 'cli') }
          : {}),
    });
    writeThreadPayload(payload, format);
    return;
  }

  throw new Error(`未知 threads 子命令: ${subcommand || '(空)'}（可用: list / create / show / events / send / watch / deliver / advance / handoff-failed / resume / close / archive / unarchive）`);
}

// 轮询线程 lifeState 直到 executing（head runtime 开始处理投递指令）或超时。
async function waitForTurnStarted(threadId, maxSeconds) {
  const deadline = Date.now() + maxSeconds * 1000;
  let lastLifeState = '';
  while (Date.now() < deadline) {
    await sleep(250);
    let thread;
    try {
      thread = (await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}`))?.thread;
    } catch {
      continue; // server 短暂不可达不打断等待窗口
    }
    lastLifeState = thread?.lifeState || '';
    if (lastLifeState === 'executing') {
      return { started: true, lifeState: lastLifeState };
    }
  }
  return { started: false, lifeState: lastLifeState };
}

// 单调用监控：内部轮询 lifeState + 事件游标，新事件即时透传，线程落定/
// 失败/终态/超时时返回——把"90 秒固定频率手工巡检"折叠成一次阻塞调用。
// 退出码：0=落定或线程终态；2=超时（继续 watch 同一命令即可续挂）；
// 3=failed=true（需按故障表介入）；1=线程/server 连续不可达。
//
// quiet（多线程 any-settle 复用）：不透传事件流——多个线程的事件交错输出
// 无法归属，any-settle 模式下只等结果，胜出线程的信息由摘要行标注。
async function watchThread(threadId, { interval, timeout, jsonl, quiet }) {
  const startedAt = Date.now();
  const deadline = startedAt + timeout * 1000;
  let cursor = 0;
  let newEvents = 0;
  let lifeState = 'unknown';
  let failed = false;
  let idleRounds = 0;
  let errors = 0;
  let turnSettled = false; // 跨轮记忆：turn.completed 与 lifeState 离开 executing 常在不同轮次到达
  // 基线：只取游标不回放历史事件，watch 期间的新事件才透传。
  try {
    const base = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events`);
    cursor = base.cursor ?? 0;
  } catch { /* 事件端点瞬时不可用不阻断监控 */ }
  while (Date.now() < deadline) {
    await sleep(Math.min(interval * 1000, Math.max(1, deadline - Date.now())));
    let thread;
    try {
      thread = (await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}`))?.thread;
      errors = 0;
    } catch (error) {
      errors += 1;
      if (errors >= 3) {
        return { reason: 'unreachable', detail: String(error?.message || error), lifeState, failed, newEvents, elapsed: Math.round((Date.now() - startedAt) / 1000), exitCode: 1 };
      }
      continue;
    }
    lifeState = thread?.lifeState || 'unknown';
    failed = thread?.failed === true;
    let events = [];
    try {
      const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events?after=${cursor}`);
      events = payload.events || [];
      if (payload.cursor !== undefined) cursor = payload.cursor;
    } catch { /* 瞬时失败下轮再取 */ }
    for (const event of events) {
      newEvents += 1;
      if (quiet) continue; // any-settle 模式：事件流不透传，避免多线程交错
      if (jsonl) console.log(JSON.stringify(event));
      else {
        const itemType = event.item?.type ? ` item=${event.item.type}` : '';
        console.log(`  event: ${event.type || 'event'}${event.turn !== undefined ? ` turn=${event.turn}` : ''}${itemType}`);
      }
    }
    if (failed) {
      return { reason: 'failed', lifeState, failed, newEvents, elapsed: Math.round((Date.now() - startedAt) / 1000), exitCode: 3 };
    }
    if (['archived', 'closed'].includes(thread?.status)) {
      return { reason: `thread ${thread.status}`, lifeState, failed, newEvents, elapsed: Math.round((Date.now() - startedAt) / 1000), exitCode: 0 };
    }
    const pending = Array.isArray(thread?.commands) ? thread.commands.filter((command) => command.status === 'pending').length : 0;
    if (events.some((event) => event.type === 'turn.completed')) turnSettled = true;
    if (events.some((event) => event.type === 'turn.started')) turnSettled = false; // 链式多轮：新一轮已接棒
    if (turnSettled && lifeState !== 'executing') {
      return { reason: 'turn.completed', lifeState, failed, newEvents, elapsed: Math.round((Date.now() - startedAt) / 1000), exitCode: 0 };
    }
    if (lifeState !== 'executing' && pending === 0) {
      idleRounds += 1;
      if (idleRounds >= 2) {
        return { reason: 'idle-no-pending', lifeState, failed, newEvents, elapsed: Math.round((Date.now() - startedAt) / 1000), exitCode: 0 };
      }
    } else {
      idleRounds = 0;
    }
  }
  return { reason: 'timeout', lifeState, failed, newEvents, elapsed: Math.round((Date.now() - startedAt) / 1000), exitCode: 2 };
}

// 末轮回复（--with-result）：事件流里最后一个 agent_message item 的全文，
// 即 coder 的最终报告。落定后 item 事件已完整上报，直接取流末尾即可。
async function fetchLastReply(threadId) {
  const payload = await clawServerFetch(`/protoclaw/threads/${encodeURIComponent(threadId)}/events`);
  const events = payload?.events || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') {
      return { turn: event.item.turn, text: String(event.item.text || '') };
    }
  }
  return null;
}

function printLastReply(reply) {
  const turn = reply?.turn !== undefined ? ` (turn=${reply.turn})` : '';
  console.log(`  末轮回复${turn}:`);
  for (const line of String(reply?.text || '').split('\n')) console.log(`    ${line}`);
}

// ── Session dispatch（coder 派遣入口，替代裸 curl）──────────────
// node argv 走 GetCommandLineW（UTF-16），中文标题无损；
// 原生 curl.exe 在非 UTF-8 代码页控制台下会被按 ANSI 转码产生乱码，
// 服务端对 U+FFFD 标题直接 400。

function printSessionsHelp() {
  console.log('用法:');
  console.log('  claw sessions create --agent ID [--session-type main|coder] [--title T] [--dir D] [--format text|json]');
  console.log('');
  console.log('创建预制工作空间会话。线程宿主工作空间（sessionType=coder）的响应');
  console.log('带 threadId（自动建立的线程），可直接用于 claw threads send。');
}

async function handleSessions(args = []) {
  const [subcommand] = args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    printSessionsHelp();
    return;
  }
  if (subcommand !== 'create') {
    throw new Error(`未知 sessions 子命令: ${subcommand}（可用: create）`);
  }
  const format = threadFormat(args);
  const body = {
    agentId: requireOption(args, '--agent'),
  };
  const sessionType = optionValue(args, '--session-type');
  if (sessionType) body.sessionType = sessionType;
  const title = optionValue(args, '--title');
  if (title) body.title = title;
  const dir = optionValue(args, '--dir');
  if (dir) body.openDirectory = dir;
  const payload = await clawServerFetch('/protoclaw/prebuilt_sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Session ${payload.session?.id || payload.targetSessionId || '(unknown)'}`);
  if (payload.session?.title) console.log(`  title: ${payload.session.title}`);
  if (payload.threadId) {
    console.log(`  thread: ${payload.threadId}`);
  } else {
    console.log('  thread: (未自动建立——非线程宿主工作空间或钩子失败，可用 claw threads list 核对)');
  }
}

const LEGACY_ALIASES = {
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

  if (command === 'sessions') {
    await handleSessions(args.slice(1));
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
  console.log('  claw threads send <thread-id> --text TEXT [--idempotency-key KEY] [--wait-started [秒]]');
  console.log('  claw threads deliver <thread-id>         Retry pending command delivery');
  console.log('  claw threads advance <thread-id> --to-session ID --from-session ID');
  console.log('  claw threads handoff-failed <thread-id> [--reason R] [--stage S]');
  console.log('  claw threads resume <thread-id> [--source S]');
  console.log('  claw threads close <thread-id> [--reason R]');
  console.log('  claw threads archive <thread-id>');
  console.log('  claw threads unarchive <thread-id>');
  console.log('  claw sessions create --agent ID [--session-type coder] [--title T] [--dir D]');
  console.log('                                         Create a workspace session; coder 响应带自动建立的 threadId');
  console.log('  claw run <name> --goal "..." [...]     Run a plain agent (viewer-observable; --debug uses Studio source overrides)');
  console.log('  claw acp coder                         Start the coder ACP stdio adapter');
  console.log('');
  console.log('Legacy aliases (default workspace):');
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
  }
  console.log('');
  console.log('  claw ws                 List all workspaces');
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

  if (opName === 'create_session') {
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

// CLI 守卫：仅直接执行时运行主流程；被测试 import 时只暴露 clawServerFetch。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(err => {
    console.error(err?.message || err);
    process.exit(1);
  });
}

export { clawServerFetch };
