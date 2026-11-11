/**
 * CraftAwarenessFeature — 工程素养提醒
 *
 * 系统提示词里的通用写作准则（如"成品视角"）埋在长文本中，模型注意力被稀释，
 * 实际收效甚微。本 feature 改为在"模型正在做这件事"的那一刻注入一条聚焦的
 * 提醒——时机对了，注意力才在。
 *
 * 机制与内容分离：
 * - 机制在代码里：条目（CraftEntry）声明触发判定（什么时机注入）；
 * - 内容在 knowledge/ 目录：每个条目一份 `<id>.md`（注入什么），md 只维护
 *   正文，`[工程素养] ` 前缀由代码统一添加。改文案只需改 md 并重启 agent。
 *   构建时 knowledge/ 随 skills 同款机制拷入 dist（copy-local-feature-skills.mjs）。
 *
 * 普通提醒的冷却按条目 id 记账（每会话每条目一次）。完成承接提醒不走这套
 * 永久冷却，而是按 Todo 从未完成状态进入 completed 的真实状态转换触发。新增
 * 普通素养提醒 = 代码加条目 + knowledge 放对应 md，机制不动。
 *
 * 技能携带（skills/ 目录）：本 feature 同时是 grill-me 技能（设计树拷问与执行期回溯）
 * 的载具——框架 collectFeatureSkills 按 dirname(source)/skills 约定自动
 * 发现并注入系统提示词，构建时随 knowledge 同款机制拷入 dist
 * （copy-local-feature-skills.mjs）。技能随 feature 装配走，不依赖工作
 * 目录的 .agentdev/skills。
 *
 * 条目 handoff-context-calibration：不经本 feature 运行时注入——文案经
 * readHandoffCalibrationContent() 供宿主读取，装配 HandoffSeedFeature 时经
 * appendix 配置挂入接续管道，在 seed 注入事务末尾确定性注入。普通新会话、
 * 快照恢复及无 seed 的 handoff 天然不触发（无注入路径）。
 *
 * - 条目 todo-completion-reflection：Todo 工具成功把 pending/in_progress 任务推进为
 *   completed 后，在下一步 StepStart 注入一条结合任务 kind、描述与交付物的承接提醒。
 *   ToolUse 只记录候选，ToolFinished 确认成功状态，下一步 StepStart 合并同一步的多个完成项；
 *   不把重复完成、失败更新或删除任务算作完成，也不要求模型立即复盘或追加验收。
 *
 * 条目一 doc-reader-awareness：write 写出成规模的文档文件（markdown/txt，
 * 默认 ≥30 行）或 edit 编辑此类文件成功后，注入"文档读者视角"写法标准。
 * write 设规模阈值是为了排除随手写的短 note；edit 本身就是改已有文档，不看规模。
 *
 * 条目二 doc-delivery-mode：同一文档的修改跨越 ≥2 个用户输入边界、且当前
 * 动作是 edit 时，注入"协作态/交付态"阶段判断提醒。"用户输入边界"以 context
 * 中最近一条 role=user 消息的 sequence 标识（事实层判定）：新 call 的输入与
 * busy 时排队注入的插话（react-loop 在 call 内注入，不触发 CallStart，事件层
 * 不可见）都是一条新 user 消息，事实层统一覆盖；同一用户输入内的连续修改
 * （模型自我更正）不累计。边界记账不随快照持久化——会话恢复后清零，最多
 * 少注入一次，无正确性影响。
 *
 * 测试条目：成功 write/edit 的文件名命中测试命名模式时，按同文件修改次数递进：
 * 首次注入行为契约，第二次且为 edit 注入辨别能力，第三次且为 edit 注入验证交付。
 * 同一用户输入内也递进；每条每会话一次，前层未注入不越级。文件进度随快照持久化。
 *
 * 冷却状态不自行落盘：经框架原生 feature 快照契约（captureState / restoreState）
 * 随会话快照持久化，会话恢复（含 runtime 重启）后同一会话不重复提醒。
 *
 * observe 语义：注入失败不阻断工具结果，只降级为本轮不注入。
 */

import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { AgentFeature, FeatureInitContext, FeatureStateSnapshot, HookDeclarations } from '@agentdevjs/core';
import type { Context, StepStartContext, ToolContext, ToolFinishedDecisionContext } from '@agentdevjs/core';
import { CoreLifecycle } from '@agentdevjs/core';

type CompletionKind = 'investigate' | 'design' | 'implement' | 'fix' | 'verify' | 'other';
type CompletionStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

interface TodoCompletionTask {
  id: string;
  subject: string;
  description?: string;
  deliver?: string;
  kind?: CompletionKind;
  status: CompletionStatus;
}

interface TodoCompletionCandidate {
  callId: string;
  step: number;
  taskId: string;
}

const TODO_TOOL_NAME = 'task_update';
const TODO_COMPLETION_ENTRY_ID = 'todo-completion-reflection';
const TODO_COMPLETION_KIND_IDS = ['investigate', 'design', 'implement', 'fix', 'verify', 'other'] as const;
const COMPLETION_SUBJECT_MAX_LENGTH = 160;
const COMPLETION_DESCRIPTION_MAX_LENGTH = 500;
const COMPLETION_DELIVER_MAX_LENGTH = 300;

const __filename = fileURLToPath(import.meta.url);

/** write 触发的最小行数：低于此值视为随手短记，不打断。 */
export const DOC_CRAFT_MIN_WRITE_LINES = 30;

/** 文档类扩展名（小写匹配）。 */
const DOC_CRAFT_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

/** 源码编辑触发回溯提醒；文档、测试、配置等由各自的素养条目处理。 */
const SOURCE_CODE_EXTENSIONS = [
  '.c', '.cc', '.cpp', '.cs', '.go', '.java', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.ts', '.tsx', '.mts', '.cts', '.php', '.rb', '.swift', '.kt',
] as const;

/** 注入文本的统一前缀（体系标识，不进 md——md 只维护正文）。 */
const CRAFT_PREFIX = '[工程素养] ';

/** 触发判定的最小事件形状（纯函数输入，便于测试）。 */
export interface CraftToolEvent {
  toolName: string;
  args: Record<string, unknown> | null | undefined;
  success: boolean;
}

/** write/edit 的路径参数有历史别名（filePath/filepath/path），逐一容错读取。 */
function readPathArg(args: Record<string, unknown> | null | undefined): string {
  for (const key of ['filePath', 'filepath', 'path']) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

// 仅匹配 basename；CamelCase 后缀保留大小写，避免把 contest.js 等普通文件当作测试。
const TEST_FILE_NAME = /^(?:test_.*|.*_test\..*|.*\.test\..*|.*\.spec\..*|.*(?:Test|Tests|TestCase|Spec)\..*)$/;
const TEST_CRAFT_LAYERS = [
  { id: 'test-behavior-contract', description: '测试行为契约：从需求确定可观察结果', minChanges: 1 },
  { id: 'test-discriminating-power', description: '测试辨别能力：能抓住错误且不绑定内部实现', minChanges: 2 },
  { id: 'test-verification-delivery', description: '测试验证交付：运行、归因与真实证据', minChanges: 3 },
] as const;

function readTestFilePath(event: CraftToolEvent): string {
  if (event.success !== true || (event.toolName !== 'write' && event.toolName !== 'edit')) return '';
  const filePath = readPathArg(event.args);
  const name = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
  return TEST_FILE_NAME.test(name) ? filePath : '';
}

function isDocFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return DOC_CRAFT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 判断成功写入或编辑的是否为源码文件。 */
function isSourceCodeFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? '';
  const pathSegments = normalized.toLowerCase().split('/');
  if (pathSegments.some((segment) => ['test', 'tests', '__tests__'].includes(segment)) || TEST_FILE_NAME.test(basename)) return false;
  const lower = basename.toLowerCase();
  return SOURCE_CODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Todo 中可能改变计划含义的字段更新；纯状态流转不触发。 */
function isTodoPlanDefinitionUpdate(event: CraftToolEvent): boolean {
  if (event.success !== true) return false;
  if (event.toolName === 'task_clear') return true;
  if (event.toolName !== 'task_update') return false;
  const args = event.args && typeof event.args === 'object' ? event.args : {};
  return ['subject', 'description', 'deliver', 'kind'].some((key) => Object.hasOwn(args, key)) || args.status === 'deleted';
}

/** 源码落盘或 Todo 定义变更后，提示模型沿已定目标与设计回溯。 */
export function shouldRemindDesignTrace(event: CraftToolEvent): boolean {
  if (!event || event.success !== true) return false;
  if (isTodoPlanDefinitionUpdate(event)) return true;
  if (event.toolName !== 'write' && event.toolName !== 'edit') return false;
  const filePath = readPathArg(event.args);
  return Boolean(filePath && isSourceCodeFile(filePath));
}

/**
 * 文档条目触发判定（纯函数）：
 * - 只看成功完成的 write/edit（失败调用文件未落盘，提醒不成立）；
 * - write 要求文档扩展名且 content ≥ DOC_CRAFT_MIN_WRITE_LINES 行；
 * - edit 只要求文档扩展名（编辑本身就是对已有文档的改写）。
 */
export function shouldRemindDocCraft(event: CraftToolEvent): boolean {
  if (!event || event.success !== true) return false;
  if (event.toolName !== 'write' && event.toolName !== 'edit') return false;
  const args = event.args && typeof event.args === 'object' ? event.args : {};
  const filePath = readPathArg(args);
  if (!filePath || !isDocFile(filePath)) return false;
  if (event.toolName === 'write') {
    const content = args.content;
    if (typeof content !== 'string') return false;
    if (content.split('\n').length < DOC_CRAFT_MIN_WRITE_LINES) return false;
  }
  return true;
}

/** 边界探测回看的消息条数：长 ReAct 链中间没有用户消息是常态，给足余量。 */
export const USER_BOUNDARY_SCAN_LIMIT = 200;

/**
 * 用户输入边界标识（纯函数）：取 context 中最近一条 role=user 消息的 sequence。
 * 新 call 的用户输入与 busy 时排队注入的插话（不触发 CallStart）在事实层都是
 * 一条新 user 消息，统一以本函数探测——这是"用户有新输入"的唯一完备信号。
 * 找不到 user 消息返回 null（null 也参与相等比较，防御性兜底不抛错）。
 */
export function readLastUserBoundary(context: Context): number | null {
  try {
    const recent = context.getRecent(USER_BOUNDARY_SCAN_LIMIT);
    for (let i = recent.length - 1; i >= 0; i--) {
      const msg = recent[i] as { role?: unknown; sequence?: unknown };
      if (msg?.role === 'user' && typeof msg.sequence === 'number') return msg.sequence;
    }
  } catch {
    /* 兜底 null */
  }
  return null;
}

/** 文档路径轻归一化：分隔符统一为 / 并小写（Windows 大小写与分隔符漂移容错），不做 fs IO。 */
function normalizeDocPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

/**
 * 加载知识库目录：`<条目id>.md` 全文（去尾部空白）即该条目注入正文。
 * 目录不存在或读失败返回空 map——对应条目注入时跳过（warn），不注入错误内容。
 */
export function loadKnowledgeDir(dir: string): Map<string, string> {
  const knowledge = new Map<string, string>();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -'.md'.length);
      if (!id) continue;
      knowledge.set(id, readFileSync(join(dir, entry.name), 'utf8').trim());
    }
  } catch {
    /* 目录缺失/不可读：空知识库，注入时逐条目 warn */
  }
  return knowledge;
}

/**
 * 接续校准文案（含 [工程素养] 前缀）。
 *
 * 宿主装配 HandoffSeedFeature 时读取并经 appendix 配置挂入接续管道，在
 * seed 注入事务末尾确定性注入——本 feature 不在运行时探测接续（历史实现
 * 经 StepStart ctx.agent.getFeature 读注入账目，但该上下文的 agent 是
 * 受限 facade、无 getFeature，从未生效，已移除）。
 * 目录缺失或条目不存在返回 null，宿主据此跳过 appendix。
 */
export function readHandoffCalibrationContent(knowledgeDir?: string): string | null {
  const dir = knowledgeDir ?? join(dirname(__filename), 'knowledge');
  const content = loadKnowledgeDir(dir).get('handoff-context-calibration');
  return content ? CRAFT_PREFIX + content : null;
}

/**
 * 取当前 call 的轮次号：ToolFinished 通知在工具结果写入 context 之后触发，
 * 最近一条消息（即刚写入的工具结果）的 turn 就是当前轮次；取不到时兜底 0。
 */
function readCurrentTurn(context: Context): number {
  try {
    const recent = context.getRecent(1);
    const turn = recent.length > 0 ? (recent[0] as { turn?: unknown })?.turn : undefined;
    if (typeof turn === 'number') return turn;
  } catch {
    /* 兜底 0 */
  }
  return 0;
}

/**
 * 素养条目：触发判定在代码，文案在 knowledge/<id>.md。冷却以 id 为键（每会话每条目一次）。
 * match 收到 feature 实例，供需要记账状态的条目（如 doc-delivery-mode）查询。
 */
interface CraftEntry {
  id: string;
  description: string;
  match: (ctx: ToolFinishedDecisionContext, feature: CraftAwarenessFeature) => boolean;
}

const CRAFT_ENTRIES: readonly CraftEntry[] = [
  ...TEST_CRAFT_LAYERS.map((layer, index): CraftEntry => ({
    id: layer.id,
    description: layer.description,
    match: (ctx, feature) => feature.shouldRemindTestLayer(ctx, index),
  })),
  {
    id: 'design-trace-reflection',
    description: 'Todo 定义或源码改动后的目标关系与行为影响反思',
    match: (ctx) => shouldRemindDesignTrace({
      toolName: ctx.toolName,
      args: ctx.call?.arguments,
      success: ctx.success === true,
    }),
  },
  {
    id: 'doc-reader-awareness',
    description: '文档读者视角：首次写出成规模文档后注入写法标准',
    match: (ctx) => shouldRemindDocCraft({
      toolName: ctx.toolName,
      args: ctx.call?.arguments,
      success: ctx.success === true,
    }),
  },
  {
    id: 'doc-delivery-mode',
    description: '交付模式判断：文档修改跨越两个用户输入边界后的编辑注入阶段切换判断',
    match: (ctx, feature) => feature.shouldRemindDeliveryMode(ctx),
  },
];

export class CraftAwarenessFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    resetTodoCompletionState: { lifecycle: CoreLifecycle.CallStart, kind: 'observe' as const },
    recordTodoCompletionCandidate: { lifecycle: CoreLifecycle.ToolUse, kind: 'observe' as const },
    confirmTodoCompletion: { lifecycle: CoreLifecycle.ToolFinished, kind: 'observe' as const },
    injectTodoCompletionReflection: { lifecycle: CoreLifecycle.StepStart, kind: 'observe' as const },
    injectCraftReminder: { lifecycle: CoreLifecycle.ToolFinished, kind: 'observe' as const },
  };

  readonly name = 'craft-awareness';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '按接续及文档、测试和源码改动时机注入工程素养提醒；并携带 grill-me 技能。';

  /** 普通素养条目已注入记账（id → true），随会话快照持久化；完成承接提醒不使用此表。 */
  private injectedEntries: Record<string, true> = {};
  /** 当前 Step 中成功推进到 completed 的任务候选，按工具调用确认后消费。 */
  private todoCompletionCandidates = new Map<string, TodoCompletionCandidate>();
  /** 当前 Step 的临时标识；完成提醒不跨 Step 暂存。 */
  private todoCompletionStep: number | undefined;
  /** 当前 Step 已确认完成的任务，下一步开始时合并注入后清空。 */
  private completedTodoTasks = new Map<string, TodoCompletionTask>();
  /** 条目 id → 注入正文（构造时从 knowledge 目录加载一次）。 */
  private readonly knowledge: Map<string, string>;
  /**
   * 文档修改的边界记账：归一化路径 → 最近边界标识与已跨越边界数。
   * 不随快照持久化——会话恢复后清零，最多少注入一次，无正确性影响。
   */
  private readonly docBoundaries = new Map<string, { lastBoundary: number | null; boundaryCount: number }>();
  /** 同一测试文件的成功修改次数，达到最深层后封顶，随快照恢复。 */
  private readonly testFileChanges = new Map<string, number>();
  private logger?: FeatureInitContext['logger'];

  constructor(config: { knowledgeDir?: string } = {}) {
    const defaultDir = join(dirname(__filename), 'knowledge');
    this.knowledge = loadKnowledgeDir(config.knowledgeDir ?? defaultDir);
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
  }

  /** 每个 Call 开始时清理未完成的临时候选，避免跨 Call 误认。 */
  async resetTodoCompletionState(): Promise<void> {
    this.todoCompletionStep = undefined;
    this.todoCompletionCandidates.clear();
    this.completedTodoTasks.clear();
  }

  /**
   * 文档修改边界记账（每次成功的文档 write/edit 后、条目判定前调用）：
   * 以"最近一条用户消息的 sequence"为边界标识。同一用户输入内的连续修改
   * （模型自我更正）标识不变、不累计；跨越边界（新 call 输入或 busy 排队
   * 插话）计一次。注意：与文档无关的用户插话也会推进边界——保守计数，
   * 阈值 2 与条目文案的安全阀兜底。
   */
  private trackDocBoundary(ctx: ToolFinishedDecisionContext): void {
    if (ctx.success !== true) return;
    if (ctx.toolName !== 'write' && ctx.toolName !== 'edit') return;
    const args = ctx.call?.arguments && typeof ctx.call.arguments === 'object' ? ctx.call.arguments : {};
    const filePath = readPathArg(args);
    if (!filePath || !isDocFile(filePath)) return;
    const key = normalizeDocPath(filePath);
    const boundary = readLastUserBoundary(ctx.context);
    const record = this.docBoundaries.get(key);
    if (!record) {
      this.docBoundaries.set(key, { lastBoundary: boundary, boundaryCount: 1 });
      return;
    }
    if (record.lastBoundary !== boundary) {
      record.lastBoundary = boundary;
      record.boundaryCount += 1;
    }
  }

  /** doc-delivery-mode 条目判定：edit 动作 + 该文档修改已跨越 ≥2 个用户输入边界。 */
  shouldRemindDeliveryMode(ctx: ToolFinishedDecisionContext): boolean {
    if (ctx.toolName !== 'edit' || ctx.success !== true) return false;
    const args = ctx.call?.arguments && typeof ctx.call.arguments === 'object' ? ctx.call.arguments : {};
    const filePath = readPathArg(args);
    if (!filePath || !isDocFile(filePath)) return false;
    const record = this.docBoundaries.get(normalizeDocPath(filePath));
    return (record?.boundaryCount ?? 0) >= 2;
  }

  private trackTestChanges(ctx: ToolFinishedDecisionContext): void {
    const filePath = readTestFilePath({ toolName: ctx.toolName, args: ctx.call?.arguments, success: ctx.success === true });
    if (!filePath || this.injectedEntries[TEST_CRAFT_LAYERS[TEST_CRAFT_LAYERS.length - 1].id]) return;
    const key = normalizeDocPath(filePath);
    this.testFileChanges.set(key, Math.min((this.testFileChanges.get(key) ?? 0) + 1, TEST_CRAFT_LAYERS.length));
  }

  /**
   * 在一个 ReAct Step 开始处理 Todo 工具时清理上一个 Step 的临时完成记录。
   * 这些记录只服务于“本步完成、下一步开始时合并注入”，不进入会话快照。
   */
  private prepareTodoCompletionStep(step: number): void {
    if (this.todoCompletionStep === step) return;
    this.todoCompletionStep = step;
    this.todoCompletionCandidates.clear();
    this.completedTodoTasks.clear();
  }

  /** 从工具上下文取得 Todo feature；不存在时不参与完成提醒。 */
  private readTodoFeature(ctx: { getFeature?: (name: string) => unknown }): {
    getTask?: (taskId: string) => TodoCompletionTask | undefined;
  } | undefined {
    if (typeof ctx.getFeature !== 'function') return undefined;
    const todo = ctx.getFeature('todo');
    return todo && typeof todo === 'object'
      ? todo as { getTask?: (taskId: string) => TodoCompletionTask | undefined }
      : undefined;
  }

  /**
   * ToolUse 只记录候选，不提前认定完成：只有工具成功返回且 Todo feature 的真实状态
   * 已经变成 completed，才会进入下一步 StepStart 的承接提醒。
   */
  async recordTodoCompletionCandidate(ctx: ToolContext): Promise<void> {
    try {
      if (ctx.call?.name !== TODO_TOOL_NAME) return;
      this.prepareTodoCompletionStep(ctx.step);
      const args = ctx.call.arguments && typeof ctx.call.arguments === 'object' ? ctx.call.arguments : {};
      if (args.status !== 'completed') return;
      const taskId = typeof args.taskId === 'string' && args.taskId.trim() ? args.taskId : '';
      if (!taskId) return;
      const todo = this.readTodoFeature(ctx);
      const task = todo?.getTask?.(taskId);
      if (!task || (task.status !== 'pending' && task.status !== 'in_progress')) return;
      this.todoCompletionCandidates.set(ctx.call.id, {
        callId: ctx.call.id,
        step: ctx.step,
        taskId,
      });
    } catch (error) {
      this.logger?.warn?.('Craft awareness Todo completion candidate failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 工具成功后读取 Todo feature 的当前状态，确认候选确实完成。 */
  async confirmTodoCompletion(ctx: ToolFinishedDecisionContext): Promise<void> {
    try {
      if (ctx.toolName !== TODO_TOOL_NAME) return;
      const candidate = this.todoCompletionCandidates.get(ctx.call?.id);
      this.todoCompletionCandidates.delete(ctx.call?.id);
      if (!candidate || ctx.success !== true || candidate.step !== ctx.step) return;
      const todo = this.readTodoFeature(ctx);
      const task = todo?.getTask?.(candidate.taskId);
      if (!task || task.status !== 'completed') return;
      this.completedTodoTasks.set(task.id, {
        id: task.id,
        subject: task.subject,
        description: task.description,
        deliver: task.deliver,
        kind: task.kind,
        status: task.status,
      });
    } catch (error) {
      this.logger?.warn?.('Craft awareness Todo completion confirmation failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 下一步开始时合并上一步的完成项，提醒只承接后续理解，不改变任务状态或验收要求。 */
  async injectTodoCompletionReflection(ctx: StepStartContext): Promise<void> {
    if (this.todoCompletionStep === undefined || this.todoCompletionStep >= ctx.step || this.completedTodoTasks.size === 0) return;
    const tasks = Array.from(this.completedTodoTasks.values());
    this.completedTodoTasks.clear();
    try {
      const base = this.knowledge.get(TODO_COMPLETION_ENTRY_ID);
      if (!base) {
        this.logger?.warn?.('Craft awareness knowledge missing, skip injection', { entry: TODO_COMPLETION_ENTRY_ID });
        return;
      }
      ctx.context.addSystemMessage(
        CRAFT_PREFIX + this.buildTodoCompletionReflection(base, tasks),
        readCurrentTurn(ctx.context),
        this.name,
        'reminder',
      );
      this.logger?.info?.('Craft awareness injected', {
        entry: TODO_COMPLETION_ENTRY_ID,
        taskIds: tasks.map(task => task.id),
      });
    } catch (error) {
      // observe 语义：承接提醒失败不影响本步完成或工具结果。
      this.logger?.warn?.('Craft awareness Todo completion reflection failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  shouldRemindTestLayer(ctx: ToolFinishedDecisionContext, index: number): boolean {
    const filePath = readTestFilePath({ toolName: ctx.toolName, args: ctx.call?.arguments, success: ctx.success === true });
    if (!filePath) return false;
    if (index > 0 && (ctx.toolName !== 'edit' || !this.injectedEntries[TEST_CRAFT_LAYERS[index - 1].id])) return false;
    return (this.testFileChanges.get(normalizeDocPath(filePath)) ?? 0) >= TEST_CRAFT_LAYERS[index].minChanges;
  }

  /**
   * 根据任务信息生成一条语境化承接提醒。基础文案负责方向，任务字段只补当前
   * 这一步的事实；不把 Todo 文案改写成新的用户目标，也不要求当场追加检查。
   */
  private buildTodoCompletionReflection(base: string, tasks: TodoCompletionTask[]): string {
    const lines = [base.trim()];
    for (const task of tasks) {
      const kind = TODO_COMPLETION_KIND_IDS.includes(task.kind ?? 'other') ? task.kind ?? 'other' : 'other';
      const subject = this.truncateCompletionText(task.subject, COMPLETION_SUBJECT_MAX_LENGTH);
      const description = this.truncateCompletionText(task.description, COMPLETION_DESCRIPTION_MAX_LENGTH);
      const deliver = this.truncateCompletionText(task.deliver, COMPLETION_DELIVER_MAX_LENGTH);
      lines.push(`\n${this.buildCompletionTaskContext(subject, description, deliver)}\n${this.kindCompletionPrompt(kind)}`);
    }
    return lines.join('\n').trim();
  }

  private truncateCompletionText(value: string | undefined, maxLength: number): string {
    const text = value?.trim() ?? '';
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
  }

  private buildCompletionTaskContext(subject: string, description: string, deliver: string): string {
    const lines = [`围绕「${subject}」的这一步已经形成结果。`];
    if (description) lines.push(`任务说明：${description}`);
    if (deliver) lines.push(`交付物：${deliver}`);
    return lines.join('\n');
  }

  private kindCompletionPrompt(kind: CompletionKind): string {
    switch (kind) {
      case 'investigate':
        return '接下来把这些材料放回用户要解决的问题中：分清已由现有材料支持的事实、基于这些事实形成的判断，以及仍待方案处理的部分；把当前认识当作后续收敛的落脚点，继续据此推进。';
      case 'design':
        return '接下来把这套安排放回用户想得到的结果中：沿着已经明确的路径和边界继续展开；如果后续实现暴露出方案接不住原要求的地方，就调整方案与原要求之间的关系，不要只围绕方案本身完成。';
      case 'implement':
        return '接下来把这部分实现接回原来的使用路径：确认它承接了需求中的哪一段，并沿剩余链路继续推进；当前产物可以作为后续工作的基础，但不要让它的现状替代用户真正要解决的问题。';
      case 'fix':
        return '接下来把这次处理放回原来的故障路径：沿着实际行为继续推进，保留这次已经恢复的部分，并据此判断后面还要接哪一段；不要让修复后的局部状态变成新的问题定义。';
      case 'verify':
        return '接下来把这次核对所得的认识放回原始要求：说明它让哪一项判断更有依据、在什么条件和范围内成立，再用这个落脚点推进后续工作；不要让一次检查替代更大的结果判断。';
      case 'other':
        return '接下来把这个阶段性结果放回用户原本要解决的问题中：沿着它实际承接的关系继续推进，同时让原始要求而不是当前产物决定后续方向。';
    }
  }

  /**
   * ToolFinished 通知（结果已写入 context，提醒落在结果消息之后）。
   * 先记账（trackDocBoundary），再做条目判定；一次工具事件最多注入一条——
   * 多个条目同时命中时取首个，避免刷屏。
   */
  async injectCraftReminder(ctx: ToolFinishedDecisionContext): Promise<void> {
    try {
      this.trackDocBoundary(ctx);
      this.trackTestChanges(ctx);
      for (const entry of CRAFT_ENTRIES) {
        if (this.injectedEntries[entry.id]) continue;
        if (!entry.match(ctx, this)) continue;
        const content = this.knowledge.get(entry.id);
        if (!content) {
          this.logger?.warn?.('Craft awareness knowledge missing, skip injection', { entry: entry.id });
          continue;
        }
        ctx.context.addSystemMessage(CRAFT_PREFIX + content, readCurrentTurn(ctx.context), this.name, 'reminder');
        this.injectedEntries[entry.id] = true;
        this.logger?.info?.('Craft awareness injected', {
          entry: entry.id,
          toolName: ctx.toolName,
        });
        break;
      }
    } catch (error) {
      // observe 语义兜底：任何异常都不阻断工具结果。
      this.logger?.warn?.('Craft awareness injection failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ── Feature state snapshot（框架原生快照契约，随会话持久化）──

  captureState(): FeatureStateSnapshot {
    return {
      injected: { ...this.injectedEntries },
      ...(this.testFileChanges.size > 0 ? { testFileChanges: Object.fromEntries(this.testFileChanges) } : {}),
    };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const record = (snapshot && typeof snapshot === 'object' ? snapshot : {}) as Record<string, unknown>;
    const injected = record.injected && typeof record.injected === 'object'
      ? record.injected as Record<string, unknown>
      : {};
    const next: Record<string, true> = {};
    for (const entry of CRAFT_ENTRIES) {
      if (injected[entry.id] === true) next[entry.id] = true;
    }
    this.injectedEntries = next;
    this.testFileChanges.clear();
    if (record.testFileChanges && typeof record.testFileChanges === 'object' && !Array.isArray(record.testFileChanges)) {
      for (const [filePath, count] of Object.entries(record.testFileChanges)) {
        if (typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= TEST_CRAFT_LAYERS.length) {
          this.testFileChanges.set(normalizeDocPath(filePath), count);
        }
      }
    }
    // 边界记账是会话内运行时状态，不计入快照；恢复快照时重置，避免跨会话残留。
    this.docBoundaries.clear();
  }
}
