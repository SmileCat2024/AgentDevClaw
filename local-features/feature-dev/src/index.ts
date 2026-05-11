import os from 'os';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { AgentFeature, FeatureInitContext, FeatureStateSnapshot, PackageInfo, Tool } from 'agentdev';
import { CallStart, createTool, Decision, getPackageInfoFromSource, ToolUse } from 'agentdev';

export interface FeatureDevFeatureConfig {
  statePath?: string;
  workspaceDir?: string;
  projectRoot?: string;
  repositoryDir?: string;
}

type FeatureDevMode = 'plan' | 'code' | 'debug' | 'package';

interface WorkspaceState {
  forms?: Record<string, Record<string, string>>;
  openDirectory?: string;
  updatedAt?: string | null;
}

interface FeatureDevSnapshot {
  mode: FeatureDevMode;
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

interface ConversationRecord {
  sessionId: string;
  title: string;
  summary: string;
  currentFocus: string;
  nextActions: string[];
  openQuestions: string[];
  keyDecisions: string[];
  relatedMaterialIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface FeatureManifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  entry: string;
  homepage: string;
  repository: string;
  agentdev: {
    compatible: string;
  };
  featureTypes: string[];
  compatibility: {
    rollback: boolean;
    tags: string[];
  };
  requirements: {
    platforms: string[];
    node: string;
    external: string[];
    services: string[];
  };
}

interface SharedShellFeature {
  run(command: string): Promise<{
    stdout: string;
    stderr: string;
    output: string;
  }>;
}

const FEATURE_MANIFEST_NAME = 'agentdev-feature.json';
const FEATURE_TYPE_VALUES = ['tools', 'mcp', 'hooks', 'control', 'rollback'] as const;
const FEATURE_REPOSITORY_SUBPATH = join('resources', 'features');
const USER_FEATURE_REPOSITORY_SUBPATH = join('.agentdev', 'AgentDevClaw', 'user-features');
const PROJECT_DOCSET_SUBPATH = join('.agentdev', 'claw-workspace');
const VALIDATE_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'validate-feature.mjs');

function getDefaultStatePath(): string {
  return join(os.homedir(), '.agentdev', 'AgentDevClaw', 'workspaces', 'feature-creator', 'state.json');
}

function getArtifactsDirFromStatePath(statePath: string): string {
  return join(dirname(statePath), 'artifacts');
}

function getProjectDocsetDir(projectDir: string): string {
  return join(projectDir, PROJECT_DOCSET_SUBPATH);
}

function getProjectDocsetFormsDir(projectDir: string): string {
  return join(getProjectDocsetDir(projectDir), 'forms');
}

function getProjectDocsetMaterialsDir(projectDir: string): string {
  return join(getProjectDocsetDir(projectDir), 'materials');
}

function getProjectDocsetConversationsDir(projectDir: string): string {
  return join(getProjectDocsetDir(projectDir), 'conversations');
}

function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function sanitizeProjectDocId(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'doc';
}

function buildProjectDocId(prefix: string, title: string, timestamp: string): string {
  const normalizedTitle = sanitizeProjectDocId(title || prefix);
  const compactTime = String(timestamp || new Date().toISOString()).replace(/[^0-9]/g, '').slice(0, 14);
  return `${prefix}-${normalizedTitle}-${compactTime || Date.now()}`;
}

function normalizeStringArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.map((value) => cleanValue(value)).filter(Boolean)
    : [];
}

function normalizeConversationRecord(raw: Partial<ConversationRecord> & { sessionId?: string; title?: string }): ConversationRecord {
  const timestamp = new Date().toISOString();
  return {
    sessionId: sanitizeProjectDocId(String(raw.sessionId || 'session')),
    title: cleanValue(raw.title) || 'conversation-record',
    summary: cleanValue(raw.summary),
    currentFocus: cleanValue(raw.currentFocus),
    nextActions: normalizeStringArray(raw.nextActions),
    openQuestions: normalizeStringArray(raw.openQuestions),
    keyDecisions: normalizeStringArray(raw.keyDecisions),
    relatedMaterialIds: normalizeStringArray((raw as { relatedMaterialIds?: unknown }).relatedMaterialIds).map((value) => sanitizeProjectDocId(value)),
    createdAt: cleanValue(raw.createdAt) || timestamp,
    updatedAt: cleanValue(raw.updatedAt) || timestamp,
  };
}

function toInstallModeLabel(value: string): string {
  if (value === 'system') return '放入当前系统工作区';
  if (value === 'custom') return '创建到指定路径';
  return value || '未设置';
}

function buildWorkspaceMarkdown(state: WorkspaceState, cwd: string): string {
  const startupForm = state.forms?.['startup-form'] || {};
  const featureName = cleanValue(startupForm.feature_name);
  const goal = cleanValue(startupForm.goal);
  const constraints = cleanValue(startupForm.constraints);
  const installMode = toInstallModeLabel(cleanValue(startupForm.install_mode));
  const targetDir = cleanValue(startupForm.target_dir);
  const openDirectory = cleanValue(state.openDirectory) || cwd;
  const updatedAt = cleanValue(state.updatedAt);

  const lines = [
    '## Feature 开发工作空间',
    '',
    '以下内容来自用户在工作台表单里填写的需求草稿。它代表用户当前的表达，不一定严谨、完整或技术上准确。',
    '你的职责是先理解、整理和校准这些需求，再决定如何设计或实现，不要把这些原话当成已经确认过的严格规范。',
    '',
    `- 当前工作目录: ${cwd}`,
    `- Feature 目录: ${openDirectory || '未设置'}`,
    `- Feature 名称: ${featureName || '未设置'}`,
    `- 安装模式: ${installMode}`,
    `- 项目父目录: ${targetDir || '未设置'}`,
  ];

  if (goal) {
    lines.push('', '### 目标能力', '', goal);
  }

  if (constraints) {
    lines.push('', '### 限制条件', '', constraints);
  }

  if (updatedAt) {
    lines.push('', `- 工作空间状态更新时间: ${updatedAt}`);
  }

  return lines.join('\n').trim();
}

function getDocumentationDisciplineLines(): string[] {
  return [
    '### 文档纪律（每轮都要记住）',
    '',
    '- 当前项目允许多个顺序对话共享同一套项目文档；不要把本对话的临时判断直接写进共享资料',
    '- 本对话的阶段总结、当前焦点、关键决策、下一步、未决问题，优先写入 `featuredev_write_conversation_record`',
    '- 只有形成跨对话稳定结论时，才写入资料文档；一旦方案、接口或参考信息已经稳定，就应主动调用 `featuredev_create_material_doc`',
    '- 如果你刚整理清需求、刚形成稳定资料、刚结束一个阶段，但还没写记录，你应该优先补文档，再继续',
  ];
}

function buildToolReinforcementMessage(lines: string[]): string {
  return lines.filter(Boolean).join('\n');
}

function buildMissingConversationRecordWarning(mode: FeatureDevMode): string {
  return [
    `警告：当前对话还没有项目级推进记录，但你已经进入 ${mode.toUpperCase()} 阶段。`,
    '在继续之前，优先调用 `featuredev_write_conversation_record` 记录本对话已完成的工作、当前判断、剩余工作和未决问题。',
    '如果不先补这条记录，多对话共享同一项目时就很容易丢上下文或污染共享文档。',
  ].join('\n');
}

function getModePrompt(mode: FeatureDevMode): string {
  if (mode === 'plan') {
    return [
      '## 当前工作模式：PLAN',
      '',
      '你现在处于**理解与规划**阶段。',
      '',
      '### 核心约束',
      '',
      '- 先判断用户要的是理解、分析、设计还是实操',
      '- 先用通俗语言解释，不要一上来堆术语',
      '- 当用户说先不要实操时，不要读目录、不要改文件、不要跑编辑类工具',
      '- 进入规划阶段后，优先查看与当前问题相关的 skills 内容，再给方案',
      '- 先澄清 Feature 在 AgentDev 里应该落在哪个扩展点，再讨论实现细节',
      '- 一旦你把需求整理清楚，应先写推进记录；当方案、接口、外部参考或路径引用已经稳定，应尽快写 `featuredev_create_material_doc`，不要只停留在口头分析',
      '',
      ...getDocumentationDisciplineLines(),
      '',
      '### 何时切换到其他模式',
      '',
      '- 用户明确要开始实现 → 切换到 `CODE`',
      '- 遇到具体问题需要排查 → 切换到 `DEBUG`',
      '- Feature 已完成需要打包 → 切换到 `PACKAGE`',
      '',
      '使用 `featuredev_set_mode` 工具切换模式。',
    ].join('\n');
  }

  if (mode === 'debug') {
    return [
      '## 当前工作模式：DEBUG',
      '',
      '你现在处于**排查与修复**阶段。',
      '',
      '### 核心约束',
      '',
      '- 先定位现象、根因和复现路径',
      '- 优先最小化修改，先验证再扩散',
      '- 解释问题时先说人话，必要时再补术语',
      '- 当你确认了问题、修复方向、残留风险或下一步验证动作，应主动写 `featuredev_write_conversation_record`；必要时补充资料文档',
      '',
      ...getDocumentationDisciplineLines(),
      '',
      '### 何时切换到其他模式',
      '',
      '- 需要重新规划方案 → 切换到 `PLAN`',
      '- 确认问题需要修改代码 → 切换到 `CODE`',
      '',
      '使用 `featuredev_set_mode` 工具切换模式。',
    ].join('\n');
  }

  if (mode === 'package') {
    return [
      '## 当前工作模式：PACKAGE',
      '',
      '你现在处于**打包与交付**阶段。',
      '',
      '### 核心约束',
      '',
      '**检查完备性**：',
      '',
      '- README.md 存在且内容完整（功能说明、使用示例、配置说明）',
      '- package.json 字段完整（name、version、description、main、keywords）',
      '- agentdev-feature.json 存在且类型标签正确',
      '- 必要的 TypeScript 类型定义或 JSDoc 注释',
      '- 构建脚本可正常执行',
      '- 进入打包前，应先写 `featuredev_write_conversation_record`，记录当前已完成的工作、验证状态、剩余工作和遗留问题',
      '- 打包前必须调用 `featuredev_validate` 确认验证通过；不通过则先切回 `CODE` 模式修复',
      '',
      ...getDocumentationDisciplineLines(),
      '',
      '使用 `featuredev_package_to_repository` 工具完成：',
      '',
      '- 自动补齐 agentdev-feature.json',
      '- 执行构建与 npm pack',
      '- 将最终产物写入系统托管的 Feature 仓库',
      '',
      '### 何时切换到其他模式',
      '',
      '- 发现不满足打包条件 → 切换到 `PLAN` 或 `CODE` 补充内容',
      '',
      '使用 `featuredev_set_mode` 工具切换模式。',
    ].join('\n');
  }

  return [
    '## 当前工作模式：CODE',
    '',
    '你现在处于**实现与修改**阶段。',
    '',
    '### 核心约束',
    '',
    '- 先确认最小实现范围，再动手修改',
    '- 改动优先贴合现有 AgentDev / Claw 结构',
    '- 代码之外的说明尽量简洁，优先给结果和验证',
    '- 一个阶段实现完成后，调用 `featuredev_validate` 验证结构合规性；有错误先修复再继续',
    '- 开始实现前和一个阶段实现完成后，都应主动写 `featuredev_write_conversation_record`；必要时补充资料文档',
    '',
    ...getDocumentationDisciplineLines(),
    '',
    '### 何时切换到其他模式',
    '',
    '- 需要重新规划方案 → 切换到 `PLAN`',
    '- 遇到问题需要排查 → 切换到 `DEBUG`',
    '- 实现完成需要打包 → 切换到 `PACKAGE`',
    '',
    '使用 `featuredev_set_mode` 工具切换模式。',
  ].join('\n');
}

function buildModeSwitchMessage(mode: FeatureDevMode): string {
  const prompt = getModePrompt(mode);
  return [
    `已切换到 ${mode.toUpperCase()} 模式。`,
    '',
    '以下是当前模式下应遵守的工作提示词：',
    '',
    prompt,
  ].join('\n');
}

function buildConversationRecordMarkdown(record: ConversationRecord, title = '项目级推进记录'): string {
  return [
    `## ${title}`,
    '',
    `- 更新时间: ${record.updatedAt}`,
    `- Session ID: ${record.sessionId}`,
    `- 标题: ${record.title}`,
    record.summary ? `- 阶段总结: ${record.summary}` : '',
    record.currentFocus ? `- 当前焦点: ${record.currentFocus}` : '',
    record.keyDecisions.length > 0 ? `- 关键决策: ${record.keyDecisions.join('；')}` : '',
    record.relatedMaterialIds.length > 0 ? `- 关联资料: ${record.relatedMaterialIds.join(', ')}` : '',
    record.nextActions.length > 0 ? `- 下一步: ${record.nextActions.join('；')}` : '',
    record.openQuestions.length > 0 ? `- 未决问题: ${record.openQuestions.join('；')}` : '',
  ].filter(Boolean).join('\n');
}

function extractMaterialSourcePath(body: string): string {
  const text = typeof body === 'string' ? body : '';
  const match = text.match(/^- Source Path:\s*(.+)$/m);
  return match ? cleanValue(match[1]) : '';
}

function uniqueStrings(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function normalizeFeatureTypes(values: unknown): string[] {
  const allowed = new Set<string>(FEATURE_TYPE_VALUES);
  return uniqueStrings(values).filter((value) => allowed.has(value));
}

function normalizeFeatureCompatibility(raw: unknown, featureTypes: string[], rollbackOverride?: boolean): FeatureManifest['compatibility'] {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const rollback = typeof rollbackOverride === 'boolean'
    ? rollbackOverride
    : (typeof source.rollback === 'boolean' ? source.rollback : featureTypes.includes('rollback'));

  return {
    rollback,
    tags: uniqueStrings([
      ...(Array.isArray(source.tags) ? source.tags : []),
      rollback ? 'supports-rollback' : 'no-rollback',
    ]),
  };
}

function normalizeFeatureRequirements(raw: unknown): FeatureManifest['requirements'] {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    platforms: uniqueStrings(source.platforms),
    node: typeof source.node === 'string' ? source.node.trim() : '',
    external: uniqueStrings(source.external),
    services: uniqueStrings(source.services),
  };
}

async function inferFeatureTypes(
  pkg: Record<string, unknown>,
  packageId: string,
  workspaceDir: string
): Promise<string[]> {
  const packageName = typeof pkg.name === 'string' ? pkg.name.trim() : '';

  if (packageName.startsWith('@sliverp/')) {
    return [];
  }

  // 自动推断：tools、hooks、mcp、rollback
  // control 需要用户手动选择（因为需要判断是否有主动调用接口或流程控制意图）
  const inferred: string[] = [];

  // 尝试读取源码进行结构分析
  const entryFile = typeof pkg.main === 'string' ? pkg.main.trim() : '';
  let sourceCode = '';

  // 优先读取源码文件（src/index.ts 或 main 指向的文件）
  const possiblePaths = [
    join(workspaceDir, 'src', 'index.ts'),
    join(workspaceDir, 'src', 'index.js'),
    entryFile ? join(workspaceDir, entryFile.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts')) : '',
    entryFile ? join(workspaceDir, entryFile) : '',
    join(workspaceDir, 'index.ts'),
    join(workspaceDir, 'index.js'),
  ].filter(Boolean);

  for (const path of possiblePaths) {
    try {
      sourceCode = await fs.readFile(path, 'utf8');
      break;
    } catch {
      // 继续尝试下一个路径
    }
  }

  // 基于源码结构推断类型
  if (sourceCode) {
    // tools: 检测 getTools() 或 getAsyncTools() 方法
    if (/get(?:Async)?Tools\s*\(/.test(sourceCode)) {
      inferred.push('tools');
    }

    // hooks: 检测生命周期装饰器 或 lifecycle methods
    const hasReverseHooks = /@(CallStart|CallEnd|CallFinish|ToolUse|StepFinish)\b/.test(sourceCode);
    const hasLifecycleMethods = /onInitiate\s*\(|onDestroy\s*\(/.test(sourceCode);

    if (hasReverseHooks || hasLifecycleMethods) {
      inferred.push('hooks');
    }

    // mcp: 检测 MCP 相关方法
    if (/getMcpServers\s*\(/.test(sourceCode) || /McpFeature/i.test(sourceCode)) {
      inferred.push('mcp');
    }

    // rollback: 只有实现了 rollback 相关方法时才标记
    const hasRollbackMethods = /captureState\s*\(|restoreState\s*\(|beforeRollback\s*\(|afterRollback\s*\(/.test(sourceCode);
    if (hasRollbackMethods) {
      inferred.push('rollback');
    }

    // control: 检测是否有流程控制逻辑（Decision.Deny/Decision.Continue）
    // 注意：这只是检测到代码中有 Decision 相关逻辑，不自动添加
    // 用户需要手动确认是否有主动调用接口或流程控制意图
  } else {
    // 降级方案：基于包名推断（保持向后兼容）
    const lowerPackageId = String(packageId || '').toLowerCase();
    if (/(shell|websearch|visual|tts|lsp|memory)/i.test(lowerPackageId)) {
      inferred.push('tools');
    }
    if (/(audio-feedback|audit|plugin-compat)/i.test(lowerPackageId)) {
      inferred.push('hooks');
    }
  }

  return inferred;
}

function inferFeatureRequirements(pkg: Record<string, unknown>, packageId: string): FeatureManifest['requirements'] {
  const dependencies = Object.keys((pkg.dependencies && typeof pkg.dependencies === 'object') ? pkg.dependencies as Record<string, unknown> : {});
  const requirements = {
    platforms: [] as string[],
    node: typeof pkg.engines === 'object' && pkg.engines && typeof (pkg.engines as Record<string, unknown>).node === 'string'
      ? String((pkg.engines as Record<string, unknown>).node).trim()
      : '',
    external: [] as string[],
    services: [] as string[],
  };

  if (dependencies.includes('openai') || /websearch|visual|tts/i.test(packageId)) {
    requirements.services.push('network');
  }
  if (/shell/i.test(packageId)) {
    requirements.external.push('system-shell');
  }
  if (/audio|tts/i.test(packageId) || dependencies.includes('sound-play')) {
    requirements.external.push('audio-output');
  }
  if (/visual/i.test(packageId)) {
    requirements.external.push('desktop-capture');
  }
  if (/lsp/i.test(packageId)) {
    requirements.external.push('language-server');
  }
  if (/qqbot/i.test(packageId)) {
    requirements.services.push('qqbot');
  }

  return requirements;
}

async function inferFeatureManifest(
  pkg: Record<string, unknown>,
  packageFileName = '',
  workspaceDir: string
): Promise<FeatureManifest> {
  const packageName = typeof pkg.name === 'string' ? pkg.name.trim() : '';
  const packageId = packageName ? packageName.split('/').pop() || packageName : packageFileName.replace(/\.tgz$/i, '') || 'feature-package';
  const featureTypes = await inferFeatureTypes(pkg, packageId, workspaceDir);

  return {
    schemaVersion: 1,
    id: packageId,
    name: packageId,
    version: typeof pkg.version === 'string' ? pkg.version.trim() : '',
    description: typeof pkg.description === 'string' ? pkg.description.trim() : '',
    tags: uniqueStrings(pkg.keywords),
    entry: typeof pkg.main === 'string' ? pkg.main.trim() : '',
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage.trim() : '',
    repository: typeof pkg.repository === 'string'
      ? pkg.repository.trim()
      : (pkg.repository && typeof pkg.repository === 'object' && typeof (pkg.repository as Record<string, unknown>).url === 'string'
        ? String((pkg.repository as Record<string, unknown>).url).trim()
        : ''),
    agentdev: {
      compatible: pkg.peerDependencies && typeof pkg.peerDependencies === 'object' && typeof (pkg.peerDependencies as Record<string, unknown>).agentdev === 'string'
        ? String((pkg.peerDependencies as Record<string, unknown>).agentdev).trim()
        : '',
    },
    featureTypes,
    compatibility: normalizeFeatureCompatibility({}, featureTypes),
    requirements: inferFeatureRequirements(pkg, packageId),
  };
}

async function mergeFeatureManifest(
  pkg: Record<string, unknown>,
  existingManifest: unknown,
  overrides: { featureTypes?: string[]; rollback?: boolean } = {},
  workspaceDir: string,
): Promise<FeatureManifest> {
  const inferred = await inferFeatureManifest(pkg, '', workspaceDir);
  const source = existingManifest && typeof existingManifest === 'object' ? existingManifest as Record<string, unknown> : {};
  const featureTypes = normalizeFeatureTypes(
    overrides.featureTypes && overrides.featureTypes.length > 0
      ? overrides.featureTypes
      : (source.featureTypes ?? inferred.featureTypes),
  );
  const compatibility = normalizeFeatureCompatibility(source.compatibility, featureTypes, overrides.rollback);

  return {
    schemaVersion: 1,
    id: typeof source.id === 'string' && source.id.trim() ? source.id.trim() : inferred.id,
    name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : inferred.name,
    version: typeof pkg.version === 'string' ? pkg.version.trim() : inferred.version,
    description: typeof source.description === 'string' && source.description.trim()
      ? source.description.trim()
      : inferred.description,
    tags: uniqueStrings([
      ...(Array.isArray(source.tags) ? source.tags : []),
      ...(Array.isArray(pkg.keywords) ? pkg.keywords : []),
    ]),
    entry: typeof source.entry === 'string' && source.entry.trim()
      ? source.entry.trim()
      : inferred.entry,
    homepage: typeof source.homepage === 'string' && source.homepage.trim()
      ? source.homepage.trim()
      : inferred.homepage,
    repository: typeof source.repository === 'string' && source.repository.trim()
      ? source.repository.trim()
      : inferred.repository,
    agentdev: {
      compatible: source.agentdev && typeof source.agentdev === 'object' && typeof (source.agentdev as Record<string, unknown>).compatible === 'string'
        ? String((source.agentdev as Record<string, unknown>).compatible).trim()
        : inferred.agentdev.compatible,
    },
    featureTypes,
    compatibility,
    requirements: normalizeFeatureRequirements(source.requirements && typeof source.requirements === 'object'
      ? {
          ...inferred.requirements,
          ...(source.requirements as Record<string, unknown>),
        }
      : inferred.requirements),
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string; }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function runShellFeatureCommand(shellFeature: SharedShellFeature, command: string): Promise<string> {
  const result = await shellFeature.run(command);
  return result.stdout || result.output || result.stderr || '';
}

function parsePackArchiveName(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    throw new Error('npm pack 没有返回任何输出。');
  }

  const jsonStart = trimmed.indexOf('[');
  const payload = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
  const parsedPackResult = JSON.parse(payload) as Array<{ filename?: string }>;
  const archiveName = parsedPackResult[0]?.filename?.trim();
  if (!archiveName) {
    throw new Error('npm pack 没有返回有效的 tgz 文件名。');
  }
  return archiveName;
}

async function ensurePackageIncludesManifest(packageJsonPath: string, pkg: Record<string, unknown>): Promise<boolean> {
  if (!Array.isArray(pkg.files)) {
    return false;
  }
  const nextFiles = uniqueStrings([...(pkg.files as unknown[]), FEATURE_MANIFEST_NAME]);
  const changed = nextFiles.length !== pkg.files.length;
  if (!changed) {
    return false;
  }

  await writeJsonFile(packageJsonPath, {
    ...pkg,
    files: nextFiles,
  });
  return true;
}

async function stripMissingTemplateEntryFromPackageJson(
  packageJsonPath: string,
  pkg: Record<string, unknown>,
  workspaceDir: string,
): Promise<{ changed: boolean; note?: string }> {
  const tsup = pkg.tsup;
  if (!tsup || typeof tsup !== 'object') {
    return { changed: false };
  }

  const entry = (tsup as Record<string, unknown>).entry;
  if (!Array.isArray(entry)) {
    return { changed: false };
  }

  const templateGlob = 'src/templates/*.render.ts';
  if (!entry.some((item) => typeof item === 'string' && item === templateGlob)) {
    return { changed: false };
  }

  const templateDir = join(workspaceDir, 'src', 'templates');
  const templateFiles = await fs.readdir(templateDir, { withFileTypes: true }).catch(() => []);
  const hasTemplateFiles = templateFiles.some((entry) => entry.isFile() && entry.name.endsWith('.render.ts'));
  if (hasTemplateFiles) {
    return { changed: false };
  }

  const nextEntry = entry.filter((item) => item !== templateGlob);
  await writeJsonFile(packageJsonPath, {
    ...pkg,
    tsup: {
      ...(tsup as Record<string, unknown>),
      entry: nextEntry,
    },
  });
  return {
    changed: true,
    note: '检测到旧脚手架留下的 `src/templates/*.render.ts` 入口，但当前项目没有模板文件；已在打包前自动移除该无效 tsup 入口。',
  };
}

async function archiveContainsManifest(archivePath: string, cwd: string): Promise<boolean> {
  try {
    await runCommand('tar', ['-xOf', archivePath, `package/${FEATURE_MANIFEST_NAME}`], cwd);
    return true;
  } catch {
    return false;
  }
}

async function injectManifestIntoArchive(archivePath: string, manifest: FeatureManifest, cwd: string): Promise<void> {
  const tempDir = await fs.mkdtemp(join(os.tmpdir(), 'agentdev-feature-pack-'));
  try {
    await runCommand('tar', ['-xzf', archivePath], tempDir);
    await writeJsonFile(join(tempDir, 'package', FEATURE_MANIFEST_NAME), manifest);
    await runCommand('tar', ['-czf', archivePath, 'package'], tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class FeatureDevFeature implements AgentFeature {
  readonly name = 'feature-dev';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description = '在首次对话时读取 Feature 创建工作空间状态，并将目标、限制和目录信息注入上下文。';

  private readonly statePath: string;
  private readonly workspaceDir: string;
  private readonly projectRoot: string;
  private readonly repositoryDir: string;
  private readonly artifactsDir: string;
  private mode: FeatureDevMode = 'plan';
  private _packageInfo: PackageInfo | null = null;
  private shellFeature?: SharedShellFeature;

  constructor(config: FeatureDevFeatureConfig = {}) {
    this.statePath = config.statePath || getDefaultStatePath();
    this.workspaceDir = config.workspaceDir || process.cwd();
    this.projectRoot = config.projectRoot || process.cwd();
    this.repositoryDir = config.repositoryDir || join(os.homedir(), USER_FEATURE_REPOSITORY_SUBPATH);
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

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    const shellFeature = ctx.getFeature<SharedShellFeature & AgentFeature>('shell');
    if (shellFeature?.run) {
      this.shellFeature = shellFeature;
    }
  }

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
        workspace: 'feature-creator',
        feature: 'feature-dev',
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

  async ensureProjectDocset(): Promise<void> {
    await Promise.all([
      fs.mkdir(getProjectDocsetDir(this.workspaceDir), { recursive: true }),
      fs.mkdir(getProjectDocsetFormsDir(this.workspaceDir), { recursive: true }),
      fs.mkdir(getProjectDocsetMaterialsDir(this.workspaceDir), { recursive: true }),
      fs.mkdir(getProjectDocsetConversationsDir(this.workspaceDir), { recursive: true }),
    ]);

    const legacyPlansDir = join(getProjectDocsetDir(this.workspaceDir), 'plans');
    try {
      const entries = await fs.readdir(legacyPlansDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const fromPath = join(legacyPlansDir, entry.name);
        const toPath = join(getProjectDocsetMaterialsDir(this.workspaceDir), entry.name);
        await fs.rename(fromPath, toPath).catch(async () => {
          const content = await fs.readFile(fromPath);
          await fs.writeFile(toPath, content);
          await fs.rm(fromPath, { force: true }).catch(() => {});
        });
      }
      await fs.rmdir(legacyPlansDir).catch(() => {});
    } catch {
      // Ignore missing legacy plans dir.
    }

    await fs.rm(join(getProjectDocsetDir(this.workspaceDir), 'tasks'), { recursive: true, force: true }).catch(() => {});

    const state = await this.readWorkspaceState();
    const startupForm = state?.forms?.['startup-form'] || {};
    const projectPath = join(getProjectDocsetDir(this.workspaceDir), 'project.json');
    const timestamp = new Date().toISOString();
    const projectRecord = {
      schemaVersion: 1,
      workspaceId: 'feature-creator',
      projectType: 'feature',
      projectName: cleanValue(startupForm.feature_name) || cleanValue(startupForm.featureName) || sanitizeProjectDocId(this.workspaceDir.split(/[\\/]/).pop() || 'feature'),
      openDirectory: this.workspaceDir,
      targetDir: cleanValue(startupForm.target_dir),
      goal: cleanValue(startupForm.goal),
      constraints: cleanValue(startupForm.constraints),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      const existing = await readJsonFile<Record<string, unknown>>(projectPath);
      projectRecord.createdAt = cleanValue(existing.createdAt) || timestamp;
    } catch {
      // Ignore missing project record.
    }
    await writeJsonFile(projectPath, projectRecord);

    if (startupForm && typeof startupForm === 'object' && Object.keys(startupForm).length > 0) {
      const formPath = join(getProjectDocsetFormsDir(this.workspaceDir), 'startup-form.json');
      const formRecord = {
        schemaVersion: 1,
        formId: 'startup-form',
        workspaceId: 'feature-creator',
        openDirectory: this.workspaceDir,
        payload: Object.fromEntries(
          Object.entries(startupForm)
            .map(([key, value]) => [String(key), String(value ?? '').trim()])
            .filter(([, value]) => value !== ''),
        ),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      try {
        const existing = await readJsonFile<Record<string, unknown>>(formPath);
        formRecord.createdAt = cleanValue(existing.createdAt) || timestamp;
      } catch {
        // Ignore missing form record.
      }
      await writeJsonFile(formPath, formRecord);
    }
  }

  async listProjectMaterials(): Promise<Array<{ id: string; title: string; preview: string; body: string; sourcePath: string; path: string; createdAt: string; updatedAt: string }>> {
    await this.ensureProjectDocset();
    try {
      const entries = await fs.readdir(getProjectDocsetMaterialsDir(this.workspaceDir), { withFileTypes: true });
      const materials = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .map(async (entry) => {
          const filePath = join(getProjectDocsetMaterialsDir(this.workspaceDir), entry.name);
          const stat = await fs.stat(filePath);
          const body = await fs.readFile(filePath, 'utf8');
          const lines = body.split(/\r?\n/).map((line) => line.trim());
          const heading = lines.find((line) => line.startsWith('# ')) || '';
          return {
            id: sanitizeProjectDocId(entry.name.replace(/\.md$/i, '')),
            title: heading ? heading.replace(/^#\s+/, '').trim() : entry.name.replace(/\.md$/i, ''),
            preview: lines.filter(Boolean).slice(1, 4).join(' ').slice(0, 180),
            body,
            sourcePath: extractMaterialSourcePath(body),
            path: filePath,
            createdAt: stat.birthtime.toISOString(),
            updatedAt: stat.mtime.toISOString(),
          };
        }));

      return materials.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    } catch {
      return [];
    }
  }

  async createMaterialDoc(input: { title: string; body: string }): Promise<{ id: string; title: string; body: string; path: string; createdAt: string; updatedAt: string }> {
    await this.ensureProjectDocset();
    const timestamp = new Date().toISOString();
    const id = buildProjectDocId('material', input.title, timestamp);
    const filePath = join(getProjectDocsetMaterialsDir(this.workspaceDir), `${id}.md`);
    const body = cleanValue(input.body);
    const markdown = [
      `# ${cleanValue(input.title) || id}`,
      '',
      `- createdAt: ${timestamp}`,
      '',
      body || '待补充',
      '',
    ].join('\n');
    await fs.writeFile(filePath, markdown, 'utf8');
    return {
      id,
      title: cleanValue(input.title) || id,
      body: markdown,
      path: filePath,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  getCurrentSessionId(): string {
    return sanitizeProjectDocId(cleanValue(process.env.PROTOCLAW_PREBUILT_SESSION_ID) || 'workspace');
  }

  async readCurrentConversationRecord(): Promise<ConversationRecord | null> {
    await this.ensureProjectDocset();
    const sessionId = this.getCurrentSessionId();
    const filePath = join(getProjectDocsetConversationsDir(this.workspaceDir), `${sessionId}.json`);
    try {
      return normalizeConversationRecord(await readJsonFile<Partial<ConversationRecord>>(filePath));
    } catch {
      return null;
    }
  }

  async listRecentConversationRecords(limit = 5): Promise<ConversationRecord[]> {
    await this.ensureProjectDocset();
    try {
      const entries = await fs.readdir(getProjectDocsetConversationsDir(this.workspaceDir), { withFileTypes: true });
      const records = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map(async (entry) => {
          const filePath = join(getProjectDocsetConversationsDir(this.workspaceDir), entry.name);
          const raw = await readJsonFile<Partial<ConversationRecord>>(filePath);
          return normalizeConversationRecord(raw);
        }));
      return records
        .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
        .slice(0, Math.max(1, limit));
    } catch {
      return [];
    }
  }

  async writeCurrentConversationRecord(input: {
    title?: string;
    summary: string;
    currentFocus?: string;
    nextActions?: string[];
    openQuestions?: string[];
    keyDecisions?: string[];
    relatedMaterialIds?: string[];
  }): Promise<ConversationRecord> {
    await this.ensureProjectDocset();
    const sessionId = this.getCurrentSessionId();
    const filePath = join(getProjectDocsetConversationsDir(this.workspaceDir), `${sessionId}.json`);
    const existing = await this.readCurrentConversationRecord();
    const timestamp = new Date().toISOString();
    const record = normalizeConversationRecord({
      ...(existing || {}),
      sessionId,
      title: cleanValue(input.title) || existing?.title || `conversation-${sessionId}`,
      summary: cleanValue(input.summary),
      currentFocus: cleanValue(input.currentFocus),
      nextActions: input.nextActions,
      openQuestions: input.openQuestions,
      keyDecisions: input.keyDecisions,
      relatedMaterialIds: input.relatedMaterialIds,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    });
    await writeJsonFile(filePath, record);
    return record;
  }

  getTools(): Tool[] {
    return [
      createTool({
        name: 'featuredev_set_mode',
        description: '切换 Feature 开发工作模式。可选 plan、code、debug、package。切换后返回该模式下应遵守的工作提示词。',
        parameters: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['plan', 'code', 'debug', 'package'],
              description: '要切换到的工作模式',
            },
          },
          required: ['mode'],
        },
        execute: async ({ mode }) => {
          const nextMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
          if (nextMode !== 'plan' && nextMode !== 'code' && nextMode !== 'debug' && nextMode !== 'package') {
            throw new Error('Invalid mode. Use one of: plan, code, debug, package.');
          }

          this.mode = nextMode as FeatureDevMode;
          const [conversationRecord, materials] = await Promise.all([
            this.readCurrentConversationRecord(),
            this.listProjectMaterials(),
          ]);
          const missingConversationWarning = !conversationRecord && this.mode !== 'plan'
            ? buildMissingConversationRecordWarning(this.mode)
            : '';
          const missingMaterialSuggestion = materials.length === 0 && this.mode === 'plan'
            ? '当前项目还没有资料文档。如果你已经形成稳定方案、接口说明或外部参考，请优先写一份 `featuredev_create_material_doc`。'
            : '';

          return {
            mode: this.mode,
            prompt: getModePrompt(this.mode),
            message: buildToolReinforcementMessage([
              missingConversationWarning,
              missingMaterialSuggestion,
              buildModeSwitchMessage(this.mode),
              '',
              '进入该模式后，不要把文档记录当成可选项。',
              '如果当前阶段已经有稳定结论但还没有推进记录或资料更新，先补文档，再继续。',
            ]),
            needsConversationRecord: !conversationRecord,
          };
        },
      }),
      createTool({
        name: 'featuredev_project_docset_summary',
        description: '读取当前 Feature 项目目录下的文档集摘要。主视角应理解为：唯一需求表单、推进记录、资料。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const [materials, state, conversationRecord] = await Promise.all([
            this.listProjectMaterials(),
            this.readWorkspaceState(),
            this.readCurrentConversationRecord(),
          ]);
          const startupForm = state?.forms?.['startup-form'] || {};
          return {
            projectDir: this.workspaceDir,
            sessionId: this.getCurrentSessionId(),
            conversationRecord,
            requirementForm: startupForm,
            materialCount: materials.length,
            materials,
          };
        },
      }),
      createTool({
        name: 'featuredev_read_conversation_record',
        description: '读取当前对话在项目级保存的推进记录。底层仍是 conversation record 文件，但这里应把它理解为跨对话可消费的工作日志。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async () => {
          const record = await this.readCurrentConversationRecord();
          return {
            sessionId: this.getCurrentSessionId(),
            record,
            message: record
              ? '已读取当前对话的项目级推进记录。继续推进前，请先对齐这份记录，再决定是否补充共享资料。'
              : '当前对话还没有项目级推进记录。只要你已经整理清楚现阶段结论，就应尽快写一份。'
          };
        },
      }),
      createTool({
        name: 'featuredev_write_conversation_record',
        description: '写入当前对话在项目级保存的推进记录。底层仍是 conversation record 文件，但这里应把它理解为供该项目后续对话消费的工作日志。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            currentFocus: { type: 'string' },
            keyDecisions: {
              type: 'array',
              items: { type: 'string' },
            },
            nextActions: {
              type: 'array',
              items: { type: 'string' },
            },
            openQuestions: {
              type: 'array',
              items: { type: 'string' },
            },
            relatedMaterialIds: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['summary'],
        },
        execute: async ({ title, summary, currentFocus, keyDecisions, nextActions, openQuestions, relatedMaterialIds }) => {
          const record = await this.writeCurrentConversationRecord({
            title: cleanValue(title),
            summary: cleanValue(summary),
            currentFocus: cleanValue(currentFocus),
            keyDecisions: Array.isArray(keyDecisions) ? keyDecisions.map((value) => String(value ?? '')) : [],
            nextActions: Array.isArray(nextActions) ? nextActions.map((value) => String(value ?? '')) : [],
            openQuestions: Array.isArray(openQuestions) ? openQuestions.map((value) => String(value ?? '')) : [],
            relatedMaterialIds: Array.isArray(relatedMaterialIds) ? relatedMaterialIds.map((value) => String(value ?? '')) : [],
          });
          return {
            message: buildToolReinforcementMessage([
              '已写入当前对话的项目级推进记录。',
              '后续如有新的稳定结论，请继续增量更新这份推进记录，而不是把临时想法直接写进共享资料。',
              '如果某项结论已经跨对话稳定，再考虑补资料文档。',
            ]),
            record,
          };
        },
      }),
      createTool({
        name: 'featuredev_create_material_doc',
        description: '在当前项目文档集中创建一份 Markdown 资料文档。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['title', 'body'],
        },
        execute: async ({ title, body }) => {
          const material = await this.createMaterialDoc({
            title: cleanValue(title),
            body: cleanValue(body),
          });
          return {
            message: buildToolReinforcementMessage([
              '已创建资料文档。',
              '资料属于项目共享文档，只应保存跨对话稳定内容，比如 AI 方案书、外部文档摘要、参考说明或路径引用。',
              '如果这次资料来自本轮新整理出的稳定结论，请同步补一条推进记录，说明它是在什么背景下形成的。',
            ]),
            material,
          };
        },
      }),
      createTool({
        name: 'featuredev_list_material_docs',
        description: '列出当前项目文档集中的资料摘要。',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number' },
          },
        },
        execute: async ({ limit }) => {
          const materials = await this.listProjectMaterials();
          const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 10;
          return {
            count: materials.length,
            items: materials.slice(0, safeLimit),
          };
        },
      }),
      createTool({
        name: 'featuredev_validate',
        description: '验证当前 Feature 项目的结构、导出和接口合规性。会自动构建（如果编译产物不存在），然后检查 Feature 类导出、工具定义、钩子注册等。返回结构化的验证报告。',
        parameters: {
          type: 'object',
          properties: {
            build: {
              type: 'boolean',
              description: '是否在验证前自动构建（如果编译产物不存在）。默认 true。',
            },
          },
        },
        execute: async ({ build }) => {
          if (!this.shellFeature) {
            throw new Error('当前 Agent 未挂载 shell feature，无法执行验证。');
          }

          const packageJsonPath = join(this.workspaceDir, 'package.json');
          if (!await fileExists(packageJsonPath)) {
            throw new Error(`当前工作目录不是 Feature 项目，缺少 package.json: ${this.workspaceDir}`);
          }

          const shouldBuild = build !== false;
          const pkg = await readJsonFile<Record<string, unknown>>(packageJsonPath);
          const mainEntry = typeof pkg.main === 'string' ? pkg.main.trim() : 'dist/index.js';
          const distPath = join(this.workspaceDir, mainEntry);

          if (shouldBuild && !await fileExists(distPath)) {
            const hasBuildScript = pkg.scripts && typeof (pkg.scripts as Record<string, unknown>).build === 'string';
            if (hasBuildScript) {
              await runShellFeatureCommand(this.shellFeature, 'npm run build');
            }
          }

          if (!await fileExists(VALIDATE_SCRIPT_PATH)) {
            throw new Error(`验证脚本不存在: ${VALIDATE_SCRIPT_PATH}`);
          }

          let output: string;
          try {
            output = await runShellFeatureCommand(
              this.shellFeature,
              `node "${VALIDATE_SCRIPT_PATH}" "${this.workspaceDir}"`,
            );
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(`验证脚本执行失败: ${message}`);
          }

          let report: Record<string, unknown>;
          try {
            report = JSON.parse(output);
          } catch {
            throw new Error(`验证脚本输出不是合法 JSON: ${output.slice(0, 500)}`);
          }

          const lines: string[] = [];
          const valid = report.valid === true;
          const summary = report.summary as Record<string, number> | undefined;
          const reportErrors = Array.isArray(report.errors) ? report.errors as string[] : [];
          const reportWarnings = Array.isArray(report.warnings) ? report.warnings as string[] : [];
          const reportTools = Array.isArray(report.tools) ? report.tools as string[] : [];
          const reportHooks = Array.isArray(report.hooks) ? report.hooks as Array<{ lifecycle: string; method: string }> : [];

          lines.push(valid ? 'Feature 验证通过' : 'Feature 验证未通过');
          lines.push('');
          if (summary) {
            lines.push(`检查项: ${summary.passed}/${summary.total} 通过`);
          }

          if (reportErrors.length > 0) {
            lines.push('', '### 必须修复', '', ...reportErrors.map((e) => `- ${e}`));
          }

          if (reportWarnings.length > 0) {
            lines.push('', '### 建议改进', '', ...reportWarnings.map((w) => `- ${w}`));
          }

          if (reportTools.length > 0) {
            lines.push('', `工具: ${reportTools.join(', ')}`);
          }

          if (reportHooks.length > 0) {
            lines.push('', `钩子: ${reportHooks.map((h) => `@${h.lifecycle} → ${h.method}`).join('; ')}`);
          }

          if (!valid) {
            lines.push('', '请根据上述错误修复代码，然后重新调用 `featuredev_validate` 验证。');
          }

          return {
            ...report,
            message: lines.join('\n'),
          };
        },
      }),
      createTool({
        name: 'featuredev_package_to_repository',
        description: '在当前 Feature 工作目录中自动补齐 agentdev-feature.json，执行构建与 npm pack，并将最终产物写入当前系统托管的 Feature 仓库。\n\nfeatureTypes 字段说明：\n- tools：自动推断。检测 getTools() 或 getAsyncTools() 方法\n- hooks：自动推断。检测反向钩子装饰器（@CallStart/@CallEnd/@CallFinish/@ToolUse/@StepFinish）或 lifecycle methods（onInitiate/onDestroy）\n- mcp：自动推断。检测 getMcpServers() 或 McpFeature 相关代码\n- rollback：自动推断。只有实现了 rollback 相关方法（captureState/restoreState/beforeRollback/afterRollback）时才标记\n- control：需手动选择。表示有流程控制功能（如阻断工具调用 Decision.Deny）或提供主动调用接口（适合在宿主 agent/复杂工作流中作为外部整体流程使用）',
        parameters: {
          type: 'object',
          properties: {
            featureTypes: {
              type: 'array',
              description: '可选。补充或覆盖 feature 类型标签。tools/hooks/mcp/rollback 会自动推断，control 需要手动指定。',
              items: {
                type: 'string',
                enum: [...FEATURE_TYPE_VALUES],
              },
            },
            control: {
              type: 'boolean',
              description: '可选。显式声明是否为 control 类型。表示有流程控制功能（如阻断工具调用 Decision.Deny）或提供主动调用接口（适合在宿主 agent/复杂工作流中作为外部整体流程使用）。',
            },
            rollback: {
              type: 'boolean',
              description: '可选。显式声明是否支持 rollback。用于覆盖自动推断结果。',
            },
            overwrite: {
              type: 'boolean',
              description: '系统仓库中已有同名 tgz 时是否覆盖。默认 true。',
            },
          },
        },
        execute: async ({ featureTypes, control, rollback, overwrite }) => {
          if (this.mode !== 'package') {
            throw new Error('`featuredev_package_to_repository` 只能在 PACKAGE 模式下使用。请先调用 `featuredev_set_mode` 切换到 `package`。');
          }
          if (!this.shellFeature) {
            throw new Error('当前 Agent 未挂载可复用的 shell feature，无法继续打包。');
          }

          const packageJsonPath = join(this.workspaceDir, 'package.json');
          const manifestPath = join(this.workspaceDir, FEATURE_MANIFEST_NAME);

          if (!await fileExists(packageJsonPath)) {
            throw new Error(`当前工作目录不是可打包的 Feature 项目，缺少 package.json: ${packageJsonPath}`);
          }

          const pkg = await readJsonFile<Record<string, unknown>>(packageJsonPath);
          if (typeof pkg.name !== 'string' || !pkg.name.trim()) {
            throw new Error('package.json 缺少有效的 name，无法打包 Feature。');
          }
          if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
            throw new Error('package.json 缺少有效的 version，无法打包 Feature。');
          }

          const existingManifest = await fileExists(manifestPath)
            ? await readJsonFile<Record<string, unknown>>(manifestPath)
            : null;

          // 处理 featureTypes：合并自动推断和用户输入
          let finalTypes = normalizeFeatureTypes(featureTypes);

          // 如果用户显式指定了 control，添加到类型列表
          if (control === true && !finalTypes.includes('control')) {
            finalTypes = [...finalTypes, 'control'];
          } else if (control === false) {
            finalTypes = finalTypes.filter(t => t !== 'control');
          }

          const manifest = await mergeFeatureManifest(pkg, existingManifest, {
            featureTypes: finalTypes,
            rollback: typeof rollback === 'boolean' ? rollback : undefined,
          }, this.workspaceDir);

          await writeJsonFile(manifestPath, manifest);
          const packageJsonUpdated = await ensurePackageIncludesManifest(packageJsonPath, pkg);
          const packageJsonBeforeCompatibility = packageJsonUpdated
            ? await readJsonFile<Record<string, unknown>>(packageJsonPath)
            : pkg;
          const packagingCompatibility = await stripMissingTemplateEntryFromPackageJson(
            packageJsonPath,
            packageJsonBeforeCompatibility,
            this.workspaceDir,
          );
          const packageJsonAfter = (packageJsonUpdated || packagingCompatibility.changed)
            ? await readJsonFile<Record<string, unknown>>(packageJsonPath)
            : packageJsonBeforeCompatibility;

          if (packageJsonAfter.scripts && typeof packageJsonAfter.scripts === 'object' && typeof (packageJsonAfter.scripts as Record<string, unknown>).build === 'string') {
            await runShellFeatureCommand(this.shellFeature, 'npm run build');
          }

          const packResult = await runShellFeatureCommand(this.shellFeature, 'npm pack --json');
          const archiveName = parsePackArchiveName(packResult);

          const localArchivePath = join(this.workspaceDir, archiveName);
          if (!await archiveContainsManifest(localArchivePath, this.workspaceDir)) {
            await injectManifestIntoArchive(localArchivePath, manifest, this.workspaceDir);
          }

          const resolvedRepositoryDir = this.repositoryDir;
          await fs.mkdir(resolvedRepositoryDir, { recursive: true });

          const targetArchivePath = join(resolvedRepositoryDir, archiveName);
          const shouldOverwrite = typeof overwrite === 'boolean' ? overwrite : true;
          if (!shouldOverwrite && await fileExists(targetArchivePath)) {
            throw new Error(`系统仓库中已存在同名 tgz，且 overwrite=false。`);
          }

          await fs.copyFile(localArchivePath, targetArchivePath);
          await fs.rm(localArchivePath, { force: true }).catch(() => {});

          return {
            featureName: manifest.name,
            packageName: pkg.name,
            version: pkg.version,
            workspaceDir: this.workspaceDir,
            manifestPath,
            archiveName,
            featureTypes: manifest.featureTypes,
            compatibility: manifest.compatibility,
            packageJsonUpdated,
            packagingCompatibility,
            delivery: {
              systemManaged: true,
              visibleIn: ['用户 Feature 目录', '当前系统中的 Feature 使用入口'],
            },
            message: '已完成打包并写入用户 Feature 目录。',
          };
        },
      }),
    ];
  }

  getStatePath(): string {
    return this.statePath;
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
    if (!state) {
      return '';
    }
    return buildWorkspaceMarkdown(state, cwd);
  }

  @CallStart
  async injectWorkspaceState(ctx: import('agentdev').CallStartContext): Promise<void> {
    // 每轮对话都注入当前工作模式提示词
    const modePrompt = getModePrompt(this.mode);
    if (modePrompt) {
      ctx.context.add({ role: 'system', content: modePrompt });
    }

    const [conversationRecord, recentRecords] = await Promise.all([
      this.readCurrentConversationRecord(),
      this.listRecentConversationRecords(5),
    ]);
    if (!conversationRecord && this.mode !== 'plan') {
      ctx.context.add({
        role: 'system',
        content: buildMissingConversationRecordWarning(this.mode),
      });
    }

    // 首次对话时额外注入工作空间状态
    if (ctx.isFirstCall) {
      const [markdown, materials, recentRecords] = await Promise.all([
        this.buildWorkspaceMarkdown(this.workspaceDir),
        this.listProjectMaterials(),
        this.listRecentConversationRecords(5),
      ]);
      if (markdown) {
        ctx.context.add({ role: 'system', content: markdown });
      }

      const startupForm = (await this.readWorkspaceState())?.forms?.['startup-form'] || {};
      const docsetSummaryMarkdown = [
        '## 当前项目文档集摘要',
        '',
        `- 项目目录: ${this.workspaceDir}`,
        `- 需求是否已填写: ${Object.keys(startupForm).length > 0 ? '是' : '否'}`,
        `- 当前对话是否已有推进记录: ${conversationRecord ? '是' : '否'}`,
        `- 项目最近推进记录数量: ${recentRecords.length}`,
        '- 推进记录顺序: 按更新时间从新到旧逆序阅读',
        `- 资料数量: ${materials.length}`,
        materials.length > 0 ? `- 最近资料路径: ${materials.slice(0, 3).map((item) => item.sourcePath || item.path).filter(Boolean).join('；')}` : '',
      ].filter(Boolean).join('\n');
      ctx.context.add({ role: 'system', content: docsetSummaryMarkdown });

      if (recentRecords.length > 0) {
        const recentRecordsMarkdown = [
          '## 最近的项目级推进记录时间线（最多 5 条，按更新时间从新到旧）',
          '',
          ...recentRecords.map((record, index) => buildConversationRecordMarkdown(record, `推进记录 ${index + 1} · ${record.updatedAt}`)),
        ].join('\n\n');
        ctx.context.add({ role: 'system', content: recentRecordsMarkdown });
      }
    }
  }

  @ToolUse
  async guardEditToolInPlanMode(ctx: import('agentdev').ToolContext): Promise<import('agentdev').DecisionResult> {
    if (ctx.call.name === 'featuredev_package_to_repository' && this.mode !== 'package') {
      const message = [
        '当前不在 PACKAGE 模式，不能直接执行打包入库。',
        '请先确认实现和文档都稳定，再调用 `featuredev_set_mode` 切换到 `package` 模式。',
      ].join('\n');
      ctx.context.add({ role: 'system', content: message });
      return {
        action: Decision.Deny,
        reason: message,
      };
    }

    if (this.mode !== 'plan') {
      return Decision.Continue;
    }

    if (ctx.call.name !== 'edit') {
      return Decision.Continue;
    }

    const message = [
      '当前处于 PLAN 模式，不能直接进行文件编辑。',
      '请先完成分析和方案确认；如果确实要开始写代码，请先调用 `featuredev_set_mode` 切换到 `code` 模式。',
    ].join('\n');

    ctx.context.add({ role: 'system', content: message });
    return {
      action: Decision.Deny,
      reason: message,
    };
  }

  captureState(): FeatureStateSnapshot {
    const snapshot: FeatureDevSnapshot = {
      mode: this.mode,
    };
    return snapshot;
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as FeatureDevSnapshot | undefined;
    if (state?.mode === 'plan' || state?.mode === 'code' || state?.mode === 'debug' || state?.mode === 'package') {
      this.mode = state.mode;
    }
  }

  getHookDescription(lifecycle: string, methodName: string): string | undefined {
    if (lifecycle === 'CallStart' && methodName === 'injectWorkspaceState') {
      return '在每轮开始时注入当前工作模式提示；首次对话时额外读取 feature-creator 工作空间状态，并以 Markdown 注入系统上下文。';
    }
    if (lifecycle === 'ToolUse' && methodName === 'guardEditToolInPlanMode') {
      return '在 plan 模式下拦截 edit 工具，防止未确认方案前直接改文件。';
    }
    return undefined;
  }
}
