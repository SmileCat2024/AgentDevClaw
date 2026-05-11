# 调试器使用指南

本文档详细说明 AgentDev 调试器的使用方法。

## 启动调试服务器

### 方式 1：使用 agentdev-viewer 命令

```bash
# 默认端口 2026，自动打开浏览器
agentdev-viewer

# 指定端口
agentdev-viewer 3000

# 不自动打开浏览器
agentdev-viewer 2026 false

# 自定义 UDS 路径（高级用法）
agentdev-viewer 2026 false /custom/path
```

### 方式 2：使用环境变量

```bash
# 设置端口
AGENTDEV_PORT=3000 agentdev-viewer

# 禁用自动打开浏览器
AGENTDEV_OPEN_BROWSER=false agentdev-viewer

# 组合使用
AGENTDEV_PORT=3000 AGENTDEV_OPEN_BROWSER=false agentdev-viewer
```

### 方式 3：在框架目录启动

```bash
cd D:\code\AgentDev
npm run server
```

## Agent 连接调试器

### 基础连接

```typescript
import { BasicAgent } from 'agentdev';

const agent = new BasicAgent();

// 连接到调试器
await agent.withViewer('我的Agent', 2026, false);

// 继续执行对话...
const response = await agent.onCall('你好');
```

### 自动启动调试器

`withViewer` 的第三个参数 `openBrowser` 控制是否自动打开浏览器：

```typescript
// 自动打开浏览器
await agent.withViewer('Agent', 2026, true);

// 不打开浏览器
await agent.withViewer('Agent', 2026, false);
```

## DebugHub 直接控制

```typescript
import { DebugHub } from 'agentdev';

const debugHub = DebugHub.getInstance();

// 启动调试器
await debugHub.start(2026, false);

// 获取调试能力
const capabilities = debugHub.getCapabilities();
console.log('传输模式:', capabilities.transportMode);
console.log('运行时 URL:', capabilities.runtimeUrl);
console.log('支持交互输入:', capabilities.interactiveInput);
```

## 调试传输模式

### viewer-worker 模式（默认）

内置 ViewerWorker，通过 UDS (Unix Domain Socket) 通信。

**优点**：
- 开箱即用，无需额外进程
- 低延迟通信

**启用方式**：默认启用，或显式设置

```typescript
import { resolveDebugTransportMode } from 'agentdev';

const transport = resolveDebugTransportMode();
console.log(transport); // 'viewer-worker'
```

### claw 模式

独立 Claw Runtime，通过 HTTP/WebSocket 通信。

**优点**：
- 独立进程，更稳定
- 支持远程调试
- 可作为桌面应用运行

**启用方式**：

```bash
# 设置环境变量
export AGENTDEV_DEBUG_TRANSPORT=claw
export AGENTDEV_CLAW_RUNTIME_URL=http://localhost:3001
```

```typescript
// 代码中检查传输模式
import { resolveDebugTransportMode } from 'agentdev';

const transport = resolveDebugTransportMode();
console.log(transport); // 'claw'
```

## 调试器界面

访问 `http://localhost:2026` 可看到：

| 面板 | 说明 |
|------|------|
| **Messages** | 对话消息历史 |
| **Calls** | 每次 Call 的轮次和状态 |
| **Steps** | 每轮 ReAct 迭代细节 |
| **Tools** | 工具调用详情 |
| **Features** | 已注册 Feature 及其状态 |
| **Hooks** | 生命周期钩子执行记录 |
| **Logs** | 结构化日志 |

## 调试器 MCP

调试器提供只读 MCP 接口，可用于查询调试状态：

```typescript
// 通过 MCP 查询日志
const logs = await mcp.callTool('query_logs', {
  limit: 50,
  level: 'error'
});
```

## 常见问题

### 端口被占用

```
Error: Address already in use
```

**解决方案**：
1. 使用不同端口：`agentdev-viewer 3000`
2. 或关闭占用进程：
   ```bash
   taskkill //F //IM node.exe  # Windows
   pkill -f viewer  # Linux/Mac
   ```

### Agent 无法连接调试器

```
Error: Agent ID not available
```

**解决方案**：确保先调用 `withViewer()` 再执行其他操作。

```typescript
// ✅ 正确
await agent.withViewer('Agent', 2026);
const response = await agent.onCall('你好');

// ❌ 错误
const response = await agent.onCall('你好');
await agent.withViewer('Agent', 2026);
```

### UDS 连接失败（Windows）

Windows 下 UDS 路径格式为 `\\.\pipe\agentdev-viewer`。

**解决方案**：通常自动处理，如遇问题检查防火墙设置。

## 停止调试服务器

在运行 `agentdev-viewer` 的终端按 `Ctrl+C`。

## 开发工作流

### 典型调试流程

1. **启动调试器**：
   ```bash
   agentdev-viewer 2026 false
   ```

2. **运行 Agent**：
   ```typescript
   await agent.withViewer('Agent', 2026, false);
   await agent.onCall('测试输入');
   ```

3. **在浏览器中观察**：
   - 访问 `http://localhost:2026`
   - 查看 Messages、Calls、Steps 等面板

4. **检查日志**：
   - 在 Logs 面板查看结构化日志
   - 或通过 MCP `query_logs` 工具查询

### 使用 MCP 查询调试状态

```typescript
import { DebugHub } from 'agentdev';

const debugHub = DebugHub.getInstance();

// 检查是否支持交互输入
const capabilities = debugHub.getCapabilities();
if (capabilities.interactiveInput) {
  // 可以使用 UserInputFeature
}
```
