import os from 'os';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import type { AgentFeature, FeatureInitContext, FeatureStateSnapshot, PackageInfo, Tool } from 'agentdev';
import { CallStart, createTool, Decision, getPackageInfoFromSource, ToolUse } from 'agentdev';

type AgentDevMode = 'plan' | 'code' | 'debug';

interface WorkspaceState {
  forms?: Record<string, Record<string, string>>;
  openDirectory?: string;
  updatedAt?: string | null;
}

interface AgentDevSnapshot {
  mode: AgentDevMode;
}

interface WorkspaceArtifact {
  id: string;
  kind: string;
  title: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  source: Record<string, unknown>;
  relatedTo: {
    openDirectory: string;
    sessionId: string;
    parentId: string;
  };
  payload: Record<string, unknown>;
}

export interface AgentDevFeatureConfig {
  statePath?: string;
  workspaceDir?: string;
}

function getDefaultStatePath(): string {
  return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'agent-creator', 'state.json');
}

function getArtifactsDirFromStatePath(statePath: string): string {
  return join(dirname(statePath), 'artifacts');
}

function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => cleanValue(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function sanitizeArtifactId(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'artifact';
}

function cleanArtifactPayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .map(([key, value]) => [String(key), typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => value !== undefined && value !== null && !(typeof value === 'string' && value === '')),
  );
}

function normalizeArtifact(raw: Partial<WorkspaceArtifact> & { id?: string; title?: string; kind?: string }): WorkspaceArtifact {
  const source = raw.source && typeof raw.source === 'object' ? raw.source as Record<string, unknown> : {};
  const relatedTo = raw.relatedTo && typeof raw.relatedTo === 'object'
    ? raw.relatedTo as WorkspaceArtifact['relatedTo']
    : { openDirectory: '', sessionId: '', parentId: '' };

  return {
    id: sanitizeArtifactId(String(raw.id || raw.title || 'artifact')),
    kind: cleanValue(raw.kind) || 'artifact',
    title: cleanValue(raw.title) || 'artifact',
    status: cleanValue(raw.status) || 'active',
    createdAt: cleanValue(raw.createdAt) || null,
    updatedAt: cleanValue(raw.updatedAt) || null,
    source,
    relatedTo: {
      openDirectory: cleanValue(relatedTo.openDirectory),
      sessionId: cleanValue(relatedTo.sessionId),
      parentId: cleanValue(relatedTo.parentId),
    },
    payload: cleanArtifactPayload(raw.payload),
  };
}

function toInstallModeLabel(value: string): string {
  if (value === 'system') return '放入当前系统工作区';
  if (value === 'custom') return '创建到指定路径';
  return value || '未设置';
}

function buildBulletSection(title: string, body: string): string[] {
  return body ? ['', `### ${title}`, '', body] : [];
}

function getModePrompt(mode: AgentDevMode): string {
  if (mode === 'plan') {
    return [
      '## 当前工作模式：PLAN',
      '',
      '你现在处于**Agent 需求整理与装配规划**阶段。',
      '',
      '### 核心约束',
      '',
      '- 优先把用户意图收敛成受控装配，不要默认进入写代码',
      '- 默认先讨论 Agent 预设、toolkit、Feature 槽位、交互边界和调试验证路径',
      '- 当用户说先不要实操时，不要先改文件，不要先把任务转成 vibe coding',
      '- 如果发现能力缺口，先写清楚需要补的 Feature 或 handoff 记录，再进入实现',
      '',
      '### 工作重点',
      '',
      '- 装配态：优先产出 assembly spec、推荐 preset、推荐 feature 组合',
      '- 项目态：优先整理需求、确认模板和初始化范围',
      '- 两种形态都要明确用户能否立刻开聊、如何保存、如何复用、如何验证',
      '',
      '当需要实际修改 Agent 项目文件时，切换到 `code` 模式。',
    ].join('\n');
  }

  if (mode === 'debug') {
    return [
      '## 当前工作模式：DEBUG',
      '',
      '你现在处于**Agent 排查与验证**阶段。',
      '',
      '- 先说明复现路径、预期行为、实际现象和根因',
      '- 优先验证装配结果是否真实生效，而不是只检查提示词有没有写到',
      '- 调试时要区分：装配问题、Feature 缺口、项目初始化问题、运行时问题',
      '- 输出修复建议时，同时给出最小验证步骤，便于用户参与验收',
      '',
      '如果需要重新整理需求，切回 `plan`；如果确认要改代码，切到 `code`。',
    ].join('\n');
  }

  return [
    '## 当前工作模式：CODE',
    '',
    '你现在处于**Agent 实现与修改**阶段。',
    '',
    '- 先确认最小实现范围，再修改项目文件',
    '- 优先复用当前 AgentDev / Claw 的既有工作方式',
    '- 装配态相关改动优先体现在元数据、提示词、skills、workspace 状态和工具契约中',
    '- 项目态相关改动优先体现在模板初始化、项目文档集和接入路径中',
  ].join('\n');
}

function buildModeSwitchMessage(mode: AgentDevMode): string {
  return [
    `已切换到 ${mode.toUpperCase()} 模式。`,
    '',
    getModePrompt(mode),
  ].join('\n');
}

function buildWorkspaceMarkdown(state: WorkspaceState, cwd: string): string {
  const assemblyForm = state.forms?.['assembly-form'] || {};
  const startupForm = state.forms?.['startup-form'] || {};

  const assemblyName = cleanValue(assemblyForm.assembly_name);
  const assemblyPreset = cleanValue(assemblyForm.preset);
  const assemblyGoal = cleanValue(assemblyForm.goal);
  const assemblyTargetUser = cleanValue(assemblyForm.target_user);
  const assemblyToolkits = cleanValue(assemblyForm.recommended_toolkits);
  const assemblyFeatures = cleanValue(assemblyForm.selected_features);
  const assemblyConstraints = cleanValue(assemblyForm.constraints);

  const agentName = cleanValue(startupForm.agent_name);
  const goal = cleanValue(startupForm.goal);
  const constraints = cleanValue(startupForm.constraints);
  const targetUser = cleanValue(startupForm.target_user);
  const runtimeStyle = cleanValue(startupForm.runtime_style);
  const plannedFeatures = cleanValue(startupForm.planned_features);
  const installMode = toInstallModeLabel(cleanValue(startupForm.install_mode));
  const targetDir = cleanValue(startupForm.target_dir);
  const openDirectory = cleanValue(state.openDirectory) || cwd;
  const updatedAt = cleanValue(state.updatedAt);

  const lines = [
    '## Agent Creator 工作空间',
    '',
    '当前工作空间包含两条并行但互通的产品路径：',
    '',
    '- 装配 chatbot：通过自然语言收敛成结构化装配，立刻开聊、试玩、保存和复用',
    '- 项目开发：初始化 Agent 项目目录，进入后续开发与调试',
    '',
    '你的职责不是默认写代码，而是先判断用户当前要推进哪条路径，并明确下一步产物是什么。',
    '',
    `- 当前工作目录: ${cwd}`,
    `- 当前 Agent 目录: ${openDirectory || '未设置'}`,
  ];

  if (assemblyName || assemblyGoal || assemblyFeatures || assemblyToolkits) {
    lines.push(
      '',
      '## 装配 Chatbot 草稿',
      '',
      `- 装配名称: ${assemblyName || '未设置'}`,
      `- 预设形态: ${assemblyPreset || '未设置'}`,
      ...(assemblyTargetUser ? [`- 目标用户: ${assemblyTargetUser}`] : []),
      ...buildBulletSection('目标能力', assemblyGoal),
      ...buildBulletSection('推荐工具包', assemblyToolkits),
      ...buildBulletSection('计划挂载 Features', assemblyFeatures),
      ...buildBulletSection('限制条件', assemblyConstraints),
    );
  }

  if (agentName || goal || plannedFeatures || targetDir) {
    lines.push(
      '',
      '## 项目开发草稿',
      '',
      `- Agent 名称: ${agentName || '未设置'}`,
      `- 安装模式: ${installMode}`,
      `- 项目父目录: ${targetDir || '未设置'}`,
      ...(targetUser ? [`- 目标用户: ${targetUser}`] : []),
      ...(runtimeStyle ? [`- 运行形态: ${runtimeStyle}`] : []),
      ...buildBulletSection('目标能力', goal),
      ...buildBulletSection('计划挂载能力 / Features', plannedFeatures),
      ...buildBulletSection('限制条件', constraints),
    );
  }

  if (updatedAt) {
    lines.push('', `- 工作空间状态更新时间: ${updatedAt}`);
  }

  lines.push(
    '',
    '## 你的默认判断顺序',
    '',
    '1. 这是装配 chatbot，还是项目开发？',
    '2. 该先产出 assembly spec、Feature handoff，还是项目初始化方案？',
    '3. 用户是否已经可以立刻开聊 / 测试，还是还缺关键 Feature？',
  );

  return lines.join('\n').trim();
}

export class AgentDevFeature implements AgentFeature {
  readonly name = 'agent-dev';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '在首次对话时读取 Agent Creator 工作空间状态，并把装配态 / 项目态草稿与当前工作模式注入上下文。';

  private readonly statePath: string;
  private readonly workspaceDir: string;
  private readonly artifactsDir: string;
  private mode: AgentDevMode = 'plan';
  private _packageInfo: PackageInfo | null = null;

  constructor(config: AgentDevFeatureConfig = {}) {
    this.statePath = config.statePath || getDefaultStatePath();
    this.workspaceDir = config.workspaceDir || process.cwd();
    this.artifactsDir = getArtifactsDirFromStatePath(this.statePath);
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  getTemplateNames(): string[] {
    return [];
  }

  async onInitiate(_ctx: FeatureInitContext): Promise<void> {}

  async listWorkspaceArtifacts(kinds?: string[]): Promise<WorkspaceArtifact[]> {
    try {
      const entries = await fs.readdir(this.artifactsDir, { withFileTypes: true });
      const normalizedKinds = Array.isArray(kinds)
        ? new Set(kinds.map((value) => cleanValue(value)).filter(Boolean))
        : null;
      const artifacts = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map(async (entry) => {
          const raw = JSON.parse(await fs.readFile(join(this.artifactsDir, entry.name), 'utf8')) as WorkspaceArtifact;
          return normalizeArtifact(raw);
        }));

      return artifacts
        .filter((artifact) => !normalizedKinds || normalizedKinds.has(artifact.kind))
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    } catch {
      return [];
    }
  }

  async writeWorkspaceArtifact(input: {
    kind: string;
    title: string;
    status?: string;
    payload?: Record<string, unknown>;
    parentId?: string;
    sessionId?: string;
  }): Promise<WorkspaceArtifact> {
    const state = await this.readWorkspaceState();
    const timestamp = new Date().toISOString();
    const openDirectory = cleanValue(state?.openDirectory) || this.workspaceDir;
    const artifact = normalizeArtifact({
      id: `${input.kind}-${input.title}-${timestamp}`,
      kind: input.kind,
      title: input.title,
      status: input.status || 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
      source: {
        workspace: 'agent-creator',
        feature: 'agent-dev',
      },
      relatedTo: {
        openDirectory,
        sessionId: cleanValue(input.sessionId),
        parentId: cleanValue(input.parentId),
      },
      payload: input.payload || {},
    });

    const filePath = join(this.artifactsDir, `${artifact.id}.json`);
    await fs.mkdir(this.artifactsDir, { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return artifact;
  }

  async readWorkspaceState(): Promise<WorkspaceState | null> {
    try {
      const raw = await fs.readFile(this.statePath, 'utf8');
      return JSON.parse(raw) as WorkspaceState;
    } catch {
      return null;
    }
  }

  async buildWorkspaceMarkdown(cwd: string = this.workspaceDir): Promise<string> {
    const state = await this.readWorkspaceState();
    if (!state) return '';
    return buildWorkspaceMarkdown(state, cwd);
  }

  getTools(): Tool[] {
    return [
      createTool({
        name: 'agentdev_set_mode',
        description: '切换 Agent Creator 工作模式。可选 plan、code、debug。',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['plan', 'code', 'debug'],
            },
          },
          required: ['mode'],
        },
        execute: async ({ mode }) => {
          const nextMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
          if (nextMode !== 'plan' && nextMode !== 'code' && nextMode !== 'debug') {
            throw new Error('Invalid mode. Use one of: plan, code, debug.');
          }

          this.mode = nextMode as AgentDevMode;

          return {
            mode: this.mode,
            prompt: getModePrompt(this.mode),
            message: buildModeSwitchMessage(this.mode),
          };
        },
      }),
      createTool({
        name: 'agentdev_write_artifact',
        description: '向当前 Agent Creator 工作空间写入一条过程记录。适合保存 draft、plan、assembly-spec、handoff、progress、verification、debug-report 等过程节点。',
        parameters: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: ['draft', 'plan', 'assembly-spec', 'handoff', 'progress', 'decision', 'verification', 'debug-report'],
            },
            title: { type: 'string' },
            status: { type: 'string' },
            parentId: { type: 'string' },
            sessionId: { type: 'string' },
            payload: {
              type: 'object',
              additionalProperties: true,
            },
          },
          required: ['kind', 'title'],
        },
        execute: async ({ kind, title, status, parentId, sessionId, payload }) => {
          const artifact = await this.writeWorkspaceArtifact({
            kind: cleanValue(kind),
            title: cleanValue(title),
            status: cleanValue(status) || 'active',
            parentId: cleanValue(parentId),
            sessionId: cleanValue(sessionId),
            payload: cleanArtifactPayload(payload),
          });

          return {
            artifact,
            message: '已写入 Agent Creator 工作空间记录。',
          };
        },
      }),
      createTool({
        name: 'agentdev_list_artifacts',
        description: '读取当前 Agent Creator 工作空间中的过程记录摘要。',
        parameters: {
          type: 'object',
          properties: {
            kinds: {
              type: 'array',
              items: { type: 'string' },
            },
            limit: { type: 'number' },
          },
        },
        execute: async ({ kinds, limit }) => {
          const artifacts = await this.listWorkspaceArtifacts(Array.isArray(kinds) ? kinds.map((value) => String(value ?? '')) : undefined);
          const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 10;
          return {
            count: artifacts.length,
            items: artifacts.slice(0, safeLimit),
          };
        },
      }),
      createTool({
        name: 'agentdev_write_assembly_spec',
        description: '把当前装配 chatbot 的结构化装配结果写成 assembly spec，便于保存、复用、交接和后续升级到项目态。',
        parameters: {
          type: 'object',
          properties: {
            assemblyName: { type: 'string' },
            preset: { type: 'string' },
            targetUser: { type: 'string' },
            goal: { type: 'string' },
            toolkits: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
            features: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
            },
            interactionContract: { type: 'string' },
            constraints: { type: 'string' },
            projectUpgradePath: { type: 'string' },
            sessionId: { type: 'string' },
            parentId: { type: 'string' },
          },
          required: ['assemblyName', 'preset', 'goal'],
        },
        execute: async ({ assemblyName, preset, targetUser, goal, toolkits, features, interactionContract, constraints, projectUpgradePath, sessionId, parentId }) => {
          const cleanName = cleanValue(assemblyName);
          const cleanPreset = cleanValue(preset);
          const cleanGoal = cleanValue(goal);
          const cleanTargetUser = cleanValue(targetUser);
          const toolkitList = cleanStringArray(toolkits);
          const featureList = cleanStringArray(features);
          const artifact = await this.writeWorkspaceArtifact({
            kind: 'assembly-spec',
            title: `Assembly Spec: ${cleanName}`,
            status: 'draft',
            parentId: cleanValue(parentId),
            sessionId: cleanValue(sessionId),
            payload: cleanArtifactPayload({
              assembly_name: cleanName,
              preset: cleanPreset,
              target_user: cleanTargetUser,
              goal: cleanGoal,
              toolkits: toolkitList,
              features: featureList,
              interaction_contract: cleanValue(interactionContract),
              constraints: cleanValue(constraints),
              project_upgrade_path: cleanValue(projectUpgradePath),
            }),
          });

          return {
            artifact,
            message: '已写入 assembly spec，可用于后续试玩、复用或升级到项目开发。',
          };
        },
      }),
      createTool({
        name: 'agentdev_get_workspace_brief',
        description: '读取当前 Agent Creator 工作空间的装配态 / 项目态草稿与当前模式摘要。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const state = await this.readWorkspaceState();
          const markdown = await this.buildWorkspaceMarkdown(this.workspaceDir);
          return {
            mode: this.mode,
            state: state || {},
            markdown,
          };
        },
      }),
      createTool({
        name: 'agentdev_create_feature_handoff',
        description: '当当前 Agent 装配存在能力缺口、需要先开发一个 Feature 时，写入一条标准化 handoff 记录，供后续流转到 Feature Creator。',
        parameters: {
          type: 'object',
          properties: {
            featureName: {
              type: 'string',
              description: '建议开发的 Feature 名称，例如 browser-automation-feature。',
            },
            reason: {
              type: 'string',
              description: '为什么当前 Agent 装配需要这个 Feature。',
            },
            requestedCapability: {
              type: 'string',
              description: '期望该 Feature 提供的核心能力。',
            },
            acceptanceCriteria: {
              type: 'string',
              description: 'Feature 完成后至少应满足的验收标准。',
            },
            constraints: {
              type: 'string',
              description: '对该 Feature 的限制条件、依赖或边界。',
            },
            parentId: { type: 'string' },
            sessionId: { type: 'string' },
          },
          required: ['featureName', 'reason', 'requestedCapability'],
        },
        execute: async ({ featureName, reason, requestedCapability, acceptanceCriteria, constraints, parentId, sessionId }) => {
          const cleanFeatureName = cleanValue(featureName);
          const artifact = await this.writeWorkspaceArtifact({
            kind: 'handoff',
            title: `Feature Handoff: ${cleanFeatureName}`,
            status: 'proposed',
            parentId: cleanValue(parentId),
            sessionId: cleanValue(sessionId),
            payload: cleanArtifactPayload({
              feature_name: cleanFeatureName,
              reason: cleanValue(reason),
              requested_capability: cleanValue(requestedCapability),
              acceptance_criteria: cleanValue(acceptanceCriteria),
              constraints: cleanValue(constraints),
              handoff_target: 'feature-creator',
            }),
          });

          return {
            artifact,
            message: '已写入 Feature handoff 记录，可供后续流转到 Feature Creator。',
          };
        },
      }),
    ];
  }

  @CallStart
  async injectWorkspaceState(ctx: import('agentdev').CallStartContext): Promise<void> {
    const modePrompt = getModePrompt(this.mode);
    if (modePrompt) {
      ctx.context.add({ role: 'system', content: modePrompt });
    }

    if (ctx.isFirstCall) {
      const markdown = await this.buildWorkspaceMarkdown(this.workspaceDir);
      if (markdown) {
        ctx.context.add({ role: 'system', content: markdown });
      }
    }
  }

  @ToolUse
  async guardEditToolInPlanMode(ctx: import('agentdev').ToolContext): Promise<import('agentdev').DecisionResult> {
    if (this.mode !== 'plan') {
      return Decision.Continue;
    }

    if (ctx.call.name !== 'edit') {
      return Decision.Continue;
    }

    const message = [
      '当前处于 PLAN 模式，不能直接进行文件编辑。',
      '如果确实要开始写代码，请先调用 `agentdev_set_mode` 切换到 `code` 模式。',
    ].join('\n');

    ctx.context.add({ role: 'system', content: message });
    return {
      action: Decision.Deny,
      reason: message,
    };
  }

  captureState(): FeatureStateSnapshot {
    const snapshot: AgentDevSnapshot = {
      mode: this.mode,
    };
    return snapshot;
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as AgentDevSnapshot | undefined;
    if (state?.mode === 'plan' || state?.mode === 'code' || state?.mode === 'debug') {
      this.mode = state.mode;
    }
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'CallStart' && methodName === 'injectWorkspaceState') {
      return '在每轮开始时注入当前工作模式提示；首次对话时额外读取 Agent Creator 工作空间状态，并把装配态 / 项目态草稿以 Markdown 注入系统上下文。';
    }
    if (lifecycle === 'ToolUse' && methodName === 'guardEditToolInPlanMode') {
      return '在 plan 模式下拦截 edit 工具，避免方案未定时直接改文件。';
    }
    return undefined;
  }
}
