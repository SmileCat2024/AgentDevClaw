/**
 * QQBot 编程小助手 Agent - Claw 官方实现
 *
 * 专业的编程助手，通过 QQ 与用户交互
 * 当前先作为 ProtoClaw 内置预置 agent 展示，运行时仍基于 npm agentdev
 */

import { BasicAgent, TemplateComposer, TodoFeature, UserInputFeature } from 'agentdev';
import { AuditFeature } from '@agentdev/audit-feature';
import { QQBotFeature } from '@agentdev/qqbot-feature';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const PROTOCLAW_ROOT = join(__dirname, '..', '..', '..');
const DEFAULT_QQBOT_CONFIG_CANDIDATES = [
  join(PROTOCLAW_ROOT, '.agentdev', 'qqbot.config.json'),
  join(PROTOCLAW_ROOT, '..', 'AgentDev', 'config', 'qqbot.config.json'),
];

function resolveQQBotConfigPath(explicitPath) {
  if (explicitPath) {
    return explicitPath;
  }

  return DEFAULT_QQBOT_CONFIG_CANDIDATES.find(path => existsSync(path));
}

/**
 * QQBot 编程小助手 Agent
 *
 * 专业的编程助手，通过 QQ 与用户交互
 * 继承 BasicAgent 获得所有基础设施能力
 */
export class QQBotProgrammingHelperAgent extends BasicAgent {
  qqbotFeature;

  constructor(config = {}) {
    super({
      ...config,
      excludeMcpServers: Array.from(new Set([
        ...(config.excludeMcpServers ?? []),
        ...DEFAULT_EXCLUDED_MCP_SERVERS,
      ])),
    });

    this.qqbotFeature = new QQBotFeature({
      appId: config.appId,
      clientSecret: config.clientSecret,
      configPath: resolveQQBotConfigPath(config.qqbotConfigPath),
      accountId: config.accountId,
      markdownSupport: config.markdownSupport,
    });
    this.use(this.qqbotFeature);

    this.use(new TodoFeature({
      reminderTemplate: TODO_REMINDER_PROMPT_PATH,
      reminderThresholdWithTasks: config.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
    }));

    this.use(new AuditFeature());
    this.use(new WebSearchFeature());
    this.use(new ShellFeature());
    this.use(new UserInputFeature());
  }

  async startQQBotGateway() {
    await this.qqbotFeature.startGateway(this);
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);

    // 配置专门的编程助手提示词
    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\n\n## 身份设定\n\n')
      .add('你是一个专业的编程助手，擅长代码编写、调试和优化。通过 QQ 与用户交流。')
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你拥有如下技能，可使用 invoke_skill 工具激活，以展开技能的详细介绍。\n')
      .add({ skills: '- **{{name}}**: {{description}}' })
      .add('\n\n## MCP 工具\n\n')
      .add('除了标准工具外，你还可以使用通过 MCP (Model Context Protocol) 接入的外部工具。默认自动挂载的工具通常以 `mcp_` 开头，而业务功能内部封装的工具可能使用业务前缀命名。\n')
      .add('\n\n## WebSearch 能力\n\n')
      .add('你可以使用 `web_fetch` 获取网页原始内容。')
      .add('如果内置 crawl4ai 服务可用，还可以使用以 `websearch_crawl4ai_` 开头的工具执行更强的网页抓取与提取。')
      .add('\n\n每次对话开始时，你会自动收到当前系统窗口状态的摘要信息。')
    );
  }
}
