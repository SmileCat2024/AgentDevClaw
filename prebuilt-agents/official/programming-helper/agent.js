/**
 * 编程小助手 Agent - Claw 官方实现
 *
 * 专业的编程助手，擅长代码编写、调试和优化
 * 基于 ProtoClaw 当前内置的 npm agentdev 兼容层运行
 */

import { BasicAgent, TemplateComposer, UserInputFeature, LspFeature, OutputGuardFeature, SkillFeature, resolveFeatureConfig } from '@agentdevjs/core';
import { MCPFeature } from '@agentdevjs/mcp';
import { ControlledTodoFeature, ContinuityAwareOpencodeBasic } from '../../../local-features/dist/feature-wrappers/src/index.js';
import { ForceContinuation } from '../../../features/force-continuation/dist/index.js';
import { StepRotatingModel } from '../../../features/step-rotating-model/dist/index.js';
import { AudioFeedbackFeature } from '@agentdevjs/audio-feedback-feature';
import { AuditFeature } from '@agentdevjs/audit-feature';
import { MemoryFeature } from '@agentdevjs/memory-feature';
import { ShellFeature } from '@agentdevjs/shell-feature';
import { WebSearchFeature } from '@agentdevjs/websearch-feature';
import { ImageReaderFeature } from '@agentdevjs/image-reader-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { ClawDispatchFeature } from '../../../local-features/dist/dispatch/src/index.js';
import { GroupChatBridgeFeature } from '../../../local-features/dist/group-admin/src/bridge.js';
import { ContextGuardFeature } from '../../../local-features/dist/context-guard/src/index.js';
import { GenerativeUISurfaceFeature } from '../../../local-features/dist/generative-ui/src/index.js';
import { GitHubFeature } from '../../../local-features/dist/github/src/index.js';
import {
  readGlobalLayer,
  readAgentLayer,
  readDirLayer,
} from '../../../server/shared/feature-config-layers.js';
import { CoderAgent } from './coder-agent.js';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const WORKSPACE_STATE_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'programming-helper', 'state.json');
const IMAGE_STORAGE_DIR = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'images');

// Audio feedback is presentation-only. Awaiting the OS media process inside
// the CallFinish hook delays AgentDev's authoritative call.finish event and
// therefore extends the visible interrupting interval. Keep the inherited
// static hooks declarations, but let playback finish in the background.
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

    // 配置队列（ticket 00/03）：[全局层, agent 层, 目录层(构造时 cwd), 会话注入]。
    // 队列在构造函数内组装——同进程多 session 可能对应不同 cwd，禁止进程级缓存。
    // 会话注入（featureOverrides）不落盘。
    const queue = [
      readGlobalLayer(),
      readAgentLayer(),
      readDirLayer(workspaceDir),
      runtime.config && typeof runtime.config === 'object' ? (runtime.config.featureOverrides || {}) : {},
    ];
    const { merged } = resolveFeatureConfig(queue);

    const excludeMcpServers = Array.from(new Set([
      ...(config.excludeMcpServers ?? []),
      ...DEFAULT_EXCLUDED_MCP_SERVERS,
    ]));

    super({
      ...config,
      features: merged,
    });

    // BasicAgent 已纯基类化（框架 a5fe117 / ticket 009），不再内置装配任何 feature。
    // 原由 BasicAgent 挂载的 MCP/Skill/SubAgent/OpencodeBasic 等，现在装配权在宿主：
    // - SubAgentFeature 本 agent 明确不启用，不再挂载；
    // - MCP / Skill / OpencodeBasic 在此显式补装，恢复被框架移除的能力。

    // MCPFeature：连接 Claw 共享 MCP 网关 + 扫描 .agentdev/mcps，排除 crawl4ai 等系统 server。
    this.use(new MCPFeature(undefined, { excludeServers: excludeMcpServers }));

    // SkillFeature：invoke_skill 工具 + skills 上下文注入，默认扫描 workspaceDir/.agentdev/skills。
    // feature-setup.json 中的 skill 配置（scanAgentdevDir/scanClaudeDir/extraDirs 等）会覆盖默认值。
    const skillConfig = merged.skill && typeof merged.skill === 'object' ? merged.skill : undefined;
    this.use(new SkillFeature(skillConfig));

    // 替换原 BasicAgent 默认挂载的 OpencodeBasicFeature 为带 Claw continuity 声明的包装版。
    // OpencodeBasicFeature 尚未 onInitiate，也未注册工具/钩子/注入器（其工具注册发生在首次
    // onCall 的 ensureFeatureTools），因此直接 use 覆盖同名 feature 即可，无需 removeFeature。
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
    // 一次性过界拦截：manifest（Runtime 配置面板）决定会话启动初值，
    // 会话控制面板可实时装填/卸下。触发一次即消耗，之后输入完全放行。
    this.use(new ContextGuardFeature({
      ...(merged['context-guard'] && typeof merged['context-guard'] === 'object'
        ? merged['context-guard'] : {}),
      ...(config.contextGuard && typeof config.contextGuard === 'object'
        ? config.contextGuard : {}),
    }));

    // 工具输出安全网：截断超限的工具结果，防止上下文溢出。
    // 放在所有业务 feature 之前挂载，确保 ToolResultTransform 钩子
    // 在 feature 注册顺序中靠前（但执行顺序由 hooks registry 决定）。
    this.use(new OutputGuardFeature({ workdir: workspaceDir }));

    this.use(new ControlledTodoFeature({
      reminderTemplate: TODO_REMINDER_PROMPT_PATH,
      reminderThresholdWithTasks: config.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
    }));
    this.use(new ForceContinuation({
      ...(merged['force-continuation'] && typeof merged['force-continuation'] === 'object'
        ? merged['force-continuation'] : {}),
      ...(config.features?.['force-continuation'] && typeof config.features['force-continuation'] === 'object'
        ? config.features['force-continuation'] : {}),
    }));

    this.use(new StepRotatingModel({
      ...(merged['step-rotating-model'] && typeof merged['step-rotating-model'] === 'object'
        ? merged['step-rotating-model'] : {}),
      ...(config.features?.['step-rotating-model'] && typeof config.features['step-rotating-model'] === 'object'
        ? config.features['step-rotating-model'] : {}),
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

  async onInitiate(ctx) {
    await super.onInitiate(ctx);

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

/**
 * 按会话类型分派 Agent 类。run-prebuilt-agent.js 优先调用本函数；
 * sessionType='coder' 的会话装配为自主编码身份（线程宿主），其余为主身份。
 */
export function resolveAgentClass({ runtime } = {}) {
  return runtime?.sessionType === 'coder' ? CoderAgent : ProgrammingHelperAgent;
}
