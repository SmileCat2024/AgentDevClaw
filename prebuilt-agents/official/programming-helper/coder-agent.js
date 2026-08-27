/**
 * 自动化编码智能体（coder）— 编程小助手工作空间内的自主编码身份
 *
 * 装配以编程小助手（programming-helper）为执行能力底座，但按「无人值守、
 * 任务精准、直接执行完」的自主场景裁剪。coder 不再是独立工作空间：
 * 由编程小助手 agent.js 的 resolveAgentClass 按 sessionType='coder' 分派
 * 到本类，会话数据、线程与配置仍与主身份分离（模型配置读
 * .agentdev/agent-configs/coder.json）。
 *
 * - 保留执行类工具链（todo / force-continuation / websearch /
 *   memory / shell / image-reader / lsp / context-rotation-trigger / github），
 *   与线程接力（context-rotation-trigger）机制协同。
 * - 增挂 tickets-build-flow（拿到指令之后的 implement / tdd / code-review
 *   构建流程规范），与线程看板衔接（thread-board）。
 * - 相对编程小助手主身份的裁剪：
 *   - ClawDispatchFeature（server 侧调度桥）与 GroupChatBridgeFeature
 *     （群聊桥）不挂载——coder 以线程为执行承接单位。
 *   - UserInputFeature / GenerativeUISurfaceFeature / AudioFeedbackFeature
 *     不挂载——这些是面向「人类在面板输入 / 点击 / 听语音」的交互式
 *     feature；自主运行无人值守时，前两者会永久 pending 卡住线程，后者
 *     无意义。
 *
 * 与工作线程（thread-control）的关系：
 * - agent 本身不感知线程；会话创建/trim/摘要的线程接线由 Claw server 侧
 *   （server/thread-control/thread-integration.js）在会话生命周期钩子上
 *   完成，runtime 只按普通会话运行。
 */

import { BasicAgent, TemplateComposer, LspFeature, OutputGuardFeature, SkillFeature, resolveFeatureConfig } from '@agentdevjs/core';
import { ControlledTodoFeature, ContinuityAwareOpencodeBasic } from '../../../local-features/dist/feature-wrappers/src/index.js';
import { ForceContinuation } from '../../../features/force-continuation/dist/index.js';
import { TicketsBuildFlow } from '../../../features/tickets-build-flow/dist/index.js';
import { MemoryFeature } from '@agentdevjs/memory-feature';
import { ShellFeature } from '@agentdevjs/shell-feature';
import { WebSearchFeature } from '@agentdevjs/websearch-feature';
import { ImageReaderFeature } from '@agentdevjs/image-reader-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ContextRotationTriggerFeature } from '../../../local-features/dist/context-guard/src/index.js';
import { GitHubFeature } from '../../../local-features/dist/github/src/index.js';
import {
  readGlobalLayer,
  readLayerFile,
  coderLayerPath,
} from '../../../server/shared/feature-config-layers.js';
import { resolveUserDataDir } from '../../../server/shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts', 'coder');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
// 数据根同源解析（server/shared/constants.js），支持 AGENTDEV_DATA_DIR 多实例隔离
const IMAGE_STORAGE_DIR = join(resolveUserDataDir(), 'images');

/**
 * 自动化编码智能体（coder）Agent
 */
export class CoderAgent extends BasicAgent {
  constructor(config = {}) {
    const workspaceDir = config.workspaceDir || process.cwd();
    const runtime = config.runtime && typeof config.runtime === 'object' ? config.runtime : {};
    // 配置队列：[全局层(feature-setup.json), coder 层(feature-config/coder.json)]。
    // coder 层由工作空间设置的「coder Feature 配置」编辑，覆盖全局层同名项；
    // 队列在构造函数内组装（同进程多 session 场景禁止进程级缓存）。
    const { merged: systemConfig } = resolveFeatureConfig([
      readGlobalLayer(),
      readLayerFile(coderLayerPath()),
    ]);

    // 不挂载 MCP feature：mcp_* 工具会占据 tools 数组头部，把 read/ls 等
    // 核心工具挤到 14 位之后——Lite 级小模型对此敏感，实测会退化为只输出计划
    // 文本而不发起工具调用。线程执行依赖的是内置工具链，不需要外部 MCP 接入。
    // BasicAgent 已纯基类化（a5fe117 / ticket 009），不再内置装配任何 feature，
    // 这里无需再向 super 传 mcpServer/skillConfig，MCP 与 Skill 由本 agent 显式装配。
    super({
      ...config,
      features: {
        ...(config.features || {}),
        ...systemConfig,
      },
    });

    // SkillFeature：invoke_skill 工具 + skills 上下文注入，默认扫描 workspaceDir/.agentdev/skills。
    // 配置队列中的 skill 配置（全局层或 coder 层）会覆盖默认值。MCP 按上述注释刻意排除，不挂 MCPFeature。
    const skillInput = systemConfig.skill && typeof systemConfig.skill === 'object' ? systemConfig.skill : undefined;
    this.use(new SkillFeature(skillInput));

    // 替换 BasicAgent 默认挂载的 OpencodeBasicFeature 为带 Claw continuity 声明的包装版。
    // 这样包装类会让 readFiles 状态在 trim/summary 时随 continuity 协议转移到新 runtime，
    // 避免精简后会话内"先读后写"保护重置导致 write 工具被错误拦截。
    this.use(new ContinuityAwareOpencodeBasic({ workspaceDir }));

    const runtimeIdentity = {
      agentId: runtime.agentId || process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'coder',
      sessionId: runtime.sessionId ?? process.env.PROTOCLAW_PREBUILT_SESSION_ID ?? '',
      serverOrigin: runtime.serverOrigin || process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420',
    };
    // 上下文过界 → 自动线程接力：过界时打断并上报，由服务端 thread-rotation
    // 执行 trim+摘要接力。装配即确定、零配置——线程宿主的上下文管理方式
    // （自动接力）不依赖 Runtime 配置面板的交互式拦截开关。
    this.use(new ContextRotationTriggerFeature({
      ...(config.contextGuard && typeof config.contextGuard === 'object'
        ? config.contextGuard : {}),
      agentId: runtimeIdentity.agentId,
      sessionId: runtimeIdentity.sessionId,
      serverOrigin: runtimeIdentity.serverOrigin,
    }));

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
