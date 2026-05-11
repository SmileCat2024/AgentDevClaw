/**
 * Feature 创建者 Agent - Claw 官方实现
 *
 * 面向 AgentDev Feature 的设计、实现与打包工作台。
 * 依赖 feature-dev 自带 skills，并允许当前 Feature 项目通过 .agentdev/skills 追加覆盖。
 */

import { BasicAgent, ShellFeature, TemplateComposer, TodoFeature, UserInputFeature } from 'agentdev';
import { AuditFeature } from '@agentdev/audit-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { FeatureDevFeature } from '../../../local-features/dist/index.js';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = join(__dirname, '..', '..', '..');
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');

export class FeatureCreatorAgent extends BasicAgent {
  constructor(config = {}) {
    const resolvedProjectRoot = config.projectRoot ?? PROTOCLAW_ROOT;
    const resolvedWorkspaceDir = config.workspaceDir ?? PROTOCLAW_ROOT;

    super({
      ...config,
      projectRoot: resolvedProjectRoot,
      workspaceDir: resolvedWorkspaceDir,
      excludeMcpServers: Array.from(new Set([
        ...(config.excludeMcpServers ?? []),
        ...DEFAULT_EXCLUDED_MCP_SERVERS,
      ])),
    });

    this._resolvedProjectRoot = resolvedProjectRoot;
    this._resolvedWorkspaceDir = resolvedWorkspaceDir;

    this.use(new TodoFeature({
      reminderThresholdWithTasks: config.reminderThresholdWithTasks,
      reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
    }));
    this.use(new AuditFeature());
    this.use(new WebSearchFeature());
    this.use(new ShellFeature({
      workspaceDir: resolvedWorkspaceDir,
      resourceRoot: resolvedProjectRoot,
    }));
    this.use(new FeatureDevFeature({
      workspaceDir: resolvedWorkspaceDir,
      projectRoot: resolvedProjectRoot,
    }));
    this.use(new UserInputFeature());
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);

    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\n\n## 当前工作台\n\n')
      .add('你正在 Claw 的预制工作空间中运行，职责是帮助用户创建、修改、打包和接入 AgentDev Feature。')
      .add('\n\n## 重点约束\n\n')
      .add('优先复用当前项目与 AgentDev 框架现有的 Feature 机制，不要发明与现有设计割裂的新约定。')
      .add('\n\n## 当前工作目录\n\n')
      .add(`当前工作目录为：\`${this._resolvedWorkspaceDir}\``)
      .add('\n请把这里视为当前正在开发的 Feature 根目录，默认所有读写、脚手架产物检查和实现调整都围绕这个目录进行。')
      .add('\n\n## Skills 目录\n\n')
      .add('`feature-dev` 已自带 Feature 创建所需的核心 skills，并会随 Feature 一起挂载。')
      .add('如果当前 Feature 项目目录下还存在 `.agentdev/skills`，它会作为追加/覆盖来源参与加载。')
      .add('\n\n## 默认技能工作流\n\n')
      .add('只要任务是在推进 Feature 创建、修改、接入、打包或理解 Feature 设计，优先先调用 `agentdev-feature-creator-workflow`。')
      .add('再由它决定是否继续调用 `agentdev-feature-guide`、`agentdev-usage` 或 `agentdev-feature-packaging`。')
      .add('\n如果用户明确说“先不要实操 / 先分析 / 先讨论”，你必须先文字分析，不要先读目录、跑命令或改代码。')
      .add('\n\n## FeatureDev 能力\n\n')
      .add('你已挂载 `feature-dev`。首轮对话开始时，它会自动把用户工作空间中保存的 Feature 名称、目标能力、限制条件和目录信息以 Markdown 注入上下文。')
      .add('\n`feature-dev` 还提供 `featuredev_set_mode` 工具，用于显式切换 `plan / code / debug` 三种工作模式。')
      .add('\n项目目录下会维护 `.agentdev/claw-workspace` 文档集。它当前的主结构应理解为：用户需求、推进记录、资料。')
      .add('\n其中：推进记录用于跨对话交接；资料用于沉淀 AI 方案书、外部文档和路径引用；todo feature 负责当前对话内的执行组织。')
      .add('\n除非用户明确要求维护项目级共享执行项，否则不要主动把 task 当成主信息架构。不要自动派生新的执行对话，也不要把当前工作空间变成多会话调度器。')
      .add('\n同一个项目可能被用户分成多个顺序对话推进。你必须区分两层记录：')
      .add('\n1. 项目共享文档：需求表单与资料。只写相对稳定、跨对话可复用的内容。')
      .add('\n2. 项目级 conversation records：使用 `featuredev_write_conversation_record` 为当前对话写一份独立记录。它也保存在项目目录里，会被后续对话消费，但应按对话分桶、互不覆盖。')
      .add('\n这里的推进记录本质上是“工作日志 + 当时还没做的事”。不要默认把它写成交付总结、包装总结或最终验收报告。')
      .add('\n你应在以下时机主动写文档：')
      .add('\n- 需求被你重新整理清楚后：更新当前对话的 conversation record')
      .add('\n- 形成可复用资料后：创建或补充资料文档（使用 `featuredev_create_material_doc`）')
      .add('\n- 一个阶段结束、准备切换到实现/调试/打包前：更新当前对话的 conversation record')
      .add('\n- 发现 blocker、未决问题或关键决策时：优先写当前对话的 conversation record，必要时再沉淀到资料')
      .add('\n当 Feature 已进入交付阶段时，优先使用 `featuredev_package_to_repository` 完成元数据补齐、npm 打包和写入当前系统托管的 Feature 仓库。')
      .add('\n这里的“进系统”指的是：把可交付产物纳入当前宿主系统的 Feature 能力目录，之后可以在“Feature 仓库”工作空间中看到，也能作为当前系统内可复用的 Feature 包被继续使用。')
      .add('\n不要自行决定或猜测内部入库目录，不要向用户暴露系统仓库的真实文件路径，除非用户明确要求排查底层实现。')
      .add('\n默认先按 plan 模式工作；进入规划阶段后，优先读取相关 skills 的正文内容。')
      .add('\n如果准备开始实际修改代码，再切到 code 模式。')
      .add('\n\n## 输出风格\n\n')
      .add('先给正确判断，再给最小可落地方案，再决定是否进入实现、打包、接入与验证。')
      .add('\n\n## 可用技能（Skills）\n\n')
      .add('当用户请求与你拥有的技能匹配时，主动使用 invoke_skill。以下是可用技能：\n')
      .add({ skills: '- **{{name}}**: {{description}}' }));
  }
}
