/**
 * 编程小助手 Agent - Claw 官方实现
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 基于 ProtoClaw 当前内置的 npm agentdev 兼容层运行
 */

import { BasicAgent, TemplateComposer, UserInputFeature, LspFeature, OutputGuardFeature } from 'agentdev';
import { ControlledTodoFeature } from './controlled-todo-feature.js';
import { ContinuityAwareOpencodeBasic } from './continuity-aware-opencode-basic.js';
import { AudioFeedbackFeature } from '@agentdev/audio-feedback-feature';
import { AuditFeature } from '@agentdev/audit-feature';
import { MemoryFeature } from '@agentdev/memory-feature';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { ImageReaderFeature } from '@agentdev/image-reader-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { ClawDispatchFeature } from '../../../local-features/dist/dispatch/src/index.js';
import { GroupChatBridgeFeature } from '../../../local-features/dist/group-admin/src/bridge.js';
import { ContextGuardFeature } from '../../../local-features/dist/context-guard/src/index.js';
import { GenerativeUISurfaceFeature } from '../../../local-features/dist/generative-ui/src/index.js';
import { GitHubFeature } from '../../../local-features/dist/github/src/index.js';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const EXPLORE_PROMPT_PATH = join(PROMPTS_DIR, 'explore.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const WORKSPACE_STATE_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'programming-helper', 'state.json');
const IMAGE_STORAGE_DIR = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'images');
const SYSTEM_FEATURE_CONFIG_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'feature-setup.json');
const EXCLUDED_MCP_SERVERS_EXPLORE = ['crawl4ai-official'];

// Audio feedback is presentation-only. Awaiting the OS media process inside
// @CallFinish delays AgentDev's authoritative call.finish event and therefore
// extends the visible interrupting interval. Keep the inherited hook metadata,
// but let playback finish in the background.
class NonBlockingAudioFeedbackFeature extends AudioFeedbackFeature {
  async playAudioOnCallFinish(ctx) {
    void super.playAudioOnCallFinish(ctx).catch((error) => {
      console.warn('[ProgrammingHelper] audio feedback failed:', error);
    });
  }
}

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readSystemFeatureConfig() {
  if (!existsSync(SYSTEM_FEATURE_CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(SYSTEM_FEATURE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const config = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    // Backward compat: migrate top-level runtimes into lsp.runtimes
    if (config.runtimes && typeof config.runtimes === 'object') {
      config.lsp = { ...(config.lsp || {}), runtimes: config.runtimes };
      delete config.runtimes;
    }
    return config;
  } catch {
    return {};
  }
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
    const runtime = config.runtime && typeof config.runtime === 'object' ? config.runtime : {};
    const isExploration = runtime.sessionType === 'exploration' || process.env.PROTOCLAW_SESSION_TYPE === 'exploration';
    const systemConfig = readSystemFeatureConfig();

    super({
      ...config,
      features: {
        ...(config.features || {}),
        ...systemConfig,
      },
      skillConfig: systemConfig.skill || undefined,
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

    // 替换 BasicAgent 默认挂载的 OpencodeBasicFeature 为带 Claw continuity 声明的包装版。
    // OpencodeBasicFeature 在 BasicAgent constructor 里通过 this.use() 挂载，还未 onInitiate，
    // 也未注册工具/钩子/注入器（其工具注册发生在首次 onCall 的 ensureFeatureTools），
    // 因此直接 use 覆盖同名 feature 即可，无需 removeFeature。
    // 这样包装类会让 readFiles 状态在 trim/summary 时随 continuity 协议转移到新 runtime，
    // 避免精简后会话内"先读后写"保护重置导致 write 工具被错误拦截。
    this.use(new ContinuityAwareOpencodeBasic({ workspaceDir }));

    const runtimeIdentity = {
      agentId: runtime.agentId || process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'programming-helper',
      sessionId: runtime.sessionId ?? process.env.PROTOCLAW_PREBUILT_SESSION_ID ?? '',
      serverOrigin: runtime.serverOrigin || process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420',
    };
    this.use(new ClawDispatchFeature(runtimeIdentity));
    this.use(new GroupChatBridgeFeature(runtimeIdentity));
    this.contextGuard = new ContextGuardFeature({
      ...(systemConfig.contextGuard && typeof systemConfig.contextGuard === 'object'
        ? systemConfig.contextGuard : {}),
      ...(config.contextGuard && typeof config.contextGuard === 'object'
        ? config.contextGuard : {}),
      agentId: runtimeIdentity.agentId,
      sessionId: runtimeIdentity.sessionId,
      serverOrigin: runtimeIdentity.serverOrigin,
    });
    this.use(this.contextGuard);

    // 工具输出安全网：截断超限的工具结果，防止上下文溢出。
    // 放在所有业务 feature 之前挂载，确保 ToolResultTransform 钩子
    // 在 feature 注册顺序中靠前（但执行顺序由 hooks registry 决定）。
    this.use(new OutputGuardFeature({ workdir: workspaceDir }));

    if (isExploration) {
      this.use(new ShellFeature({ workspaceDir }));
      this.use(new WebSearchFeature());
      this.use(new MemoryFeature({ workspaceDir }));
      this.use(new ImageReaderFeature({ workspaceDir, storageDir: IMAGE_STORAGE_DIR }));
      this.use(new GitHubFeature());
    } else {
      this.use(new ControlledTodoFeature({
        reminderTemplate: TODO_REMINDER_PROMPT_PATH,
        reminderThresholdWithTasks: config.reminderThresholdWithTasks,
        reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
      }));

      this.use(new AuditFeature());
      this.use(new NonBlockingAudioFeedbackFeature());
      this.use(new WebSearchFeature());
      this.use(new MemoryFeature({ workspaceDir }));
      this.use(new ShellFeature({ workspaceDir }));
      this.use(new ImageReaderFeature({ workspaceDir, storageDir: IMAGE_STORAGE_DIR }));

      this.use(new LspFeature({ workdir: workspaceDir }));

      this.use(new UserInputFeature());
      this.use(new GenerativeUISurfaceFeature());
      this.use(new GitHubFeature());
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
