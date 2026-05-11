/**
 * 编程小助手 Agent - Claw 官方实现
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 基于 ProtoClaw 当前内置的 npm agentdev 兼容层运行
 */

import { BasicAgent, TemplateComposer, TodoFeature, UserInputFeature } from 'agentdev';
import { AudioFeedbackFeature } from '@agentdev/audio-feedback-feature';
import { AuditFeature } from '@agentdev/audit-feature';
import { MemoryFeature } from '@agentdev/memory-feature';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const WORKSPACE_STATE_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'programming-helper', 'state.json');

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readProgrammingWorkspaceState() {
  if (!existsSync(WORKSPACE_STATE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(WORKSPACE_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 编程小助手 Agent
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 继承 BasicAgent 获得所有基础设施能力
 */
export class ProgrammingHelperAgent extends BasicAgent {
  constructor(config = {}) {
    super({
      ...config,
      excludeMcpServers: Array.from(new Set([
        ...(config.excludeMcpServers ?? []),
        ...DEFAULT_EXCLUDED_MCP_SERVERS,
      ])),
    });

    // 挂载集合对齐 AgentDev examples/ProgrammingHelperAgent.ts。
    this.use(new TodoFeature({
      reminderTemplate: TODO_REMINDER_PROMPT_PATH,
      reminderThresholdWithTasks: config.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
    }));

    this.use(new AuditFeature());
    this.use(new AudioFeedbackFeature({
      enabled: true,
      volume: 0.5,
    }));
    this.use(new WebSearchFeature());
    this.use(new MemoryFeature());
    this.use(new ShellFeature());

    // 保留 UserInputFeature 以兼容当前 ProtoClaw 预置 agent 运行时。
    this.use(new UserInputFeature());
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);
    const workspaceState = readProgrammingWorkspaceState();
    const startupForm = workspaceState?.forms?.['startup-form'] || {};
    const taskType = cleanValue(startupForm.task_type);
    const taskTitle = cleanValue(startupForm.task_title);
    const goal = cleanValue(startupForm.goal);
    const workdir = cleanValue(startupForm.workdir);
    const targetFiles = cleanValue(startupForm.target_files);
    const expectedOutput = cleanValue(startupForm.expected_output);
    const constraints = cleanValue(startupForm.constraints);
    const referenceMaterials = cleanValue(startupForm.reference_materials);

    // 配置专门的编程助手提示词
    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\n\n## 身份设定\n\n')
      .add('你是一个专业的编程助手，擅长代码编写、调试和优化。')
      .add('\n\n## 当前工作台语义\n\n')
      .add('你当前运行在一个面向真实编程任务的工作空间中，不是泛泛的闲聊助手。')
      .add('\n你的目标是围绕当前任务持续推进分析、实现、排障、重构和验证。')
      .add('\n如果用户给出的信息足够明确，优先直接推进；如果信息不足，再围绕当前任务最关键的缺口发问。')
      .add('\n\n## 当前任务简报\n\n')
      .add(taskType ? `任务类型：${taskType}\n` : '')
      .add(taskTitle ? `任务标题：${taskTitle}\n` : '')
      .add(goal ? `任务目标：${goal}\n` : '')
      .add(workdir ? `工作目录：\`${workdir}\`\n` : '')
      .add(targetFiles ? `重点文件/模块：${targetFiles}\n` : '')
      .add(expectedOutput ? `期望产出：${expectedOutput}\n` : '')
      .add(constraints ? `限制条件：${constraints}\n` : '')
      .add(referenceMaterials ? `参考资料：${referenceMaterials}\n` : '')
      .add(workdir ? '\n默认把当前工作目录视为主要读写与排查范围。' : '\n当前尚未给定明确工作目录，如有必要请先帮助用户收敛目录或项目范围。')
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你拥有如下技能，可使用 invoke_skill 工具激活，以展开技能的详细介绍。\n')
      .add({ skills: '- **{{name}}**: {{description}}' })
      .add('\n\n## MCP 工具\n\n')
      .add('除了标准工具外，你还可以使用通过 MCP (Model Context Protocol) 接入的外部工具。默认自动挂载的工具通常以 `mcp_` 开头，而业务功能内部封装的工具可能使用业务前缀命名。\n')
      .add('\n\n## 视觉理解能力\n\n')
      .add('你可以使用 `capture_and_understand_window` 工具来截取指定窗口的截图，并使用视觉模型理解其内容。')
      .add('这个功能可以帮助你：')
      .add('\n- 查看和分析当前打开的窗口内容')
      .add('- 理解用户界面的状态和布局')
      .add('- 获取应用窗口的视觉信息')
      .add('\n\n## WebSearch 能力\n\n')
      .add('你可以使用 `web_fetch` 获取网页原始内容。')
      .add('如果内置 crawl4ai 服务可用，还可以使用以 `websearch_crawl4ai_` 开头的工具执行更强的网页抓取与提取。')
      .add('\n\n每次对话开始时，你会自动收到当前系统窗口状态的摘要信息。')
    );
  }
}
