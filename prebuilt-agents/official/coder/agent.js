/**
 * 自动化编码智能体（coder）— 自主编码智能体
 *
 * 装配以编程小助手（programming-helper）为执行能力底座，但按「无人值守、
 * 任务精准、直接执行完」的自主场景裁剪：
 * - 保留执行类工具链（todo / force-continuation / audit / websearch /
 *   memory / shell / image-reader / lsp / context-guard / github），
 *   与线程接力（context-guard）机制协同。
 * - 增挂 tickets-build-flow（拿到指令之后的 implement / tdd / code-review
 *   构建流程规范），与线程看板衔接（thread-board）。
 * - 相对编程小助手的裁剪：
 *   - ClawDispatchFeature（server 侧调度桥）与 GroupChatBridgeFeature
 *     （群聊桥）不挂载——本工作空间以线程为执行承接单位。
 *   - UserInputFeature / GenerativeUISurfaceFeature / AudioFeedbackFeature
 *     不挂载——这些是面向「人类在面板输入 / 点击 / 听语音」的交互式
 *     feature；自主运行无人值守时，前两者会永久 pending 卡住线程，后者
 *     无意义。
 *   - 子代理（SubAgentFeature）工具与 Explore 探索分支不挂载——coder 是
 *     单一自主执行体，不派生子代理，explore.md 已删除。
 *
 * 与工作线程（thread-control）的关系：
 * - agent 本身不感知线程；会话创建/trim/摘要的线程接线由 Claw server 侧
 *   （server/thread-control/thread-integration.js）在会话生命周期钩子上
 *   完成，runtime 只按普通会话运行。
 */

import { BasicAgent, TemplateComposer, LspFeature, OutputGuardFeature } from 'agentdev';
import { ControlledTodoFeature, ContinuityAwareOpencodeBasic } from '../../../local-features/dist/feature-wrappers/src/index.js';
import { ForceContinuation } from '../../../features/force-continuation/dist/index.js';
import { TicketsBuildFlow } from '../../../features/tickets-build-flow/dist/index.js';
import { AuditFeature } from '@agentdev/audit-feature';
import { MemoryFeature } from '@agentdev/memory-feature';
import { ShellFeature } from '@agentdev/shell-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { ImageReaderFeature } from '@agentdev/image-reader-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { ContextGuardFeature } from '../../../local-features/dist/context-guard/src/index.js';
import { GitHubFeature } from '../../../local-features/dist/github/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
const IMAGE_STORAGE_DIR = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'images');
const SYSTEM_FEATURE_CONFIG_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'feature-setup.json');

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

/**
 * 自动化编码智能体（coder）Agent
 */
export class CoderAgent extends BasicAgent {
  constructor(config = {}) {
    const workspaceDir = config.workspaceDir || process.cwd();
    const runtime = config.runtime && typeof config.runtime === 'object' ? config.runtime : {};
    const systemConfig = readSystemFeatureConfig();

    // 不挂载 MCP feature：mcp_* 工具会占据 tools 数组头部，把 read/ls 等
    // 核心工具挤到 14 位之后——Lite 级小模型对此敏感，实测会退化为只输出计划
    // 文本而不发起工具调用。线程执行依赖的是内置工具链，不需要外部 MCP 接入。
    super({
      ...config,
      features: {
        ...(config.features || {}),
        ...systemConfig,
      },
      skillConfig: systemConfig.skill || undefined,
      mcpServer: false,
    });

    // 移除 BasicAgent 自动挂载的 SubAgentFeature 工具
    const tools = this.getTools();
    tools.remove('spawn_agent');
    tools.remove('send_to_agent');
    tools.remove('wait');

    // 替换 BasicAgent 默认挂载的 OpencodeBasicFeature 为带 Claw continuity 声明的包装版。
    // 这样包装类会让 readFiles 状态在 trim/summary 时随 continuity 协议转移到新 runtime，
    // 避免精简后会话内"先读后写"保护重置导致 write 工具被错误拦截。
    this.use(new ContinuityAwareOpencodeBasic({ workspaceDir }));

    const runtimeIdentity = {
      agentId: runtime.agentId || process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'coder',
      sessionId: runtime.sessionId ?? process.env.PROTOCLAW_PREBUILT_SESSION_ID ?? '',
      serverOrigin: runtime.serverOrigin || process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420',
    };
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
    this.use(new OutputGuardFeature({ workdir: workspaceDir }));

    this.use(new ControlledTodoFeature({
      reminderTemplate: TODO_REMINDER_PROMPT_PATH,
      reminderThresholdWithTasks: config.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
    }));
    this.use(new ForceContinuation({
      ...(systemConfig['force-continuation'] && typeof systemConfig['force-continuation'] === 'object'
        ? systemConfig['force-continuation'] : {}),
      ...(config.features?.['force-continuation'] && typeof config.features['force-continuation'] === 'object'
        ? config.features['force-continuation'] : {}),
    }));

    // 「拿到指令之后」的构建流程规范：implement / tdd / code-review 三个
    // 自带 skill（经 SkillFeature 自动发现注入）+ 便携读取工具。
    this.use(new TicketsBuildFlow());

    this.use(new AuditFeature());
    this.use(new WebSearchFeature());
    this.use(new MemoryFeature({ workspaceDir }));
    this.use(new ShellFeature({ workspaceDir }));
    this.use(new ImageReaderFeature({ workspaceDir, storageDir: IMAGE_STORAGE_DIR }));

    this.use(new LspFeature({ workdir: workspaceDir }));

    this.use(new GitHubFeature());
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);

    const composer = new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH });

    composer
      .add('\n\n## 技能（Skills）\n\n')
      .add('当用户要求你执行任务时，检查是否有任何可用的技能匹配。技能提供专门的能力和领域知识。你拥有如下技能，可使用 invoke_skill 工具激活，以展开技能的详细介绍。\n')
      .add({ skills: '- **{{name}}**: {{description}}' });

    this.setSystemPrompt(composer);
  }
}
