
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 动态导入 agent.js
const agentModule = await import('./agent.js');

// 获取 Agent 类
const AgentClass = agentModule.default || agentModule.ProgrammingHelperAgent || agentModule.QQBotProgrammingHelperAgent;

if (!AgentClass) {
  console.error('[错误] 无法找到 Agent 类导出');
  console.error('导出的内容:', Object.keys(agentModule));
  process.exit(1);
}

// 创建 agent 实例
const agent = new AgentClass({
  name: '编程小助手',
});

console.log('[ProtoClaw Launcher] Agent 实例已创建: 编程小助手');
console.log('[ProtoClaw Launcher] 正在连接到 ViewerWorker (端口 2026)...');

// 连接到 debugger
await agent.withViewer('编程小助手', 2026, false);

console.log('[ProtoClaw Launcher] ✓ 已连接到 ViewerWorker');
console.log('[ProtoClaw Launcher] Agent "编程小助手" 现在应该出现在 debugger 左侧列表中');

const userInput = agent.features?.get?.('user-input');
if (!userInput || typeof userInput.getUserInput !== 'function') {
  console.error('[错误] 当前 Agent 未挂载可用的 UserInputFeature，无法进入交互循环');
  process.exit(1);
}

const sessionId = 'protoclaw-' + 'programming-helper';
try {
  await agent.loadSession(sessionId);
  console.log('[ProtoClaw Launcher] ✓ 已恢复会话: ' + sessionId);
} catch {
  console.log('[ProtoClaw Launcher] 创建新会话: ' + sessionId);
}

console.log('');
console.log('等待调试界面输入...');

while (true) {
  const input = await userInput.getUserInput('请输入: ');
  if (!input) {
    continue;
  }

  if (input === '/exit') {
    console.log('[ProtoClaw Launcher] 收到退出指令，正在关闭...');
    break;
  }

  try {
    await agent.onCall(input);
    await agent.saveSession(sessionId);
  } catch (error) {
    console.error('[ProtoClaw Launcher] Agent 调用失败:', error);
  }
}

await agent.dispose();
