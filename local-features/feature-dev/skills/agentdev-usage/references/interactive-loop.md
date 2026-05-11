# 交互循环完整示例

本文档展示如何构建带有回滚功能的完整交互循环。

## 基础交互循环

```typescript
import { BasicAgent, UserInputFeature } from 'agentdev';

async function main() {
  const agent = new BasicAgent({
    name: '助手',
    systemMessage: '你是一个友好的助手。',
  });

  const userInput = new UserInputFeature();
  agent.use(userInput);

  await agent.withViewer('助手', 2026, true);

  while (true) {
    const input = await userInput.getUserInput('请输入（输入 exit 退出）：');
    if (input === 'exit' || !input) break;

    const result = await agent.onCall(input);
    console.log(`结果: ${result}`);
  }

  await agent.dispose();
}

main().catch(console.error);
```

## 带会话保存的交互循环

```typescript
import { BasicAgent, UserInputFeature, FileSessionStore } from 'agentdev';

const SESSION_ID = 'my-session';

async function main() {
  const agent = new BasicAgent();
  const userInput = new UserInputFeature();
  const sessionStore = new FileSessionStore();

  agent.use(userInput);
  await agent.withViewer('助手', 2026, true);

  // 尝试恢复会话
  try {
    await agent.loadSession(SESSION_ID, sessionStore);
    console.log('已恢复上次会话');
  } catch {
    console.log('新会话启动');
  }

  while (true) {
    const input = await userInput.getUserInput('请输入（输入 exit 退出）：');
    if (input === 'exit' || !input) break;

    const result = await agent.onCall(input);

    // 每轮对话后保存
    await agent.saveSession(SESSION_ID, sessionStore);
    console.log(`结果: ${result}`);
  }

  // 退出前最终保存
  await agent.saveSession(SESSION_ID, sessionStore);
  await agent.dispose();
}

main().catch(console.error);
```

## 带回滚功能的交互循环

```typescript
import { BasicAgent, UserInputFeature, FileSessionStore } from 'agentdev';

const SESSION_ID = 'my-session';

async function main() {
  const agent = new BasicAgent();
  const userInput = new UserInputFeature();
  const sessionStore = new FileSessionStore();

  agent.use(userInput);
  await agent.withViewer('助手', 2026, true);

  // 尝试恢复会话
  try {
    await agent.loadSession(SESSION_ID, sessionStore);
  } catch {
    console.log('新会话启动');
  }

  while (true) {
    // 带动作按钮的用户输入
    const event = await userInput.getUserInputEvent(
      '请输入（输入 exit 退出）：',
      undefined,
      [
        { actionId: 'rollback_to_call', label: '回滚到指定轮次' },
      ]
    );

    // 处理动作
    if (event.kind === 'action') {
      if (event.actionId === 'rollback_to_call') {
        const targetCallIndex = Number(event.payload?.callIndex);
        const rollback = await agent.rollbackToCall(targetCallIndex);

        // 设置回滚后的草稿输入
        userInput.setNextDraftInput(rollback.draftInput);
        await agent.saveSession(SESSION_ID, sessionStore);

        console.log(`已回滚到第 ${targetCallIndex + 1} 轮`);
        continue;
      }

      console.log(`忽略未知动作: ${event.actionId}`);
      continue;
    }

    // 处理文本输入
    const input = event.text ?? '';
    if (input === 'exit' || !input) break;

    console.log(`\n[助手] > ${input}\n---`);
    const result = await agent.onCall(input);

    await agent.saveSession(SESSION_ID, sessionStore);
    console.log(`结果: ${result}\n`);
  }

  await agent.saveSession(SESSION_ID, sessionStore);
  await agent.dispose();
}

main().catch(console.error);
```

## 完整的编程助手示例

基于 `D:\code\AgentDevExample\examples\agent.ts` 和 `ProgrammingHelperAgent.ts`：

```typescript
import { BasicAgent, UserInputFeature, FileSessionStore } from 'agentdev';
import { TemplateComposer } from 'agentdev';

// 自定义 Agent 类
class ProgrammingHelperAgent extends BasicAgent {
  constructor() {
    super({
      name: '编程小助手',
      systemMessage: '你是一个专业的编程助手。',
    });
  }

  protected override async onInitiate(ctx) {
    await super.onInitiate(ctx);

    // 使用模板系统配置提示词
    this.setSystemPrompt(new TemplateComposer()
      .add({ file: '.agentdev/prompts/system.md' })
      .add('\n\n## 身份设定\n\n')
      .add('你是一个专业的编程助手，擅长代码编写、调试和优化。')
    );
  }
}

// 主程序
const SESSION_ID = 'programming-helper-last';
const shouldResumeSession = process.env.AGENTDEV_RESUME_SESSION === '1';

async function main() {
  const agent = new ProgrammingHelperAgent();
  const userInput = new UserInputFeature();
  const sessionStore = new FileSessionStore();

  agent.use(userInput);

  if (shouldResumeSession) {
    try {
      await agent.loadSession(SESSION_ID, sessionStore);
      const restoredMessages = agent.getContext().getAll().length;
      console.log(`已恢复上次会话: ${SESSION_ID}，当前消息数: ${restoredMessages}`);
    } catch (error) {
      console.log(`未找到可恢复会话，改为新会话启动: ${error.message}`);
    }
  }

  await agent.withViewer('编程小助手', 2026, true);
  console.log(`调试页面: http://localhost:2026\n`);

  while (true) {
    const event = await userInput.getUserInputEvent(
      '请输入您的需求（输入 exit 退出）：',
      undefined,
      [
        { actionId: 'rollback_to_call', label: '回滚到指定轮次' },
      ]
    );

    if (event.kind === 'action') {
      if (event.actionId === 'rollback_to_call') {
        const targetCallIndex = Number(event.payload?.callIndex);
        const draftInput = typeof event.payload?.draftInput === 'string'
          ? event.payload.draftInput
          : '';
        const rollback = await agent.rollbackToCall(targetCallIndex);
        userInput.setNextDraftInput(draftInput || rollback.draftInput);
        await agent.saveSession(SESSION_ID, sessionStore);
        console.log(`已回滚到第 ${targetCallIndex + 1} 轮输入，等待重新编辑`);
        continue;
      }

      console.log(`忽略未知输入动作: ${event.actionId ?? 'unknown'}`);
      continue;
    }

    const input = event.text ?? '';
    if (input === 'exit' || !input) break;

    console.log(`\n[编程小助手] > ${input}\n---`);
    const result = await agent.onCall(input);
    await agent.saveSession(SESSION_ID, sessionStore);
    console.log(`结果: ${result}\n`);
  }

  await agent.saveSession(SESSION_ID, sessionStore);
  await agent.dispose();
  console.log('[Lifecycle] 程序退出');
}

main().catch(console.error);
```

## UserInputEvent 类型说明

```typescript
type UserInputResponse =
  | { kind: 'text'; text: string }
  | { kind: 'action'; actionId: string; payload?: unknown };

type UserInputAction = {
  actionId: string;
  label: string;
  payload?: unknown;
};
```

## 环境变量控制

```bash
# 启用会话恢复
AGENTDEV_RESUME_SESSION=1 npm run dev

# 使用指定配置文件
AGENTDEV_CONFIG=production npm run dev
```
