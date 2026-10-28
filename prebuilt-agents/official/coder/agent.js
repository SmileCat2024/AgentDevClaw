/**
 * 自动化编码智能体（coder）— Coder 独立工作空间（APP）的唯一 agent
 *
 * 按「无人值守、任务精准、直接执行完」的自主场景裁剪（ADR-0025：
 * coder 自 2026-08-24 并入编程小助手后，再次升格为独立后台型 APP，
 * host 关联 programming-helper，会话归属 / 线程域 / 配置全部按本 APP 寻址）。
 *
 * - 保留执行类工具链（todo / force-continuation / websearch /
 *   memory / shell / image-reader / context-rotation-trigger / github，
 *   与线程接力（context-rotation-trigger）机制协同；lsp / playwright-shell
 *   为官方可选插件，经本文件 builtinOptionalFeatures 按需挂载）。
 * - 增挂 tickets-build-flow（拿到指令之后的 implement / tdd / code-review
 *   构建流程规范），与线程看板衔接（thread-board）。
 * - 相对编程小助手的裁剪：
 *   - ClawDispatchFeature（server 侧调度桥）与 GroupChatBridgeFeature
 *     （群聊桥）不挂载——coder 以线程为执行承接单位，不自派工单。
 *   - UserInputFeature / GenerativeUISurfaceFeature / AudioFeedbackFeature
 *     不挂载——这些是面向「人类在面板输入 / 点击 / 听语音」的交互式
 *     feature；自主运行无人值守时，前两者会永久 pending 卡住线程，后者
 *     无意义。
 *   - MCP 不挂载：mcp_* 工具会占据 tools 数组头部，把核心工具挤到
 *     小模型不可见的位置（Lite 级小模型实测退化为只输出计划文本）。
 *
 * 与工作线程（thread-control）的关系：
 * - agent 本身不感知线程；会话创建/trim/摘要的线程接线由 Claw server 侧
 *   （server/thread-control/thread-integration.js）在会话生命周期钩子上
 *   完成，runtime 只按普通会话运行。
 */

import { BasicAgent, TemplateComposer, OutputGuardFeature, SkillFeature, resolveFeatureConfig, LspFeature } from '@agentdevjs/core';
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
import { ModelSelectionFeature } from '../../../local-features/dist/model-selection/src/index.js';
import { GitHubShellFeature } from '../../../local-features/dist/github/src/index.js';
import { SessionReferenceFeature } from '../../../local-features/dist/session-reference/src/index.js';
import { PlaywrightShellFeature } from '../../../local-features/dist/capability-shell/src/index.js';
import {
  readGlobalLayer,
  readAgentLayer,
} from '../../../server/shared/feature-config-layers.js';
import { extractFeatureMounts } from '../../../server/shared/feature-mount.js';
import { collapseAccumulatedFields } from '../../../server/shared/feature-config-accumulate.js';
import { resolveUserDataDir } from '../../../server/shared/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const TODO_REMINDER_PROMPT_PATH = join(PROMPTS_DIR, 'reminder-update-todo.md');
// 数据根同源解析（server/shared/constants.js），支持 AGENTDEV_DATA_DIR 多实例隔离
const USER_DATA_ROOT = resolveUserDataDir();
const IMAGE_STORAGE_DIR = join(USER_DATA_ROOT, 'images');

/**
 * 自动化编码智能体（coder）Agent
 */
export default class CoderAgent extends BasicAgent {
  constructor(config = {}) {
    const workspaceDir = config.workspaceDir || process.cwd();
    const runtime = config.runtime && typeof config.runtime === 'object' ? config.runtime : {};
    // 配置队列：[全局层(feature-setup.json), coder APP agent 层
    // (workspaces/coder/feature-config/agent.json)]。coder 层由设置菜单的
    // Feature 配置编辑，覆盖全局层同名项；队列在构造函数内组装（同进程
    // 多 session 场景禁止进程级缓存）。$mount 装配声明先于 merge 提取
    // （允许层：global/agent），剔除后的纯配置层再进 merge；装配事实由
    // 宿主（run-prebuilt-agent）消费。
    const { mounts: featureMounts, configLayers } = extractFeatureMounts([
      { id: 'global', config: readGlobalLayer() },
      { id: 'agent', config: readAgentLayer('coder') },
    ]);
    // 累加型多值字段（skill.extraDirs 等）在进 merge 前跨层叠加
    const { merged: systemConfig } = resolveFeatureConfig(collapseAccumulatedFields(configLayers));

    super({
      ...config,
      features: {
        ...(config.features || {}),
        ...systemConfig,
      },
    });

    // 用户装配的 feature（$mount 声明），语义同编程小助手（agent.js）：
    // 宿主挂载钩子在构造完成后动态挂载；coder 与 main 同权装配，无白名单。
    this.pendingFeatureMounts = featureMounts;

    // SkillFeature：invoke_skill 工具 + skills 上下文注入，默认扫描 workspaceDir/.agentdev/skills。
    // 配置队列中的 skill 配置（全局层或 coder agent 层）会覆盖默认值。
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
    // 会话级模型选择（ADR-0034）：链级当前状态随线程接续流转，
    // 输入框切换控件的后端（feature-comms selection 通道）。
    this.use(new ModelSelectionFeature(runtimeIdentity));
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

    this.use(new GitHubShellFeature());

    // 会话内容分级读取（发现 → trim 概览 → 某轮全量）：coder 可参考其他
    // 会话（如主线会话的任务上下文）；纯视图不落盘。
    this.use(new SessionReferenceFeature({
      agentId: runtimeIdentity.agentId,
      serverOrigin: runtimeIdentity.serverOrigin,
    }));
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

/** LSP 插件工厂（二进制缓存按数据根分区，见 ADR-0015）。 */
function createLspPlugin() {
  return {
    create: (config = {}, context = {}) => new LspFeature({
      workdir: context.workspaceDir || config.workspaceDir || process.cwd(),
      binDir: join(USER_DATA_ROOT, 'assets', 'lsp', 'bin'),
      ...config,
    }),
  };
}

/** playwright-shell 插件工厂（资产与档案路径按数据根分区）。 */
function createPlaywrightShellPlugin() {
  return {
    create: (config = {}, context = {}) => new PlaywrightShellFeature({
      workdir: context.workspaceDir || config.workspaceDir || process.cwd(),
      browsersPath: join(USER_DATA_ROOT, 'assets', 'playwright-shell', 'browsers'),
      profilesPath: join(USER_DATA_ROOT, 'playwright-shell', 'profiles'),
      ...config,
    }),
  };
}

/**
 * 官方可选插件工厂表（$mount kind:'builtin' 的装配权威）。
 * 键 = runtime feature name（与配置树键一致）；值工厂以（层配置值, 宿主
 * context）构造 feature 实例。宿主钩子（run-prebuilt-agent.js）在静态装配
 * 完成后按此表挂载；商店货架（server/routes/feature-store.js）import 本表
 * 后由工厂实例的 name / description 自加载展示元数据，无需另处维护。
 */
export const builtinOptionalFeatures = {
  'playwright-shell': createPlaywrightShellPlugin(),
  'lsp': createLspPlugin(),
};
