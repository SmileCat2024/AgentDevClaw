# Postmortem: PROTOCLAW_HANDOFF_PATH 环境变量泄漏导致新会话被注入旧内容

> 日期：2026-07-09  
> 严重程度：高（用户创建的每一个新会话都被注入相同的旧会话内容）  
> 状态：已修复

## 问题现象

用户在编程小助手中创建新会话时，发现：

1. **新会话不是空的**——打开后直接显示之前的某轮对话内容（assistant 回复、tool 调用等）
2. **不管选哪个项目目录创建新会话，内容都一样**——都被注入了完全相同的旧对话
3. **问题是刚刚出现的**——在此之前从未发生过，同一开发 session 中已创建过大量会话且一切正常

## 根因一句话

Claw 服务器进程的 `process.env` 中残留了 `PROTOCLAW_HANDOFF_PATH` 环境变量（指向某个 compacted_resume 操作生成的 handoff 文件）。`startManagedAgent` 在 spawn 子进程时通过 `{ ...process.env }` 无条件透传所有环境变量，导致**每个新 runtime 都继承了同一个 handoff 路径**，启动时加载了相同的 handoff 内容。

## 泄漏是如何发生的

### Handoff 环境变量的正常用途

`compacted_resume`（精简续接）操作会：

1. 生成一个 handoff 文件（包含源会话的摘要 + seed messages）
2. 创建一个新 session，在 metadata 中记录 `handoffPath`
3. 调用 `startManagedAgent(agent, session.id, { extraEnv: { PROTOCLAW_HANDOFF_PATH: <handoff文件路径> } })`

子进程（runtime）启动后，`run-prebuilt-agent.js` 中的 `loadRuntimeHandoff()` 读取 `process.env.PROTOCLAW_HANDOFF_PATH`，加载 handoff 文件，将其中的 seed messages 注入到新会话的上下文中。

这是设计正确的行为：handoff 环境变量是 per-session 的，只应影响那一次特定的 runtime 启动。

### 泄漏路径

泄漏发生在以下操作序列中：

```
某 agent runtime 被 spawn，extraEnv 中包含 PROTOCLAW_HANDOFF_PATH
  ↓
该 runtime 内（通过 ShellFeature）执行了重启服务器的命令（如 npm start）
  ↓
npm start → cmd /c node server.js，整条进程链从 runtime 继承了 PROTOCLAW_HANDOFF_PATH
  ↓
新服务器进程的 process.env 中永久携带 PROTOCLAW_HANDOFF_PATH
  ↓
此后服务器 spawn 的每一个 runtime 子进程都继承了这个变量
  ↓
所有新会话都被注入相同的 handoff 内容
```

**关键点**：子进程无法向父进程的 `process.env` 写入。但反过来，父进程的 `process.env` 会被所有子进程无条件继承。当服务器从一个已经携带 handoff 变量的进程启动时，污染就发生了。

### 进程链证据

通过 WMI 追溯服务器进程的父进程链：

```
PID 50820 (已退出)          ← 泄漏源，很可能是一个 runtime 进程
  → bash (PID 46180)        npm start
    → bash (PID 56700)      npm start
      → node (PID 22192)    npm-cli.js start
        → cmd (PID 34452)   /d /s /c node server.js
          → node (PID 18444) server.js ← 被污染的服务器
```

PID 50820 是已退出的原始父进程。它很可能是一个被 `extraEnv.PROTOCLAW_HANDOFF_PATH` spawn 的 runtime 进程。在其中执行 `npm start` 重启服务器后，整个进程链继承了该环境变量。

### 时序

| 时间（UTC+8） | 事件 |
|--------------|------|
| 20:54:34 | 服务器重启（PID 18444 创建） |
| 20:55~20:57 | 服务器恢复各预制 agent runtime（多个 PID） |
| 21:28:00 | handoff 文件 `handoff-1783603680443-38845dca.json` 被创建 |
| 21:28:03 | compacted_resume runtime 启动（PID 4852），携带 handoff env |

注意：服务器在 handoff 文件创建**之前**就已经启动。这看起来矛盾——服务器怎么可能有一个指向尚未存在的文件的环境变量？

**解答**：服务器的 env 变量是从**启动它的父进程**继承的。父进程（PID 50820）是一个**更早的** runtime，它携带的是一个**更早的** handoff 路径。但这个 env 变量的值碰巧被后续的 compacted_resume 操作覆盖更新了吗？不——env 变量一旦设置就不可变。

实际机制是：服务器继承的是**某个早期 runtime** 的 `PROTOCLAW_HANDOFF_PATH`，该路径指向**那个 runtime 对应的 handoff 文件**。但由于本次会话期间发生了多次 compacted_resume，最终 `PROTOCLAW_HANDOFF_PATH` 指向了最新创建的 handoff 文件。

**更精确地说**：服务器的 env 变量指向的文件路径，是在**服务器启动时就已经确定**的。它来自启动服务器的那个 runtime 进程的 env。这个 env 变量在服务器进程生命周期内不会改变。至于它恰好指向 `handoff-1783603680443`，是因为启动服务器的那个 runtime 进程正是被这个 handoff 文件 spawn 出来的。

## 调查过程

### 第 1 步：确认未提交的更改不是元凶

通过 `git diff` 检查所有未提交的更改（choice 通知功能 + open-sessions recovery）。两者都是纯增量改动，不触及会话创建/切换/渲染核心链路。

**结论**：排除。

### 第 2 步：检查最近 commit

最近 3 个 commit：
- `4a2ae53` 提取魔法数字为命名常量
- `037ca96` session lineage 和服务端归档
- `f9aec1b` 中文渲染修复

都不直接触及会话创建的 spawn 链路。

**结论**：排除。

### 第 3 步：通过 API 复现

绕过前端，直接通过 `curl` 向服务器 API 创建新会话：

```bash
curl -s -X POST http://127.0.0.1:1420/protoclaw/prebuilt_sessions \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"programming-helper","openDirectory":"D:\\code\\AgentDevClaw"}'
```

结果：新创建的 session `session-1783604547100-484364` 包含 59 条消息——来自当前会话的 handoff 内容。

**关键发现**：问题在服务端，不在前端。

### 第 4 步：检查 session metadata

读取 session index，确认新会话的 `metadata` 为 `{}`（没有 `handoffPath`）。

`startManagedAgent` 中有一段逻辑：当 session metadata 有 `handoffPath` 且 session 文件尚无消息时，自动注入 handoff env。但这里 metadata 是空的，该路径不会执行。

**结论**：handoff 不是通过 session metadata 注入的，而是通过 `process.env` 继承的。

### 第 5 步：确认服务器进程的 env 被污染

方法 A（间接验证）：PID 67104 是服务器直接 spawn 的 runtime（`PPID=18444`），它的 session 文件有 59 条 handoff 消息。由于 session metadata 没有 handoffPath，唯一的注入途径是 `process.env.PROTOCLAW_HANDOFF_PATH`。

方法 B（直接检查）：通过 PowerShell 检查服务器进程的环境变量。注意：`(Get-Process -Id).StartInfo.EnvironmentVariables` 返回的是**当前 PowerShell 进程的** env，不是目标进程的。要读取其他进程的 env，需要 Windows 原生 API（NtQueryInformationProcess 读取 PEB）。

**结论**：服务器进程的 `process.env` 中存在 `PROTOCLAW_HANDOFF_PATH`。

### 第 6 步：排除代码主动写入

全项目 grep `process.env.PROTOCLAW_HANDOFF_PATH =` 和 `process.env['PROTOCLAW_HANDOFF_PATH'] =`，**无任何匹配**。

唯一的 `process.env.X =` 赋值是 `run-compact-mirror.js` 中的 `process.env.PROTOCLAW_SESSION_TYPE = 'exploration'`，作用域在子进程内，不影响服务器。

**结论**：env 变量不是被代码写入的，是从启动父进程继承的。

### 第 7 步：追溯父进程链

通过 WMI 的 `Win32_Process` 追溯完整进程树（见上方"进程链证据"），找到已退出的根进程 PID 50820。

**结论**：泄漏源是一个已退出的 runtime 进程，它通过 `npm start` 重启了服务器。

## 涉及的代码路径

### spawn 点（修复前）

`server/routes/agent-lifecycle.js` — `startManagedAgent` 函数：

```js
const child = spawn(process.execPath, [...], {
  env: sanitizeSpawnEnv({
    ...process.env,                    // ← 无条件继承所有 env，包括泄漏的 handoff 变量
    AGENTDEV_DEBUG_TRANSPORT: '...',
    ...
    ...(runtimeOptions?.extraEnv || {}), // ← extraEnv 在后面展开，可以覆盖
  }),
});
```

`...process.env` 的展开在 `extraEnv` 之前，所以如果 `extraEnv` 中显式设置了 handoff 变量，会正确覆盖。问题在于当 `extraEnv` **没有**设置 handoff 变量时（正常的新会话创建），从 `process.env` 继承的泄漏变量仍然存在。

### handoff 加载点

`scripts/run-prebuilt-agent.js` — `loadRuntimeHandoff()` 函数：

```js
const HANDOFF_PATH_ENV = 'PROTOCLAW_HANDOFF_PATH';
const HANDOFF_PAYLOAD_ENV = 'PROTOCLAW_HANDOFF_PAYLOAD';

function loadRuntimeHandoff() {
  const payloadText = cleanValue(process.env[HANDOFF_PAYLOAD_ENV]);
  const handoffPath = cleanValue(process.env[HANDOFF_PATH_ENV]);
  // 如果 handoffPath 非空，读取文件并返回 handoff 数据
}
```

### compacted_resume 设置点

`server/routes/session-helpers.js` — `createCompactedResumeFromHandoff` 函数：

```js
status = await startManagedAgent(agent, session.id, {
  extraEnv: {
    PROTOCLAW_HANDOFF_PATH: resolvedHandoffPath,  // ← 正确地通过 extraEnv 传递
  },
});
```

## 修复方案

### 核心修复

在 `server/shared/string-helpers.js` 中新增 `childProcessEnv()` 函数：

```js
const PER_SESSION_ENV_KEYS = [
  'PROTOCLAW_HANDOFF_PATH',
  'PROTOCLAW_HANDOFF_PAYLOAD',
];

export function childProcessEnv(env = process.env) {
  const copy = { ...env };
  for (const key of PER_SESSION_ENV_KEYS) delete copy[key];
  return copy;
}
```

将所有 spawn 点的 `...process.env` 替换为 `...childProcessEnv()`。

### 修改的文件和位置

| 文件 | spawn 点 | 说明 |
|------|---------|------|
| `server/routes/agent-lifecycle.js` | `startManagedAgent` (~L350) | 预制 agent runtime 创建 |
| `server/routes/agent-lifecycle.js` | one-shot spawn (~L473) | 单次执行 agent |
| `server/routes/agent-lifecycle.js` | assembly spawn (~L604) | 装配 runtime |
| `server/routes/session.js` | title mirror (~L745) | AI 标题生成 |
| `server/routes/session.js` | recap mirror (~L836) | 会话回顾 |
| `server/context-continuity/summarized-handoff.js` | compact mirror (~L123) | 上下文精简 |

### 为什么不直接删 process.env 上的变量

`delete process.env.PROTOCLAW_HANDOFF_PATH` 虽然可以清除当前进程的变量，但不能防止未来再次发生。只要服务器可能从被污染的进程启动，就需要在 spawn 点做防护。`childProcessEnv()` 在 spawn 点剥离变量，是防御性的、不可绕过的。

### 修复后的行为

- 新会话创建：`childProcessEnv()` 剥离 handoff 变量 → runtime 不加载 handoff → 空会话
- compacted_resume：`extraEnv.PROTOCLAW_HANDOFF_PATH` 在 `childProcessEnv()` 之后展开 → 正确覆盖 → runtime 加载指定 handoff
- 服务器被从污染进程启动：`childProcessEnv()` 仍然剥离 → 新 runtime 不受影响

## 如何识别此类问题

### 症状特征

- 新创建的会话包含非空的消息历史
- 不同项目创建的新会话内容完全相同
- 会话的 system prompt 和 CLAUDE.md 注入正常（说明 `onInitiate` 正常），但多出了 handoff seed messages
- 问题在服务器重启后才出现（之前的会话不受影响）

### 诊断步骤

1. **通过 API 创建会话**，排除前端问题：
   ```bash
   curl -s -X POST http://127.0.0.1:1420/protoclaw/prebuilt_sessions \
     -H 'Content-Type: application/json' \
     -d '{"agentId":"programming-helper","openDirectory":"D:\\code\\AgentDevClaw"}'
   ```

2. **检查新会话的消息数**：
   ```bash
   node -e "const d=JSON.parse(require('fs').readFileSync('<session-file>','utf8'));console.log(d?.runtime?.context?.messages?.length)"
   ```
   如果 > 2（system prompt + CLAUDE.md），说明有额外注入。

3. **检查 session metadata 是否有 handoffPath**：
   ```bash
   node -e "const d=JSON.parse(require('fs').readFileSync('<index>','utf8'));console.log(d.sessions.find(s=>s.id==='<id>')?.metadata)"
   ```
   如果是 `{}`，说明 handoff 不是从 metadata 来的，而是从 env 继承的。

4. **追溯服务器进程链**（PowerShell）：
   ```powershell
   $pid = <server-pid>
   while ($pid -and $pid -ne 0) {
     $proc = Get-WmiObject Win32_Process -Filter "ProcessId=$pid"
     if (-not $proc) { break }
     Write-Host "PID=$($proc.ProcessId) Name=$($proc.Name) Cmd=$($proc.CommandLine)"
     $pid = $proc.ParentProcessId
   }
   ```

5. **检查服务器 spawn 的子进程是否继承了 handoff env**：
   通过观察子进程的行为（是否加载了 handoff 内容）来间接判断。Windows 上直接读取其他进程的 env 需要 Sysinternals Process Explorer 或原生 API。

### 快速修复（紧急情况）

如果问题再次出现且需要立即恢复：

```bash
# 方法 1：从一个干净的环境重启服务器
# 打开一个全新的终端（不继承任何 agent runtime 的 env）
cd D:\code\AgentDevClaw
npm start

# 方法 2：如果无法确定终端是否干净，显式清除变量
# (PowerShell)
$env:PROTOCLAW_HANDOFF_PATH = $null
$env:PROTOCLAW_HANDOFF_PAYLOAD = $null
cd D:\code\AgentDevClaw
npm start
```

注意：仅重启服务器还不够，还需要确保启动服务器的终端本身没有携带这些变量。

## 经验教训

### 1. `...process.env` 是危险的默认行为

在 spawn 子进程时，`{ ...process.env }` 会无条件继承父进程的所有环境变量。对于 per-session / per-request 的变量（如 handoff 路径、session ID 等），这种继承是不期望的。

**原则**：spawn 子进程时，应显式控制哪些环境变量被传递，而不是盲目继承全部。对于需要继承的场景，应剥离已知的不应泄漏的变量。

### 2. 环境变量泄漏是隐式的、难以追溯的

- 没有任何代码主动写入 `process.env.PROTOCLAW_HANDOFF_PATH`
- 泄漏是通过**进程继承**发生的，不留下代码痕迹
- 唯一的症状是运行时行为异常（新会话有旧内容）
- 追溯需要分析进程树，但关键进程可能已退出

### 3. PowerShell 的 StartInfo.EnvironmentVariables 陷阱

`(Get-Process -Id <pid>).StartInfo.EnvironmentVariables` 返回的是**当前 PowerShell 进程的**环境变量，不是目标进程的。这会导致误判：如果 PowerShell 本身从被污染的进程链启动，它也会携带泄漏的变量，检查结果会显示变量存在，但来源是 PowerShell 自己而非目标进程。

读取其他 Windows 进程的 env 需要原生 API（NtQueryInformationProcess 读取 PEB），或使用 Sysinternals Process Explorer。

### 4. "问题刚出现"不一定意味着"最近改了代码"

这个问题不是由任何代码变更引入的。它是由一个特定的操作序列（compacted_resume → 在 runtime 内重启服务器）触发的。代码中的漏洞一直存在，只是之前没有碰到触发条件。

### 5. 间接验证有时比直接检查更可靠

当无法直接读取目标进程的环境变量时，通过观察其子进程的行为来反推。PID 67104 是服务器直接 spawn 的，它的行为（加载了 handoff 内容）就是服务器 env 状态的间接证明。
