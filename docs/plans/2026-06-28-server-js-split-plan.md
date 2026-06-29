# server.js 拆分计划

> 创建日期：2026-06-28
> 状态：Phase 0-4 完成，待执行 Phase 5
> 涉及文件：`server.js`（13,449 行），目标降至 ~300-500 行
> 关联文档：[2026-04-04 前端拆分计划](./2026-06-04-frontend-split-plan.md)

---

## 一、现状评估

### 1.1 数字

| 文件 | 行数 | 路由数 | 函数数（顶层） |
|------|------|--------|---------------|
| server.js | **13,449** | **140** | **~190** |

已拆分到 `server/` 目录的内容（~3,590 行）：

| 文件 | 行数 | 职责 |
|------|------|------|
| `claw-core.mjs` | 367 | Claw MCP 核心 |
| `claw-mcp.js` | 368 | MCP 服务 |
| `conversation-renderer.js` | 941 | 会话 HTML 渲染 |
| `model-preset-resolver.js` | 127 | 模型预设解析 |
| `runtime-call-envelope.js` | 355 | 运行时信封 |
| `providers/programming-helper.mjs` | 399 | PH 项目适配器 |
| `context-continuity/*.js` | 1,033 | 上下文交接包 |

### 1.2 server.js 的三层结构

server.js 不是"一堆路由"，而是三层交织的代码：

```
Layer 1: Helpers + State     L1-6070     (~6000行) — 域helper + 模块级状态
Layer 2: proxyToViewer       L6073-6104  (~32行)   — HTTP代理
Layer 3: Route Handlers      L6106-13445 (~7300行) — 路由定义（多域混合）
```

**关键发现**：只有 Group Chat 是"helpers + routes 物理共址"的域。其他域的 helper 在 Layer 1，routes 在 Layer 3，中间隔了数千行。

### 1.3 与前端文件的横向对比

| 文件 | 行数 | 拆分计划 |
|------|------|----------|
| server.js | 13,449 | **本文档** |
| app-ui.js | 9,873 | 2026-06-04 计划，Phase 1-2a 已完成 |
| app-main.js | 8,122 | 同上（但文件比计划编写时膨胀了 +1,186 行） |

server.js 是全仓库最大的单文件，优先级应高于前端继续拆分。

---

## 二、域分解

按行号范围和职责梳理出的 17 个功能域。

### 2.1 域清单

| # | 域 | 行范围 | 约行数 | 路由数 | 独立状态 | helpers↔routes 共址 |
|---|-----|--------|--------|--------|----------|---------------------|
| 1 | Dispatch 调度系统 | L1-717 + L6148-6399 | ~700 | 7 | 有（6 个 Map） | 否（隔5400行） |
| 2 | Runtime/Assembly 核心 helper | L718-1005 | ~290 | — | managedAgents 等 | — |
| 3 | Session/File/IM/Feature helpers | L1007-2180 | ~1170 | — | _wsCache 等 | — |
| 4 | Workspace 项目状态 | L2180-2790 | ~610 | — | _wsCache | — |
| 5 | Session 元数据 + 搜索 | L2853-3960 | ~1100 | — | _indexLocks 等 | — |
| 6 | Session CRUD + 上下文交接 | L3960-4660 | ~700 | — | 无 | — |
| 7 | 文件系统 + 项目初始化 | L4660-5270 | ~610 | 8 | 无 | 否 |
| 8 | Agent 运行时管理 | L5270-6070 | ~800 | 6 | 无 | — |
| 9 | API 代理 + Identities | L6073-6400 | ~330 | 12 | 无 | — |
| 10 | **Group Chat 群聊系统** | L6400-9300 | **~2900** | 26 | 有（3 个 Map） | **是** |
| 11 | System Feature Config | L9300-9500 | ~200 | 4 | 无 | 是 |
| 12 | 路由层：Session/Model/Runtime | L9500-11100 | ~1600 | ~30 | 无 | — |
| 13 | Audio/Speech | L11000-11200 | ~200 | 2 | 无 | 是 |
| 14 | 上下文交接 + Claw 子代理 | L11200-12000 | ~800 | 8 | 无 | 否 |
| 15 | Flow 图管理 + 能力解析 | L12600-13300 | ~700 | 5 | 无 | 半共址 |
| 16 | Assembly 路由 | L12000-12300 | ~300 | 3 | 无 | 否 |
| 17 | 静态/关闭/入口 | L13300-13445 | ~145 | 6 | 无 | — |

### 2.2 各域跨域调用实测

用 `sed` 切片 + `grep` 对每个域统计其调用其他域 helper 的次数：

| 域 | 跨域调用总数 | 最依赖的外部函数 |
|----|-------------|-----------------|
| Group Chat (L6400-9300) | **44** | readSessionIndex(11), getManagedRuntimeKey(7), getAgentRuntime(7), requireAgentLight(5), createPrebuiltSession(4), startManagedAgent(2), stopManagedAgent(2) |
| Dispatch (L1-717) | **16** | startManagedAgent(3), readWorkspaceState(2), readSessionIndex(2), activatePrebuiltSession(2) |
| IM (L1074-1530) | **14** | readJson(5), ensureDir(4), getManagedRuntimeKey(2), getAgentRuntime(2) |
| 路由段 (L9500-13445) | **118** | proxyToViewer(10), requireAgentLight(9), ensureDir(8), writeWorkspaceState(7), updateSessionIndex(7) |

---

## 三、共享状态地图

### 3.1 Tier 1：全局核心（多域读写）

| 状态 | 定义位置 | 类型 | 引用位置 | 说明 |
|------|----------|------|----------|------|
| `app` | L65 | Express | 全部路由 | 传参注入 |
| `viewerWorker` | L66 | ViewerWorker | Agent管理/API代理/Runtime | 传参注入 |
| `managedAgents` | L68 | Map | L730,743,5798,5819,5828,7307,7628,13387 | **必须提取为共享单例** |
| `assemblyRuntimeProcesses` | L69 | Map | L749,6027,6051,13394 | 同上 |

### 3.2 Tier 2：域内状态（随域移动）

| 状态 | 域 | 风险 |
|------|-----|------|
| dispatchSchedules 等 6 个 Map | Dispatch | 低 |
| _gcAdminLocks, gcInboxQueue 等 | Group Chat | 低 |
| weixinBindingSessions | IM | 低 |
| _wsCache | Workspace | 低 |
| _indexLocks | Session | 低 |
| _searchIndexCache | Session/搜索 | 低 |

### 3.3 Tier 3：跨域 helper 函数

**实测调用频次**（`grep -c` 全文件）：

| 函数 | 调用次数 | 定义行 | 依赖 | Phase 0 提取？ |
|------|----------|--------|------|---------------|
| `cleanSessionText` | **333** | L2984 | 无 | **是** |
| `sanitizeSessionFragment` | **71** | L776 | 无 | **是** |
| `buildStatus` | 15 | L989 | getAgentRuntime | **是** |
| `readJson` | — | L1007 | fs | **是** |
| `ensureDir` | — | L1070 | fs | **是** |
| `getAgentRuntime` | — | L741 | managedAgents | **是** |
| `getManagedRuntimeKey` | — | L718 | sanitizeSessionFragment | **是** |
| `readSessionIndex` | — | L2853 | path helpers, cleanSessionText, normalizeSessionMetadata | **是** |
| `sendIPCtoSession` | — | L10262 | getAgentRuntime | **是** |
| `proxyToViewer` | — | L6073 | VIEWER_ORIGIN | **是** |
| `requireAgentLight` | — | L5245 | getAgentsLight, discoverAgents, buildStatus | **否**（Agent Lifecycle 域） |
| `resolveSessionModelInfo` | 11 | L10709 | flattenModelPresets, readModelPresets, readModelConfig | **否**（Model Config 域） |
| `readWorkspaceState` | — | L2183 | normalizeWorkspaceState, readSessionIndex, _wsCache | **否**（Workspace 域） |
| `writeWorkspaceState` | — | L2234 | syncFeatureCreatorProjects 等 7 个域特定函数 | **否**（Workspace 域） |

---

## 四、循环依赖：Dispatch ↔ Agent Lifecycle

这是整个拆分方案中最关键的架构约束。

```
Dispatch.fireSingleTarget (L345)
  → startManagedAgent (L5690)           ← Dispatch 调 Agent Lifecycle
    → emitDispatchReadyEvent (L5809)     ← Agent Lifecycle 反向调 Dispatch
```

此外：

- `restoreDispatchSchedulesOnBoot()`（L596）是**模块顶层副作用**——server.js 被 import/parse 时立即执行
- `fireBootSchedules()`（L13441）在 `app.listen` 回调中调用——依赖 Express 启动完成

### 打破策略：回调注册模式

```js
// server/shared/runtime-hooks.js（新文件，~15行）
const _readyCallbacks = [];
export function onRuntimeReady(cb) { _readyCallbacks.push(cb); }
export function notifyRuntimeReady(agentId, sessionId) {
  for (const cb of _readyCallbacks) {
    try { cb(agentId, sessionId); } catch (e) { console.error('[runtime-hook]', e); }
  }
}
```

server.js 中 `startManagedAgent` 的改动（L5809）：

```diff
-      emitDispatchReadyEvent(agent.id, resolvedSessionId || null);
+      notifyRuntimeReady(agent.id, resolvedSessionId || null);
```

Dispatch 初始化时注册回调：

```js
import { onRuntimeReady } from '../shared/runtime-hooks.js';
onRuntimeReady((agentId, sessionId) => emitDispatchReadyEvent(agentId, sessionId));
```

**时序保证**：`onRuntimeReady` 注册必须在 `app.listen` 之前完成（在 server.js 的模块顶层或 `main()` 开头），以确保第一个 agent 启动前回调已注册。

---

## 五、Phase 0：共享基础设施提取

### 5.0 设计原则

1. **只提取真正域无关的代码**——不碰有域特定逻辑的函数
2. **managedAgents 以引用共享**——不复制，不包装，直接 export Map 本身
3. **依赖注入模式**——尚未提取的域函数（如 `startManagedAgent`）通过 `ctx` 参数传给域模块

### 5.1 提取清单（经逐行验证）

#### 5.1.1 `server/shared/constants.js`（~35行）

来源：L34-63

> **⚠️ P0-1 修正（验证发现）**：原计划直接将 `export const __dirname = path.dirname(fileURLToPath(import.meta.url))` 放入 `server/shared/constants.js`，但 `import.meta.url` 会解析为 `server/shared/constants.js` 自身路径，导致 `__dirname = server/shared` 而非项目根。所有依赖 `__dirname` 的路径常量（约 20 个）会全部错位，启动即崩。
>
> **修正**：不再 export `__filename`/`__dirname`，改用语义化的 `PROJECT_ROOT`，通过相对自身路径向上 2 级计算项目根。

```js
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// server/shared/constants.js → 向上 2 级到项目根
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const rootRequire = createRequire(path.join(PROJECT_ROOT, 'package.json'));
export const APP_PORT = Number.parseInt(process.env.PORT || '1420', 10);
export const VIEWER_PORT = Number.parseInt(process.env.AGENTDEV_VIEWER_PORT || '2026', 10);
export const AGENTS_ROOT = path.join(PROJECT_ROOT, 'prebuilt-agents');
export const RUNTIME_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'run-prebuilt-agent.js');
export const ONE_SHOT_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'run-one-shot-agent.js');
export const AGENTDEV_ROOT = path.resolve(PROJECT_ROOT, '..', 'AgentDev');
export const AGENTDEV_CREATE_FEATURE_CLI = path.join(AGENTDEV_ROOT, 'dist', 'create-feature-cli.js');
export const VIEWER_ORIGIN = `http://127.0.0.1:${VIEWER_PORT}`;
export const USER_DATA_ROOT = path.join(os.homedir(), '.agentdev', 'AgentDevClaw');
export const NO_SESSION_TOKEN = '__protoclaw-no-session__';
export const PREBUILT_SESSIONS_ROOT = path.join(USER_DATA_ROOT, 'prebuilt-sessions');
export const PREBUILT_WORKSPACES_ROOT = path.join(USER_DATA_ROOT, 'workspaces');
export const PROJECT_QQBOT_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'qqbot.config.json');
export const PROJECT_WEIXIN_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'weixin-bot.config.json');
export const PROJECT_FEISHU_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'feishu-bot.config.json');
export const PROJECT_WECOM_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'wecom-bot.config.json');
export const PROJECT_IM_WORKSPACE_CONFIG_PATH = path.join(PROJECT_ROOT, '.agentdev', 'im-workspace.config.json');
export const FEATURE_REPOSITORY_ROOT = path.join(PROJECT_ROOT, 'resources', 'features');
export const USER_FEATURE_REPOSITORY_ROOT = path.join(USER_DATA_ROOT, 'user-features');
export const FEATURE_MANIFEST_NAME = 'agentdev-feature.json';
export const GROUP_CHATS_ROOT = path.join(USER_DATA_ROOT, 'group-chats');
export const WORKSPACE_SESSION_AGENT_IDS = new Set(['feature-creator', 'agent-creator', 'programming-helper', 'flow-workspace']);
export const HIDDEN_PREBUILT_AGENT_IDS = new Set(['agent-creator', 'flow-test']);
export const PROJECT_DOCSET_SUBPATH = path.join('.agentdev', 'claw-workspace');
export const MODEL_CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'default.json');
export const MODEL_PRESETS_PATH = path.join(PROJECT_ROOT, 'config', 'presets.json');
export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
```

依赖：`os`, `path`, `url`, `module`（Node.js 内置）。零域依赖。

> **server.js 侧适配**：server.js 中原 `__dirname` 的引用（约 30 处）需改为 `PROJECT_ROOT`；原 `__filename` 引用（如有）需在 server.js 本地保留 `const __filename = fileURLToPath(import.meta.url)` 或直接内联。

#### 5.1.2 `server/shared/string-helpers.js`（~15行）

来源：L724-726（`log`）, L776-786（`sanitizeSessionFragment` / `isWorkspaceSessionAgent`）, L2984-2986（`cleanSessionText`）

> **P0-4 修正（验证发现）**：原计划标注来源为 "L776-786, L2984-2986"，遗漏了 `log()` 的实际位置 L724-726。

```js
import { WORKSPACE_SESSION_AGENT_IDS } from './constants.js';

export function sanitizeSessionFragment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'default';
}

export function cleanSessionText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function isWorkspaceSessionAgent(agentId) {
  return WORKSPACE_SESSION_AGENT_IDS.has(sanitizeSessionFragment(agentId));
}

export function log(prefix, message, stream = 'log') {
  console[stream](`[${prefix}] ${message}`);
}
```

依赖：constants.js 的 `WORKSPACE_SESSION_AGENT_IDS`。

#### 5.1.3 `server/shared/fs-helpers.js`（~10行）

来源：L1007-1017, L1070-1072

```js
import { promises as fs } from 'fs';

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function readJsonSafe(filePath, fallback = null) {
  try {
    return await readJson(filePath);
  } catch {
    return fallback;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}
```

依赖：`fs`。零域依赖。

#### 5.1.4 `server/shared/agent-access.js`（~90行）

来源：L68-69, L718-805, L989-1005

```js
import { sanitizeSessionFragment } from './string-helpers.js';
import { NO_SESSION_TOKEN } from './constants.js';

export const managedAgents = new Map();        // ← 单例，直接 export Map 引用
export const assemblyRuntimeProcesses = new Map();

export function getManagedRuntimeKey(agentId, sessionId = null) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  const normalizedSessionId = sessionId == null ? NO_SESSION_TOKEN : sanitizeSessionFragment(sessionId);
  return `${normalizedAgentId}::${normalizedSessionId}`;
}

export function listAgentRuntimes(agentId) {
  const normalizedAgentId = sanitizeSessionFragment(agentId);
  return Array.from(managedAgents.values())
    .filter(rt => sanitizeSessionFragment(rt.agentId || rt.id) === normalizedAgentId);
}

export function pickPrimaryAgentRuntime(agentId) {
  const runtimes = listAgentRuntimes(agentId);
  if (runtimes.length === 0) return null;
  const running = runtimes.filter(rt => rt?.process && rt.process.exitCode === null && !rt.stopped);
  const pool = running.length ? running : runtimes;
  return pool.sort((l, r) => String(r.startedAt || '').localeCompare(String(l.startedAt || '')))[0] || null;
}

export function getAgentRuntime(agentId, sessionId = undefined) {
  if (sessionId !== undefined) {
    return managedAgents.get(getManagedRuntimeKey(agentId, sessionId)) ?? null;
  }
  return pickPrimaryAgentRuntime(agentId);
}

export function getAssemblyRuntime(sessionId) {
  return assemblyRuntimeProcesses.get(sanitizeSessionFragment(sessionId)) ?? null;
}

export async function stopAssemblyRuntime(sessionId) {
  const runtime = getAssemblyRuntime(sessionId);
  if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
    return { sessionId: sanitizeSessionFragment(sessionId), status: 'stopped' };
  }
  runtime.stopped = true;
  const normalizedSessionId = sanitizeSessionFragment(sessionId);
  const waitForExit = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2500);
    runtime.process.once('exit', () => { clearTimeout(timeout); resolve(true); });
  });
  runtime.process.kill('SIGTERM');
  const exited = await waitForExit;
  return { sessionId: normalizedSessionId, status: exited ? 'stopped' : 'stopping', viewerAgentId: runtime.viewerAgentId ?? null };
}

export function buildStatus(agentId, sessionId = undefined) {
  const runtime = getAgentRuntime(agentId, sessionId);
  if (!runtime) {
    return { id: agentId, status: 'stopped', pid: null, startedAt: null, exitCode: null, viewerAgentId: null, selectedSessionId: null };
  }
  const running = runtime.process && runtime.process.exitCode === null && !runtime.stopped;
  return {
    id: agentId,
    status: running ? 'running' : 'stopped',
    pid: running ? runtime.process.pid : null,
    startedAt: runtime.startedAt ?? null,
    exitCode: runtime.exitCode ?? null,
    viewerAgentId: running ? (runtime.viewerAgentId ?? null) : null,
    selectedSessionId: runtime.selectedSessionId ?? null,
  };
}
```

依赖：string-helpers.js。**managedAgents 作为裸 Map 导出**——消费者可以直接 `.entries()` 遍历（GC 需要）。

#### 5.1.5 `server/shared/session-access.js`（~200行）

来源：L1019-1068, L2853-3006, L10690-10700

> **P0-2 修正（验证发现）**：`readSessionIndexSync`（L10690）使用同步 API `readFileSync`，而 `fs-helpers.js` 仅 import `{ promises as fs }`。session-access 模块需单独 `import { readFileSync } from 'fs'`。
>
> **P0-3 修正（验证发现）**：原清单遗漏了位于提取范围内的两个函数：
> - `resolvePrebuiltSessionType`（L2895-2928）——夹在 `readSessionIndex` 和 `writeSessionIndex` 之间。依赖仅 `cleanSessionText`、`readSessionIndex`、`getPrebuiltSessionFilePath`、`fs.readFile`，全部在 Phase 0 内，应一并移入。
> - `buildSessionTitle`（L2970-2982）——夹在 `updateSessionIndex` 和 `cleanSessionText` 之间。零依赖，移入 string-helpers 或 session-access 均可。

包含：
- 路径 helper：`getPrebuiltAgentSessionDir`, `getPrebuiltSessionFilePath`, `getPrebuiltSessionIndexPath`, `getPrebuiltWorkspaceDir`, `getPrebuiltWorkspaceStatePath`, `getPrebuiltWorkspaceArtifactsDir`, `getWorkspaceArtifactPath`, `getProjectDocsetDir` 系列
- `_indexLocks` Map（L2930）
- `readSessionIndex`（L2853, ~40行）
- `resolvePrebuiltSessionType`（L2895, ~34行）——**P0-3 补充**
- `writeSessionIndex`（L2932, ~20行）
- `updateSessionIndex`（L2953, ~15行）
- `buildSessionTitle`（L2970, ~12行）——**P0-3 补充**
- `normalizeSessionMetadata`（L2988, ~20行）——readSessionIndex 的依赖
- `readSessionIndexSync`（L10690, ~10行）

依赖：constants.js, string-helpers.js, fs-helpers.js, 以及 `readFileSync`（直接从 `fs` 导入）。**不依赖任何域特定函数**。

#### 5.1.6 `server/shared/ipc.js`（~20行）

来源：L10262-10276

```js
import { getAgentRuntime } from './agent-access.js';
import { log } from './string-helpers.js';

export function sendIPCtoSession(targetAgentId, targetSessionId, message) {
  const runtime = getAgentRuntime(targetAgentId, targetSessionId);
  if (!runtime?.process || runtime.process.exitCode !== null || runtime.stopped) {
    log('ProtoClaw IPC', `Target ${targetAgentId}::${targetSessionId} not running`, 'warn');
    return false;
  }
  try {
    runtime.process.send(message);
    log('ProtoClaw IPC', `Sent to ${targetAgentId}::${targetSessionId}: ${JSON.stringify(message)}`);
    return true;
  } catch (err) {
    log('ProtoClaw IPC', `Failed to send to ${targetAgentId}::${targetSessionId}: ${err}`, 'error');
    return false;
  }
}
```

依赖：agent-access.js。**15 行，极简。**

#### 5.1.7 `server/shared/proxy.js`（~35行）

来源：L6073-6104

```js
import { VIEWER_ORIGIN } from './constants.js';

export async function proxyToViewer(req, res) {
  const targetUrl = `${VIEWER_ORIGIN}${req.originalUrl}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (key.toLowerCase() === 'host') continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = req.method.toUpperCase();
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) { chunks.push(chunk); }
    init.body = Buffer.concat(chunks);
  }
  const response = await fetch(targetUrl, init);
  res.status(response.status);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  const arrayBuffer = await response.arrayBuffer();
  res.end(Buffer.from(arrayBuffer));
}
```

依赖：constants.js。**32 行，纯 HTTP 代理。**

#### 5.1.8 `server/shared/runtime-hooks.js`（~15行，新代码）

```js
const _readyCallbacks = [];
export function onRuntimeReady(cb) { _readyCallbacks.push(cb); }
export function notifyRuntimeReady(agentId, sessionId) {
  for (const cb of _readyCallbacks) {
    try { cb(agentId, sessionId); } catch (e) { console.error('[runtime-hook]', e); }
  }
}
```

### 5.2 Phase 0 不提取的函数

| 函数 | 原因 |
|------|------|
| `readWorkspaceState` (L2183, ~50行) | 调用 `normalizeWorkspaceState`、`readSessionIndex`、`normalizeWorkspacePhProject`、`syncFeatureCreatorProjects` 等域特定函数 |
| `writeWorkspaceState` (L2234, ~40行) | 调用 `syncFeatureCreatorProjects`、`syncAgentCreatorProjects`、`syncFlowAssemblyProjects`、`buildFeatureCreatorDraftArtifact`、`syncWorkspaceProjectDocset` 等 7 个域特定函数 |
| `resolveSessionModelInfo` (L10709, ~55行) | 依赖 `flattenModelPresets`→`readModelPresets`→`readModelPresetsFile`→`normalizeModelPresetsData` 的完整 model config 链（~200行） |
| `requireAgentLight` / `requireAgent` (L5245/L5258) | 依赖 `getAgentsLight`→`discoverAgents`（文件系统扫描）、`enrichAgent` |
| `startManagedAgent` (L5690, ~150行) | Agent Lifecycle 核心，调用 `emitDispatchReadyEvent`、`readProjectIMWorkspaceConfig`、`resolveRuntimeDisplayName` 等 |

这些函数在域提取时通过**依赖注入**（`ctx` 参数）传递给域模块。

### 5.3 Phase 0 依赖注入模式

对于域模块需要但尚未提取的函数，使用 `ctx` 参数注入：

```js
// server.js 中（组合根）
import { setupGroupChatRoutes } from './server/routes/group-chat.js';

setupGroupChatRoutes(app, {
  // Phase 0 共享模块（已提取）
  managedAgents, getAgentRuntime, getManagedRuntimeKey,
  readSessionIndex, sendIPCtoSession,
  // 仍在 server.js 中的函数（通过引用传递）
  startManagedAgent, stopManagedAgent, waitForManagedRuntimeReady,
  createPrebuiltSession, requireAgentLight,
});
```

域模块内部：

```js
// server/routes/group-chat.js
export function setupGroupChatRoutes(app, ctx) {
  const { managedAgents, readSessionIndex, startManagedAgent, ... } = ctx;
  // ... 使用 ctx 中的函数
}
```

**原则**：域模块**不 import server.js**，只从 `server/shared/*` import + 接收 `ctx` 注入。这彻底避免循环依赖。

### 5.4 Phase 0 验证清单

完成 Phase 0 后，必须逐一验证：

1. **启动验证**：`npm start` → 无报错 → 前端页面正常加载
2. **消息收发**：向 agent 发消息 → 正常响应（验证 `sendIPCtoSession` → `getAgentRuntime` 链）
3. **API 代理**：查看 hooks 面板 / logs / chunks（验证 `proxyToViewer`）
4. **Dispatch 回调**：创建一个 on-ready 调度 → 启动对应 agent → 调度被触发（验证 `notifyRuntimeReady` → Dispatch 回调链）
5. **Session 读写**：创建新会话 → 切换会话 → 恢复历史会话（验证 `readSessionIndex` / `writeSessionIndex` / `updateSessionIndex`）
6. **GC managedAgents 遍历**：打开群聊 → awareness 查询正常（验证 `managedAgents.entries()` 直接遍历）

---

## 六、Phase 1-7 拆分顺序

### Phase 1：低耦合共址域（低风险）

| 子阶段 | 域 | 行数 | 共址 | 前提 |
|--------|-----|------|------|------|
| 1a | System Feature Config + Shell | ~200 | 是 | Phase 0 |
| 1b | Model Config 文件 I/O | ~480 | 是 | Phase 0（`resolveSessionModelInfo` 留在 model-config 模块） |
| 1c | 文件系统操作 | ~350 | 否 | Phase 0 |

Phase 1 后 server.js：~12,400 行。

### Phase 2：Group Chat（最大体量收益）

一次搬走 ~2900 行（L6400-9300 连续块），server.js 降至 ~9,500 行。

44 处跨域调用全部通过 Phase 0 shared + ctx 注入解决。

- **特殊注意**：GC 的 `resolveGroupChatSessionSync`（L7300）直接 `managedAgents.entries()` 遍历——通过 shared/agent-access.js 的 `managedAgents` export 解决
- **提取模式**：整块 L6400-9300 移入 `server/routes/group-chat.js`，保留内部函数顺序不变

### Phase 3：Dispatch

helpers（L1-717）+ routes（L6148-6399）一起搬。

循环依赖已在 Phase 0 打破。`restoreDispatchSchedulesOnBoot()` 转为显式 `initDispatch()` 调用。`fireBootSchedules()` 仍在 `app.listen` 回调中。

Phase 3 后 server.js：~8,800 行。

### Phase 4：IM

helpers（原 L1074-1530，实际 L287-741）+ routes（原 L10107-10449，实际 L5754-6315）。

跨域调用 14 处：8 处 `readProjectIMWorkspaceConfig` + 5 处 `getPortalAgentDisplayName` 通过 export 回导，6 个 agent lifecycle 函数通过 ctx 注入。

额外修复：`getUsageContextTokens` 在 server.js 中被调用但未定义（Phase 2 提取遗留），已内联到 im.js。

Phase 4 后 server.js：~7,492 行。

### Phase 5：Session 系统（最散布）

两步走：
- **5a**：搬 session 路由（散布在 L9626-12224）→ `server/routes/session.js`
- **5b**：搬 session helpers（L2853-4660）→ `server/routes/session-helpers.js`

Phase 5 后 server.js：~5,000 行。

### Phase 6：Flow + Feature Repository + PH Project

各自独立度高，快速搬走。

Phase 6 后 server.js：~3,500 行。

### Phase 7：Agent Lifecycle 核心（最后）

`startManagedAgent`、`stopManagedAgent`、`startAssemblyRuntime`、`getConnectedAgents` 等。

最终 server.js：~300-500 行（组合根 + 中间件 + 启动逻辑）。

---

## 七、风险矩阵

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| ~~**Phase 0 `__dirname` 重定位 bug**~~ | ~~高~~ | ~~全站路径错位~~ | ~~**P0-1 已修正**：用 `PROJECT_ROOT` 替代，向上 2 级计算项目根~~ |
| **Phase 0 managedAgents 引用断裂** | 低 | 全站崩溃 | export Map 本身，不包装；grep 确认所有引用点都已改为 import |
| **Phase 0 notifyRuntimeReady 时序问题** | 中 | Dispatch 事件丢失 | 在 `main()` 开头注册回调，确保在 `app.listen` 前 |
| **Phase 0 `readSessionIndexSync` 缺少 `readFileSync`** | ~~中~~ | ~~session-access 启动报错~~ | ~~**P0-2 已修正**：文档已标注 session-access 需单独 import~~ |
| **Phase 2 GC 遗漏跨域函数** | ~~中~~ | ~~GC 功能异常~~ | ~~**已完成**：44 处调用逐一核对，8 个函数通过 ctx 注入~~ |
| **Phase 3 Dispatch top-level 副作用** | 低 | 调度丢失 | 转为显式 init()，在正确位置调用 |
| **Express 路由顺序** | 低 | 路由不匹配 | 保持路由注册顺序不变；用 `app.use(prefix, router)` 前缀挂载 |
| **ESM import 循环** | 低 | 启动失败 | Phase 0 shared 模块互不依赖；域模块不 import server.js |

---

## 八、执行跟踪

| Phase | 模块 | 状态 | server.js 行数 | 日期 |
|-------|------|------|---------------|------|
| 0 | shared/* (constants, fs, string, agent-access, session-access, ipc, proxy, runtime-hooks) | ✅ 完成 | 13,449 → 13,083 | 2026-06-28 |
| 1a | system-feature-config | ✅ 完成 | 13,083 → 12,908 | 2026-06-28 |
| 1b | model-config | ✅ 完成 | 12,908 → 12,394 | 2026-06-28 |
| 1c | fs-operations | ✅ 完成 | 12,394 → 12,188 | 2026-06-28 |
| 2 | group-chat | ✅ 完成 | 12,189 → 9,394 | 2026-06-29 |
| 3 | dispatch | ✅ 完成 | 9,394 → 8,500 | 2026-06-29 |
| 4 | im | ✅ 完成 | 8,500 → 7,492 | 2026-06-29 |
| 5 | session | 待执行 | → ~5,000 | |
| 6 | flow + feature-repo + ph-project | 待执行 | → ~3,500 | |
| 7 | agent-lifecycle + 收编 | 待执行 | → ~300-500 | |
