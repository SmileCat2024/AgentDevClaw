# 调试器测试

## 核心原则

**调试器需要 Agent 进程保持运行**

进程退出后调试器连接断开，无法观察到数据。

## 测试步骤

### 1. 配置 API

`config/default.json`:
```json
{
  "defaultModel": {
    "provider": "openai",
    "apiKey": "${OPENAI_API_KEY}",
    "model": "gpt-4o-mini"
  }
}
```

```bash
export OPENAI_API_KEY=sk-xxx
```

### 2. 启动调试服务器

```bash
agentdev-viewer 2026 false
```

### 3. 创建测试脚本

`test.ts`:
```typescript
import { BasicAgent } from 'agentdev';

async function main() {
  const agent = new BasicAgent();
  await agent.withViewer('测试Agent', 2026, true);
  console.log('调试器页面: http://localhost:2026');

  // 执行测试对话
  await agent.onCall('你好，请介绍一下你自己');
  await agent.onCall('你能做什么？');

  // 保持运行
  await new Promise(() => {});
}

main().catch(console.error);
```

### 4. 运行测试

```bash
npx tsx test.ts
```

### 5. 浏览器观察

访问 `http://localhost:2026`，查看：
- Messages - 对话历史
- Calls - 调用轮次
- Steps - ReAct 迭代
- Tools - 工具调用
- Features - 已注册 Feature
- Logs - 结构化日志

## 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 看不到数据 | 进程已退出 | 使用持续运行模式 |
| API 错误 | 配置不正确 | 检查 config 和环境变量 |
| 连接失败 | 调试器未启动 | 运行 agentdev-viewer |

## 错误示例

```typescript
// 错误：立即退出
await agent.onCall('测试');
await agent.dispose();
```

## 正确示例

```typescript
// 正确：保持运行
await agent.withViewer('Agent', 2026, true);
await agent.onCall('测试');
await new Promise(() => {}); // 无限等待
```
