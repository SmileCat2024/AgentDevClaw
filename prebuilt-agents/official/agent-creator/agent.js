import { BasicAgent, ShellFeature, TemplateComposer, TodoFeature, UserInputFeature } from 'agentdev';
import { AuditFeature } from '@agentdev/audit-feature';
import { WebSearchFeature } from '@agentdev/websearch-feature';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { AgentDevFeature } from '../../../local-features/dist/index.js';

const DEFAULT_EXCLUDED_MCP_SERVERS = ['crawl4ai-official'];
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROTOCLAW_ROOT = join(__dirname, '..', '..', '..');
const PROMPTS_DIR = join(__dirname, '.agentdev', 'prompts');
const SYSTEM_PROMPT_PATH = join(PROMPTS_DIR, 'system.md');
const WORKSPACE_STATE_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'agent-creator', 'state.json');
const SESSION_INDEX_PATH = join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'agent-creator', 'sessions', 'index.json');

function cleanValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseList(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatFeatureLabel(token) {
  return cleanValue(token)
    .replace(/^@agentdev\//, '')
    .replace(/-feature$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizeFeatureToken(value) {
  return cleanValue(value)
    .replace(/^@agentdev\//, '')
    .replace(/-feature$/, '');
}

function getFeatureConfigFromWorkspace(featureConfigs, token) {
  if (!featureConfigs || typeof featureConfigs !== 'object') return {};
  const candidates = new Set();
  const rawToken = cleanValue(token);
  const normalized = normalizeFeatureToken(rawToken);
  if (rawToken) candidates.add(rawToken);
  if (normalized) {
    candidates.add(normalized);
    candidates.add(`@agentdev/${normalized}`);
    candidates.add(`@agentdev/${normalized}-feature`);
  }

  for (const key of candidates) {
    const value = featureConfigs[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { ...value };
    }
  }
  return {};
}

function readAgentCreatorWorkspaceState() {
  if (!existsSync(WORKSPACE_STATE_PATH)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(WORKSPACE_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function readCurrentSessionFormId() {
  const sessionId = cleanValue(process.env.PROTOCLAW_PREBUILT_SESSION_ID);
  if (!sessionId || !existsSync(SESSION_INDEX_PATH)) {
    return '';
  }
  try {
    const parsed = JSON.parse(readFileSync(SESSION_INDEX_PATH, 'utf8'));
    const sessions = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    const matched = sessions.find((session) => cleanValue(session?.id) === sessionId);
    return cleanValue(matched?.formId);
  } catch {
    return '';
  }
}

async function instantiateSelectableFeature(token, config) {
  const normalized = cleanValue(token).replace(/^@agentdev\//, '');
  if (!normalized) {
    return null;
  }

  const moduleName = `@agentdev/${normalized}`;
  const featureConfig = {
    workspaceDir: config.workspaceDir,
    projectRoot: config.projectRoot,
    workdir: config.projectRoot,
    resourceRoot: config.projectRoot,
  };

  try {
    const workspaceRequire = createRequire(join(config.workspaceDir, 'package.json'));
    const entryPath = workspaceRequire.resolve(moduleName);
    const mod = await import(pathToFileURL(entryPath).href);
    const entry = Object.entries(mod).find(([name, value]) => typeof value === 'function' && /Feature$/.test(name));
    if (!entry) {
      console.warn(`[AgentCreator] No exported Feature class found in ${moduleName}`);
      return null;
    }
    const FeatureClass = entry[1];
    return new FeatureClass(featureConfig);
  } catch (error) {
    console.warn(`[AgentCreator] Failed to load selectable feature ${moduleName} from workspace ${config.workspaceDir}:`, error);
    return null;
  }
}

export class AgentCreatorAgent extends BasicAgent {
  constructor(config = {}) {
    const resolvedProjectRoot = config.projectRoot ?? PROTOCLAW_ROOT;
    const resolvedWorkspaceDir = config.workspaceDir ?? PROTOCLAW_ROOT;
    const assemblySessionMode = readCurrentSessionFormId() === 'assembly-form';
    let preMcpConfig = null;

    if (assemblySessionMode) {
      const workspaceState = readAgentCreatorWorkspaceState();
      const featureConfigs = workspaceState?.forms?.['feature-configs'] || {};
      preMcpConfig = getFeatureConfigFromWorkspace(featureConfigs, 'mcp');
    }

    super({
      ...config,
      ...((preMcpConfig && Object.keys(preMcpConfig).length > 0) ? {
        features: {
          ...(config.features || {}),
          mcp: preMcpConfig,
        },
      } : {}),
      projectRoot: resolvedProjectRoot,
      workspaceDir: resolvedWorkspaceDir,
      skillsDir: assemblySessionMode ? undefined : join(PROTOCLAW_ROOT, '.agentdev', 'skills'),
      excludeMcpServers: Array.from(new Set([
        ...(config.excludeMcpServers ?? []),
        ...DEFAULT_EXCLUDED_MCP_SERVERS,
      ])),
    });

    this._resolvedProjectRoot = resolvedProjectRoot;
    this._resolvedWorkspaceDir = resolvedWorkspaceDir;
    this._assemblySessionMode = assemblySessionMode;
    this._assemblyFeatureTokens = [];
    this._assemblyForm = null;
    this._assemblyFeaturesMounted = false;

    if (this._assemblySessionMode) {
      const workspaceState = readAgentCreatorWorkspaceState();
      const assemblyForm = workspaceState?.forms?.['assembly-form'] || {};
      this._assemblyForm = assemblyForm;
      this._assemblyFeatureTokens = parseList(assemblyForm.selected_features);
    }

    if (!this._assemblySessionMode) {
      this.use(new TodoFeature({
        reminderThresholdWithTasks: config.reminderThresholdWithTasks,
        reminderThresholdWithoutTasks: config.reminderThresholdWithoutTasks,
      }));
      this.use(new AuditFeature({ workspaceDir: resolvedWorkspaceDir }));
      this.use(new WebSearchFeature({ workspaceDir: resolvedWorkspaceDir }));
      this.use(new ShellFeature({
        workspaceDir: resolvedWorkspaceDir,
        resourceRoot: resolvedProjectRoot,
      }));
      this.use(new AgentDevFeature({
        workspaceDir: resolvedWorkspaceDir,
      }));
    }
    this.use(new UserInputFeature());
  }

  async ensureAssemblyFeaturesMounted() {
    if (!this._assemblySessionMode || this._assemblyFeaturesMounted) {
      return;
    }

    if (this._assemblyFeatureTokens.length > 0) {
      for (const token of this._assemblyFeatureTokens) {
        const normalized = cleanValue(token).replace(/^@agentdev\//, '');
        if (!normalized) {
          continue;
        }
        const feature = await instantiateSelectableFeature(normalized, {
          workspaceDir: this._resolvedWorkspaceDir,
          projectRoot: this._resolvedProjectRoot,
        });
        if (feature) {
          this.use(feature);
        }
      }
    }
    this._assemblyFeaturesMounted = true;
  }

  async onCall(input) {
    await this.ensureAssemblyFeaturesMounted();
    return super.onCall(input);
  }

  async prepareRuntime() {
    await this.ensureAssemblyFeaturesMounted();
  }

  async onInitiate(ctx) {
    await this.ensureAssemblyFeaturesMounted();

    await super.onInitiate(ctx);

    if (this._assemblySessionMode) {
      const assemblyName = cleanValue(this._assemblyForm?.assembly_name) || 'assembled-agent';
      const targetUser = cleanValue(this._assemblyForm?.target_user);
      const goal = cleanValue(this._assemblyForm?.goal);
      const constraints = cleanValue(this._assemblyForm?.constraints);
      const preset = cleanValue(this._assemblyForm?.preset);
      const customSystemPrompt = cleanValue(this._assemblyForm?.custom_system_prompt);
      const mountedFeatures = this._assemblyFeatureTokens.map((item) => formatFeatureLabel(item)).filter(Boolean);

      if (customSystemPrompt) {
        this.setSystemPrompt(new TemplateComposer().add(customSystemPrompt));
        return;
      }

      this.setSystemPrompt(new TemplateComposer()
        .add('你是一个已经装配完成并直接面对最终用户的聊天 Agent。')
        .add(`\n你的名称是：${assemblyName}。`)
        .add(`\n\n预设定位：${preset || 'general-chatbot'}。`)
        .add(targetUser ? `\n目标用户：${targetUser}` : '')
        .add(goal ? `\n\n主要目标：${goal}` : '')
        .add(constraints ? `\n\n边界与限制：${constraints}` : '')
        .add(mountedFeatures.length > 0 ? `\n\n当前已挂载能力：${mountedFeatures.join('、')}` : '')
        .add('\n\n直接以目标 Agent 身份与用户对话，不要提及 Agent Creator、装配过程或工作空间内部机制。')
        .add('\n没有挂载的能力不要假装拥有。')
        .add('\n如果用户表达对当前实例满意，可以简洁提示保存配置、继续复用或升级到项目开发。'));
      return;
    }

    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH })
      .add('\n\n## 当前工作台\n\n')
      .add('你正在 Claw 的 Agent 创建工作空间中运行，职责是帮助用户推进两条产品路径：装配 chatbot，以及项目开发。')
      .add('\n装配 chatbot 强调自然语言参与的受控装配、立刻开聊、启动、保存和复用。')
      .add('\n项目开发强调初始化 Agent 项目目录，并进入后续开发与调试。')
      .add('\n\n## 重点约束\n\n')
      .add('优先复用当前项目与 AgentDev 框架已有的 Agent / Feature / workspace 机制，不要发明与现有设计割裂的新约定。')
      .add('\n默认先把用户需求收敛成受控装配，不要直接把 Agent Creator 当成写 agent 代码的 IDE。')
      .add('\n装配 chatbot 默认约束在 chatbot 输入输出边界内，不要把它扩散成任意 runtime 形态。')
      .add('\n\n## 当前工作目录\n\n')
      .add(`当前工作目录为：\`${this._resolvedWorkspaceDir}\``)
      .add('\n请把这里视为当前正在开发的 Agent 根目录，默认所有读写、脚手架检查和实现调整都围绕这个目录进行。')
      .add('\n\n## Skills 目录\n\n')
      .add('当前 skills 来源有两层：')
      .add('\n1. `agent-dev` feature 自带的 skills，会被 SkillFeature 汇总展示并可直接激活')
      .add('\n2. 当前项目根目录下的 `.agentdev/skills`，可作为额外追加或覆盖来源')
      .add('\n如果用户提到 Agent 装配、项目初始化、Feature 缺口、工作空间流转或调试接入，请优先使用这些 skills，而不是只靠系统提示词硬推。')
      .add('\n\n## 默认技能工作流\n\n')
      .add('只要任务是在推进 Agent Creator，优先先调用 `agentdev-agent-creator-workflow`。')
      .add('\n如果当前是装配 chatbot，再继续调用 `agentdev-agent-assembly`。')
      .add('\n如果当前是项目开发，再继续调用 `agentdev-agent-project-workflow`。')
      .add('\n如果讨论点明显落在 AgentDev 用法或框架接入，再补充使用 `agentdev-usage`。')
      .add('\n如果讨论点明显落在 Feature 边界，再补充使用 `agentdev-feature-guide`。')
      .add('\n如果用户明确说“先不要实操 / 先分析 / 先讨论”，你必须先文字分析，不要先读目录、跑命令或改代码。')
      .add('\n\n## AgentDev 能力\n\n')
      .add('你已挂载 `agent-dev`。首轮对话开始时，它会自动把用户工作空间中保存的装配态草稿、项目态草稿和目录信息以 Markdown 注入上下文。')
      .add('\n`agent-dev` 还提供 `agentdev_set_mode` 工具，用于显式切换 `plan / code / debug` 三种工作模式。')
      .add('\n当你在装配态形成了结构化结果时，优先使用 `agentdev_write_assembly_spec` 写入 assembly spec。')
      .add('\n当你判断当前 Agent 存在能力缺口、需要先开发一个 Feature 时，优先使用 `agentdev_create_feature_handoff` 写入一条标准化 handoff 记录，而不是只在回复里口头说明。')
      .add(this._assemblySessionMode && this._assemblyFeatureTokens.length > 0
        ? `\n\n## 当前装配态已启用 Features\n\n${this._assemblyFeatureTokens.map((item) => `- ${item}`).join('\n')}`
        : '')
      .add('\n默认先按 plan 模式工作；进入规划阶段后，优先读取相关 skills 的正文内容。')
      .add('\n如果准备开始实际修改代码，再切到 code 模式。')
      .add('\n\n## 输出风格\n\n')
      .add('先给正确判断，再给最小可落地方案，再决定是继续装配 chatbot、升级到项目开发、补 Feature handoff，还是进入实现与验证。')
      .add('\n\n## 可用技能（Skills）\n\n')
      .add('当用户请求与你拥有的技能匹配时，主动使用 invoke_skill。以下是可用技能：\n')
      .add({ skills: '- **{{name}}**: {{description}}' }));
  }
}
