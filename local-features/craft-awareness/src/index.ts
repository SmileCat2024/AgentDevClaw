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
 * 冷却按条目 id 记账（每会话每条目一次）。新增素养提醒 = 代码加条目 +
 * knowledge 放对应 md，机制不动。
 *
 * 技能携带（skills/ 目录）：本 feature 同时是 grill-me 技能（设计树拷问）
 * 的载具——框架 collectFeatureSkills 按 dirname(source)/skills 约定自动
 * 发现并注入系统提示词，构建时随 knowledge 同款机制拷入 dist
 * （copy-local-feature-skills.mjs）。技能随 feature 装配走，不依赖工作
 * 目录的 .agentdev/skills。
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
import type { Context, ToolFinishedDecisionContext } from '@agentdevjs/core';
import { CoreLifecycle } from '@agentdevjs/core';

const __filename = fileURLToPath(import.meta.url);

/** write 触发的最小行数：低于此值视为随手短记，不打断。 */
export const DOC_CRAFT_MIN_WRITE_LINES = 30;

/** 文档类扩展名（小写匹配）。 */
const DOC_CRAFT_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

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
    injectCraftReminder: { lifecycle: CoreLifecycle.ToolFinished, kind: 'observe' as const },
  };

  readonly name = 'craft-awareness';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '在文档写作与测试文件修改时分层注入工程素养——读者视角、交付阶段判断，以及测试行为契约、辨别能力与验证交付，每条每会话至多一次；并携带 grill-me 技能。';

  /** 已注入条目记账（id → true），随会话快照持久化。 */
  private injectedEntries: Record<string, true> = {};
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

  shouldRemindTestLayer(ctx: ToolFinishedDecisionContext, index: number): boolean {
    const filePath = readTestFilePath({ toolName: ctx.toolName, args: ctx.call?.arguments, success: ctx.success === true });
    if (!filePath) return false;
    if (index > 0 && (ctx.toolName !== 'edit' || !this.injectedEntries[TEST_CRAFT_LAYERS[index - 1].id])) return false;
    return (this.testFileChanges.get(normalizeDocPath(filePath)) ?? 0) >= TEST_CRAFT_LAYERS[index].minChanges;
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
