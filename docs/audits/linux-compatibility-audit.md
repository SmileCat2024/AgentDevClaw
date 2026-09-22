# AgentDevClaw + AgentDev Linux 兼容性排查与修复报告

> 日期：2026-07-18  
> 范围：`AgentDevClaw`（产品壳层）+ `AgentDev`（框架）双仓库  
> 目标：让 AgentDevClaw 能在 Linux 服务器上部署，通过浏览器端口访问 Agent

---

## 目录

1. [排查方法论](#1-排查方法论)
2. [发现的问题总览](#2-发现的问题总览)
3. [已修复问题详情](#3-已修复问题详情)
4. [已确认兼容的区域](#4-已确认兼容的区域)
5. [新增测试套件](#5-新增测试套件)
6. [修改文件清单](#6-修改文件清单)
7. [部署建议](#7-部署建议)
8. [遗留事项](#8-遗留事项)

---

## 1. 排查方法论

### 搜索模式

使用 ripgrep 全文搜索两个仓库，覆盖以下模式：

| 搜索模式 | 目的 |
|---------|------|
| `process\.platform` | 所有平台条件分支逻辑 |
| `win32` | Windows 特定代码路径 |
| `\\\\\\\\pipe\\\\\\\\` | Named Pipe 硬编码路径 |
| `%USERPROFILE%` | Windows 环境变量引用 |
| `powershell\.exe` | PowerShell 可执行文件硬编码 |
| `cmd\.exe\|ComSpec` | Windows 命令行硬编码 |
| `where bash\|where git` | Windows `where` 命令（vs Linux `which`）|
| `taskkill\|Stop-Process` | 进程 kill 方式差异 |
| `System\.Windows\.Forms` | Windows Forms 依赖 |
| `127\.0\.0\.1\|0\.0\.0\.0` | 网络绑定地址 |
| `MSYSTEM\|MINGW` | Git Bash 特定环境变量 |
| `Git for Windows\|Git Bash` | 描述文本中的 Windows 假设 |

### 排查覆盖的模块

**AgentDevClaw 侧：**
- `server.js` — Express 服务入口、listen 绑定
- `server/routes/agent-startup.js` — 子进程启动、UDS 路径
- `server/routes/fs-operations.js` — 文件选择器
- `server/routes/system-feature-config.js` — Shell 检测、目录浏览 API
- `server/routes/assembly-helpers.js` — Agent 装配
- `server/shared/constants.js` — 端口、origin 常量
- `server/shared/string-helpers.js` — 环境清理
- `scripts/run-prebuilt-agent.js` — 预制 Agent 启动
- `scripts/use-agentdev-local.mjs` — 本地链接管理
- `public/src/app-core.js` — 前端 invoke 桥接
- `public/src/tauri-bridge.js` — Tauri 模式桥接

**AgentDev 侧：**
- `src/features/shell/tools.ts` — Bash 命令执行
- `src/features/shell/powershell.ts` — PowerShell 命令执行
- `src/features/shell/index.ts` — Shell Feature 装配与 manifest
- `src/features/shell/shellQuoting.ts` — 命令引用工具
- `src/features/audio-feedback/index.ts` — 音频反馈
- `src/features/visual/tools.ts` — 截图功能
- `src/features/lsp/servers.ts` — LSP 语言服务器
- `src/features/lsp/which.ts` — 可执行文件查找
- `src/core/viewer-worker.ts` — ViewerWorker IPC
- `src/core/types.ts` — UDS 默认路径
- `src/agents/BasicAgent.ts` — 系统提示词变量注入
- `src/agents/ExplorerAgent.ts` — 探索 Agent 提示词变量注入

---

## 2. 发现的问题总览

| # | 严重度 | 问题 | 状态 |
|---|--------|------|------|
| 1 | **阻塞** | UDS 路径硬编码为 Windows Named Pipe | ✅ 已修复 |
| 2 | **高** | 文件选择器完全依赖 Windows PowerShell | ✅ 已修复（Web 选择器降级） |
| 3 | **高** | 进程组 kill 在 Linux 上失效（缺 `detached: true`） | ✅ 已修复 |
| 4 | **中** | Audio Feedback 无 Linux 分支 | ✅ 已修复 |
| 5 | **中** | Shell Feature manifest 描述 Windows 特化 | ✅ 已修复 |
| 6 | **中** | `MSYSTEM: 'MINGW64'` 在 Linux 上无意义 | ✅ 已修复 |
| 7 | **中** | Bash 错误消息在 Linux 上误导 | ✅ 已修复 |
| 8 | **低** | 系统提示词 `bash环境` 硬编码为 "Git bash" | ✅ 已修复 |
| 9 | **低** | AgentDev `bin` 条目指向 `.cmd` 文件 | ⏳ 遗留 |
| 10 | **低** | Visual Feature 依赖 Windows HWND | ⏳ 遗留（不影响核心功能） |
| 11 | **低** | 无认证机制 | ⏳ 部署时处理 |

---

## 3. 已修复问题详情

### 3.1 UDS 路径硬编码为 Windows Named Pipe（阻塞级）

**问题**：`agent-startup.js` 中两处 `AGENTDEV_UDS_PATH` 默认值硬编码为 `\\.\pipe\agentdev-viewer`。在 Linux 上，子进程用此路径作为 Unix Domain Socket 连接 ViewerWorker，连接失败。

**修复**：

```js
// server/routes/agent-startup.js
export const DEFAULT_UDS_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\agentdev-viewer'
  : '/tmp/agentdev-viewer.sock';
```

两处 env 注入改为引用 `DEFAULT_UDS_PATH` 常量。

**影响文件**：
- `AgentDevClaw/server/routes/agent-startup.js`

---

### 3.2 文件选择器依赖 Windows PowerShell（高）

**问题**：`selectEmptyDirectory()`、`selectFiles()`、`selectDirectory()` 全部使用 `powershell.exe` + `System.Windows.Forms` 打开原生文件选择对话框。在 Linux 上完全不可用。

**修复方案**：三层联动

1. **后端**（`fs-operations.js`）：非 Windows 平台返回 `{ useWebPicker: true, mode: '...' }`
2. **后端**（`system-feature-config.js`）：`/protoclaw/browse_dirs` 新增 `includeFiles=true` 参数支持文件列表
3. **前端**（`app-core.js` + `tauri-bridge.js`）：新增 `window._showWebPicker(mode)` 函数，检测到 `useWebPicker` 时弹出 Web 目录/文件浏览器

Web 选择器复用已有的 `.fs-dir-picker-*` CSS 样式，支持：
- 目录浏览（双击进入子目录）
- 上一级导航
- 路径手动输入
- 文件多选（文件模式下）
- Windows 盘符切换（Windows 上仍有原生选择器，此为降级方案）

**影响文件**：
- `AgentDevClaw/server/routes/fs-operations.js`
- `AgentDevClaw/server/routes/system-feature-config.js`
- `AgentDevClaw/public/src/app-core.js`
- `AgentDevClaw/public/src/tauri-bridge.js`

---

### 3.3 进程组 kill 在 Linux 上失效（高）

**问题**：Shell 和 PowerShell 工具的超时/中止逻辑使用 `process.kill(-child.pid, 'SIGKILL')` 来杀死进程组，但 spawn 时没有设置 `detached: true`。在没有 `detached` 的情况下，子进程与父进程共享进程组（PID ≠ PGID），`process.kill(-pid)` 发信号给不存在的进程组，操作静默失败。结果：超时或中止后，子进程继续运行成为孤儿进程。

**修复**：在非 Windows 平台的 spawn 选项中加入 `detached: true`：

```ts
const isWin = process.platform === 'win32';

const child = spawn(bashPath, bashArgs, {
  cwd: workdir,
  env: {
    ...process.env,
    // MSYSTEM is only meaningful for Git Bash (MSYS2/MinGW) on Windows.
    ...(isWin ? { MSYSTEM: process.env.MSYSTEM || 'MINGW64' } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  // On Linux/macOS, detached: true puts the child in its own process group
  // so that process.kill(-pid) can terminate the entire group on timeout/abort.
  ...(!isWin ? { detached: true } : {}),
});
```

**双路径修改**：框架侧 `src/features/shell/` 和 tgz 包侧 `packages/shell-feature/src/` 同步修改。

**影响文件**：
- `AgentDev/src/features/shell/tools.ts`
- `AgentDev/src/features/shell/powershell.ts`
- `AgentDev/packages/shell-feature/src/tools.ts`
- `AgentDev/packages/shell-feature/src/powershell.ts`

---

### 3.4 Audio Feedback 无 Linux 支持（中）

**问题**：`_playSound` 方法只有 `darwin`（`afplay`）和默认（Windows PowerShell WPF MediaPlayer）两条路径。Linux 上走 Windows 分支，尝试调用 `powershell`，失败。

**修复**：添加 Linux 分支，按优先级尝试常见音频播放器：

```ts
if (process.platform !== 'win32') {
  for (const [cmd, args] of [
    ['pw-play', [audioPath]],         // PipeWire
    ['paplay', [audioPath]],          // PulseAudio
    ['aplay', ['-q', audioPath]],     // ALSA
    ['ffplay', ['-nodisp', '-autoexit', ...]], // ffmpeg
  ]) {
    try {
      await execFileAsync(cmd, args, { timeout: 15000 });
      return;
    } catch { /* try next */ }
  }
  console.warn('[audio-feedback] No audio player found on Linux. ...');
  return;
}
```

无可用播放器时打印警告并静默跳过，不影响 Agent 核心流程。

**双路径修改**：框架侧和 tgz 包侧同步修改。

**影响文件**：
- `AgentDev/src/features/audio-feedback/index.ts`
- `AgentDev/packages/audio-feedback-feature/src/index.ts`

---

### 3.5 Shell Feature Manifest 描述 Windows 特化（中）

**问题**：配置面板中的描述完全是 Windows 视角的：

| 字段 | 旧描述 | 问题 |
|------|--------|------|
| bashEnabled.title | `启用 Bash (Git Bash)` | Linux 不是 Git Bash |
| bashEnabled.description | `需要系统已安装 Git for Windows` | Linux 自带 bash |
| bashPath.description | `bash.exe 的路径` | Linux 没有 .exe |
| powershellEnabled.description | `Windows 系统自带 PowerShell 5.1` | Linux 需额外安装 |
| powershellPath.description | `powershell.exe 或 pwsh.exe 的路径` | Linux 只有 pwsh |

**修复**：所有描述改为平台中性表述，同时提及 Windows 和 Linux/macOS 的不同要求。

**影响文件**：
- `AgentDev/src/features/shell/index.ts`
- `AgentDev/packages/shell-feature/src/index.ts`

---

### 3.6 MSYSTEM 环境变量在 Linux 上无意义（中）

**问题**：`MSYSTEM: process.env.MSYSTEM || 'MINGW64'` 在 Linux 上设置了一个无意义的环境变量。虽然无害（bash 会忽略它），但不够干净。

**修复**：条件展开，仅在 Windows 上设置：

```ts
...(isWin ? { MSYSTEM: process.env.MSYSTEM || 'MINGW64' } : {}),
```

---

### 3.7 Bash 错误消息在 Linux 上误导（中）

**问题**：`runShellCommand` 在找不到 bash 时抛出 `'Git Bash not found. Please install Git for Windows or configure the path in settings.'`，在 Linux 上会误导用户。

**修复**：平台感知的错误消息：

```ts
const hint = process.platform === 'win32'
  ? 'Git Bash not found. Please install Git for Windows or configure the path in settings.'
  : 'Bash not found. Please ensure bash is installed or configure the path in settings.';
```

---

### 3.8 系统提示词 `bash环境` 硬编码（低）

**问题**：`system.md` 模板中 `**bash环境：** \`Git bash\`` 是硬编码的 Windows 假设。

**修复**：引入 `SYSTEM_SHELL_ENV` 动态模板变量：
- `BasicAgent.ts` 和 `ExplorerAgent.ts` 注入 `SYSTEM_SHELL_ENV`
- Linux/macOS 上值为 `native bash`
- Windows 上值为 `Git bash`
- `system.md` 和 `explore.md` 模板改为 `{{SYSTEM_SHELL_ENV}}`

**影响文件**：
- `AgentDev/src/agents/BasicAgent.ts`
- `AgentDev/src/agents/ExplorerAgent.ts`
- `AgentDev/src/core/templates/system.md`
- `AgentDev/src/core/templates/explore.md`

---

## 4. 已确认兼容的区域

以下模块在排查中发现已经正确处理了平台差异，**无需修改**：

| 模块 | 兼容方式 |
|------|---------|
| `shell/tools.ts` `findGitBashPath()` | 非 Windows 返回 `$SHELL \|\| /bin/bash` |
| `shell/powershell.ts` `findPowerShellPath()` | 非 Windows 用 `which pwsh` 查找 PowerShell Core |
| `shell/index.ts` `getAsyncTools()` | 找不到 shell 时跳过工具注册 + warn（优雅降级）|
| `shell/shellQuoting.ts` `rewriteWindowsNullRedirect()` | `>NUL` → `>/dev/null` 自动转换 |
| `lsp/servers.ts` | `npx` vs `npx.cmd`，venv `bin/` vs `Scripts/` |
| `lsp/which.ts` | `where` vs `which` |
| `skills/loader.ts` | Windows 小写化路径去重，Linux 大小写敏感 |
| `os.homedir()` | 跨平台返回正确 home 目录 |
| `system-feature-config.js` `detectShellPath()` | 已有 Linux 分支 |
| `agent-startup.js` npm 命令 | `npm.cmd` vs `npm` |
| `assembly-helpers.js` npm 命令 | `npm.cmd` vs `npm` |
| `use-agentdev-local.mjs` | `junction` vs `dir` 链接类型 |
| `server.js` open-in-explorer | `cmd.exe` / `open` / `xdg-open` |
| `viewer-worker.ts` UDS 清理 | 非 Windows 清理 socket 文件 |
| `mirror-runtime.js` `SYSTEM_PLATFORM` | 传入 `process.platform` 给 prompt |
| `viewer-worker.ts` `getDefaultUDSPath()` | 框架侧已有平台分支 |
| 前端 `_applyShellAvailability()` | 已处理"未检测到"状态 |

---

## 5. 新增测试套件

### AgentDevClaw 侧（node:test 格式）

| 文件 | 测试数 | 覆盖内容 |
|------|--------|---------|
| `test/cross-platform-uds-path.test.js` | 4 | UDS 路径平台分支（Named Pipe vs Unix Socket） |
| `test/cross-platform-fs-operations.test.js` | 4 | 文件选择器 Web fallback、validate_empty_directory |
| `test/cross-platform-browse-dirs.test.js` | 10 | includeFiles 参数、目录/文件混合列表、排序、边界情况 |
| `test/cross-platform-shell-detection.test.js` | 11 | 配置读写、LSP 提取、Shell 可用性检测 |

### AgentDev 侧（vitest 格式）

| 文件 | 测试数 | 覆盖内容 |
|------|--------|---------|
| `src/features/shell/test/cross-platform.test.ts` | 21 | findGitBashPath、findPowerShellPath、manifest 中性化、配置解析、工具注册/禁用、metadata |
| `src/features/audio-feedback/test/cross-platform.test.ts` | 3 | 跨平台初始化、headless 环境不崩溃、禁用状态 |

**总计**：新增 53 个测试，全部通过。

---

## 6. 修改文件清单

### AgentDevClaw（7 个文件修改）

| 文件 | 修改内容 |
|------|---------|
| `server/routes/agent-startup.js` | 导出 `DEFAULT_UDS_PATH`，两处 env 引用常量 |
| `server/routes/fs-operations.js` | 非 Windows 返回 `useWebPicker` |
| `server/routes/system-feature-config.js` | `browse_dirs` 支持 `includeFiles` 参数 |
| `public/src/app-core.js` | 新增 `window._showWebPicker()`，invoke 处理 `useWebPicker` |
| `public/src/tauri-bridge.js` | invoke 处理 `useWebPicker` |

### AgentDev（10 个文件修改）

| 文件 | 修改内容 |
|------|---------|
| `src/features/shell/tools.ts` | `detached: true`、条件 MSYSTEM、平台感知错误消息 |
| `src/features/shell/powershell.ts` | `detached: true` |
| `src/features/shell/index.ts` | manifest 描述中性化、fallback 文案 |
| `src/agents/BasicAgent.ts` | 注入 `SYSTEM_SHELL_ENV` |
| `src/agents/ExplorerAgent.ts` | 注入 `SYSTEM_SHELL_ENV` |
| `src/core/templates/system.md` | `{{SYSTEM_SHELL_ENV}}` |
| `src/core/templates/explore.md` | `{{SYSTEM_SHELL_ENV}}` |
| `packages/shell-feature/src/tools.ts` | 同步框架侧修改 |
| `packages/shell-feature/src/powershell.ts` | 同步框架侧修改 |
| `packages/shell-feature/src/index.ts` | 同步框架侧修改 |

### AgentDev（2 个文件修改）

| 文件 | 修改内容 |
|------|---------|
| `src/features/audio-feedback/index.ts` | Linux 音频播放器分支 |
| `packages/audio-feedback-feature/src/index.ts` | 同步框架侧修改 |

### 新增测试文件（5 个）

| 文件 | 框架 |
|------|------|
| `AgentDevClaw/test/cross-platform-uds-path.test.js` | node:test |
| `AgentDevClaw/test/cross-platform-fs-operations.test.js` | node:test |
| `AgentDevClaw/test/cross-platform-browse-dirs.test.js` | node:test |
| `AgentDevClaw/test/cross-platform-shell-detection.test.js` | node:test |
| `AgentDev/src/features/shell/test/cross-platform.test.ts` | vitest |
| `AgentDev/src/features/audio-feedback/test/cross-platform.test.ts` | vitest |

---

## 7. 部署建议

### 7.1 系统要求

在 Linux 上部署 AgentDevClaw 需要以下组件：

**必需**：
- Node.js 18+（推荐 20+）
- `bash`（所有 Linux 发行版自带）
- `git`（Agent 工作需要）

**推荐安装**（提升体验）：
- PowerShell Core（`pwsh`）：如果需要 PowerShell 工具
  ```bash
  # Ubuntu/Debian
  sudo apt install -y powershell
  ```
- `ffmpeg`：如果需要音频反馈
  ```bash
  sudo apt install -y ffmpeg
  ```

### 7.2 网络安全

AgentDevClaw 支持在设置中的“访问保护”页面配置单密码保护。开启后，浏览器访问工作台和 `/api/*`、`/protoclaw/*` 控制接口都需要登录；密码以服务端哈希形式保存，不保存明文密码。

ViewerWorker 的 2026 端口只绑定 `127.0.0.1`，是 Claw 的内部调试/控制传输，不应手动暴露或映射到公网。主 Web 端口仍可能监听所有接口，因此服务器部署必须同时考虑网络边界。

内置密码是访问控制，不是传输加密。在公网或共享网络部署时，仍应使用以下至少一项：

- **HTTPS 反向代理**（推荐）
- **SSH 隧道**（最简单）：`ssh -L 1420:127.0.0.1:1420 user@server`
- **VPN 或防火墙规则**限制来源 IP

认证关闭时，Claw 不适合直接暴露在公网。

### 7.3 启动方式

```bash
# 克隆仓库
git clone <repo-url> AgentDevClaw
cd AgentDevClaw

# 安装依赖
npm install

# 启动
npm start

# 或指定端口
PORT=8080 npm start
```

访问 `http://<server-ip>:<port>` 即可使用。

---

## 8. 遗留事项

### 8.1 AgentDev `bin` 条目指向 `.cmd` 文件（低）

`AgentDev/package.json` 的 `bin` 条目指向 `.cmd` 文件，在 Linux 上全局安装后 CLI 命令无法执行。但 Claw 通过 `import` 消费框架，不走 bin 命令，**核心功能不受影响**。

建议后续生成跨平台的 `#!/usr/bin/env node` 格式 bin shim。

### 8.2 Visual Feature 依赖 Windows HWND（低）

截图功能基于 Windows 窗口句柄和 Python 截图脚本。编程小助手不使用此 feature，**不影响核心功能**。

### 8.3 双路径 feature 的 tgz 同步

Shell Feature 和 Audio Feedback Feature 是双路径 feature。本次修改已同步两侧源码，但还需要：

1. 在 `packages/shell-feature/` 执行 `npm run build && npm pack`
2. 在 `packages/audio-feedback-feature/` 执行 `npm run build && npm pack`
3. 将新 tgz 复制到 `AgentDevClaw/resources/features/`
4. 更新 Claw 的 `node_modules/@agentdevjs/*` 安装

### 8.4 框架 dist 重建

修改了 `src/features/shell/` 和 `src/agents/` 后，需要在 AgentDev 仓库重建 dist：

```bash
cd D:/code/AgentDev && npm run build
```

然后重启整个 Claw 服务（server.js 才会重新 import）。
