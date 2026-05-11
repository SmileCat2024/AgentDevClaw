# 自定义 Agent 类

本文档展示如何继承 BasicAgent 创建自定义 Agent 类。

## 基础自定义 Agent

```typescript
import { BasicAgent } from 'agentdev';
import type { BasicAgentConfig, AgentInitiateContext } from 'agentdev';

export class MyAgent extends BasicAgent {
  constructor(config: BasicAgentConfig = {}) {
    super(config);

    // 注册自定义 Feature
    // this.use(new MyFeature());
  }

  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    await super.onInitiate(ctx);

    // 自定义初始化逻辑
    // - 配置系统提示词
    // - 注入上下文
    // - 初始化资源
  }
}
```

## 带配置的自定义 Agent

```typescript
import { BasicAgent, TodoFeature } from 'agentdev';
import type { BasicAgentConfig, AgentInitiateContext } from 'agentdev';

interface MyAgentConfig extends BasicAgentConfig {
  /** Agent 显示名称 */
  name?: string;
  /** 提醒阈值 */
  reminderThreshold?: number;
  /** MCP 服务器 */
  mcpServer?: string | false;
}

export class MyAgent extends BasicAgent {
  constructor(config: MyAgentConfig = {}) {
    super(config);

    // 使用自定义配置
    this.use(new TodoFeature({
      reminderThreshold: config.reminderThreshold,
    }));
  }

  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    await super.onInitiate(ctx);

    // 根据配置定制行为
    const config = this.getConstructorArgs() as MyAgentConfig;
    if (config.name) {
      // 使用 name 做些什么...
    }
  }
}
```

## 使用模板系统配置提示词

```typescript
import { BasicAgent, TemplateComposer } from 'agentdev';
import type { AgentInitiateContext } from 'agentdev';

export class MyAgent extends BasicAgent {
  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    await super.onInitiate(ctx);

    this.setSystemPrompt(new TemplateComposer()
      .add({ file: '.agentdev/prompts/system.md' })
      .add('\n\n## 身份设定\n\n')
      .add('你是一个...')
      .add('\n\n## 技能\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。')
      .add({ skills: '- **{{name}}**: {{description}}' })
    );
  }
}
```

## 编程助手示例

完整示例参考：`D:\code\AgentDevExample\examples\ProgrammingHelperAgent.ts`

```typescript
import { BasicAgent, TodoFeature, TemplateComposer } from 'agentdev';
import type { BasicAgentConfig, AgentInitiateContext } from 'agentdev';

export interface ProgrammingHelperAgentConfig extends BasicAgentConfig {
  name?: string;
  mcpServer?: string | false;
  reminderThresholdWithTasks?: number;
  reminderThresholdWithoutTasks?: number;
}

export class ProgrammingHelperAgent extends BasicAgent {
  constructor(config?: ProgrammingHelperAgentConfig) {
    super(config);

    this.use(new TodoFeature({
      reminderTemplate: '.agentdev/prompts/reminder-update-todo.md',
      reminderThresholdWithTasks: config?.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config?.reminderThresholdWithoutTasks,
    }));
  }

  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    await super.onInitiate(ctx);

    this.setSystemPrompt(new TemplateComposer()
      .add({ file: '.agentdev/prompts/system.md' })
      .add('\n\n## 身份设定\n\n')
      .add('你是一个专业的编程助手，擅长代码编写、调试和优化。')
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。')
      .add({ skills: '- **{{name}}**: {{description}}' })
    );
  }
}
```

## 覆盖系统上下文

```typescript
import { BasicAgent } from 'agentdev';
import type { SystemContext } from 'agentdev';

export class MyAgent extends BasicAgent {
  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    await super.onInitiate(ctx);

    // 获取并修改系统上下文
    const systemContext = this.getSystemContext() as SystemContext;

    // 添加自定义上下文
    this.setSystemContext({
      ...systemContext,
      CUSTOM_VAR: 'custom-value',
    });
  }
}
```

## 在 onInitiate 中初始化资源

```typescript
import { BasicAgent } from 'agentdev';
import type { AgentInitiateContext, FeatureContext } from 'agentdev';

export class MyAgent extends BasicAgent {
  private resource?: any;

  protected override async onInitiate(ctx: AgentInitiateContext): Promise<void> {
    await super.onInitiate(ctx);

    // 初始化外部资源
    // this.resource = await createResource();
  }

  protected override async onDestroy(ctx: FeatureContext): Promise<void> {
    // 清理资源
    // if (this.resource) {
    //   await this.resource.dispose();
    // }

    await super.onDestroy(ctx);
  }
}
```

## 使用自定义 Agent

```typescript
import { ProgrammingHelperAgent } from './ProgrammingHelperAgent.js';
import { UserInputFeature, FileSessionStore } from 'agentdev';

async function main() {
  const agent = new ProgrammingHelperAgent({
    name: '编程小助手',
    mcpServer: 'github',
  });

  agent.use(new UserInputFeature());

  await agent.withViewer('编程小助手', 2026, true);
  // ...
}

main().catch(console.error);
```
