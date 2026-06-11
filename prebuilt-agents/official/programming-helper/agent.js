/**
 * 编程小助手 Agent - Claw 官方实现
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 基于 ProtoClaw 当前内置的 npm agentdev 兼容层运行
 */

import { BasicAgent, TemplateComposer, TodoFeature, UserInputFeature, LspFeature } from 'agentdev';
import { AudioFeedbackFeature } from '@agentdev/audio-feedback-feature';
import { AuditFeature } from '@agentdev/audit-feature';
import { MemoryFeature } from '@agentdev/memory-feature';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { ClawDispatchFeature } from '../../../local-features/dist/dispatch/src/index.js';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const EXPLORE_PROMPT_PATH = join(PROMPTS_DIR, 'explore.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const WORKSPACE_STATE_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'programming-helper', 'state.json');
const SYSTEM_FEATURE_CONFIG_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'feature-setup.json');
const EXCLUDED_MCP_SERVERS_EXPLORE = ['crawl4ai-official'];

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readSystemFeatureConfig() {
  if (!existsSync(SYSTEM_FEATURE_CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(SYSTEM_FEATURE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function extractLspServerConfig(systemConfig) {
  const lspSection = systemConfig?.lsp;
  if (!lspSection || typeof lspSection !== 'object') return {};
  const result = {};
  for (const [serverId, entry] of Object.entries(lspSection)) {
    if (entry && typeof entry === 'object') {
      const serverConfig = {};
      if (typeof entry.mode === 'string') serverConfig.mode = entry.mode;
      if (typeof entry.runtime === 'string') serverConfig.runtime = entry.runtime;
      if (typeof entry.binary === 'string' && entry.binary.trim()) serverConfig.binary = entry.binary.trim();
      if (typeof entry.package === 'string' && entry.package.trim()) serverConfig.package = entry.package.trim();
      if (typeof entry.uvPackage === 'string' && entry.uvPackage.trim()) serverConfig.uvPackage = entry.uvPackage.trim();
      if (typeof entry.args === 'string' && entry.args.trim()) serverConfig.args = entry.args.trim().split(/\s+/);
      if (Object.keys(serverConfig).length) result[serverId] = serverConfig;
    }
  }
  return result;
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
    const workspaceDir = config.workspaceDir || process.cwd();
    const isExploration = process.env.PROTOCLAW_SESSION_TYPE === 'exploration';

    super({
      ...config,
      excludeMcpServers: Array.from(new Set([
        ...(config.excludeMcpServers ?? []),
        ...(isExploration ? EXCLUDED_MCP_SERVERS_EXPLORE : DEFAULT_EXCLUDED_MCP_SERVERS),
      ])),
    });

    this._isExploration = isExploration;

    // 移除 BasicAgent 自动挂载的 SubAgentFeature 工具
    const tools = this.getTools();
    tools.remove('spawn_agent');
    tools.remove('send_to_agent');
    tools.remove('wait');

    this.use(new ClawDispatchFeature());

    if (isExploration) {
      this.use(new ShellFeature({ workspaceDir }));
      this.use(new WebSearchFeature());
      this.use(new MemoryFeature({ workspaceDir }));
    } else {
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
      this.use(new MemoryFeature({ workspaceDir }));
      this.use(new ShellFeature({ workspaceDir }));
      const systemConfig = readSystemFeatureConfig();
      this.use(new LspFeature({
        workdir: workspaceDir,
        runtimes: systemConfig.runtimes || {},
        servers: extractLspServerConfig(systemConfig),
      }));

      this.use(new UserInputFeature());
    }
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);

    if (this._isExploration) {
      const composer = new TemplateComposer()
        .add({ file: EXPLORE_PROMPT_PATH });
      this.setSystemPrompt(composer);
      return;
    }

    const workspaceState = readProgrammingWorkspaceState();
    const openDirectory = cleanValue(workspaceState?.openDirectory);

    const composer = new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH });

    composer
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你拥有如下技能，可使用 invoke_skill 工具激活，以展开技能的详细介绍。\n')
      .add({ skills: '- **{{name}}**: {{description}}' })
      .add('\n\n## MCP 工具\n\n')
      .add('除了标准工具外，你还可以使用通过 MCP (Model Context Protocol) 接入的外部工具。默认自动挂载的工具通常以 `mcp_` 开头，而业务功能内部封装的工具可能使用业务前缀命名。\n');

    this.setSystemPrompt(composer);
  }
}
