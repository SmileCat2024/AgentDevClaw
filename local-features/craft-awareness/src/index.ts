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
 * 冷却按条目 id 记账（每会话最多注入一次）。新增素养提醒 = 代码加条目 +
 * knowledge 放对应 md，机制不动。
 *
 * 首个条目 doc-reader-awareness：write 写出成规模的文档文件（markdown/txt，
 * 默认 ≥30 行）或 edit 编辑此类文件成功后，注入一条"文档读者视角"写法标准。
 * write 设规模阈值是为了排除随手写的短 note；edit 本身就是改已有文档，不看规模。
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

/** 素养条目：触发判定在代码，文案在 knowledge/<id>.md。冷却以 id 为键（每会话每条目一次）。 */
interface CraftEntry {
  id: string;
  description: string;
  match: (ctx: ToolFinishedDecisionContext) => boolean;
}

const CRAFT_ENTRIES: readonly CraftEntry[] = [
  {
    id: 'doc-reader-awareness',
    description: '文档读者视角：首次写出成规模文档后注入写法标准',
    match: (ctx) => shouldRemindDocCraft({
      toolName: ctx.toolName,
      args: ctx.call?.arguments,
      success: ctx.success === true,
    }),
  },
];

export class CraftAwarenessFeature implements AgentFeature {

  static hooks: HookDeclarations = {
    injectCraftReminder: { lifecycle: CoreLifecycle.ToolFinished, kind: 'observe' as const },
  };

  readonly name = 'craft-awareness';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = '工程素养提醒：在恰当的工具事件后注入聚焦的写法提醒。首个条目：首次写出成规模文档（write/edit 的 markdown/txt 文件）后注入读者视角写法标准，每会话一次。文案外置于 knowledge/ 目录（md 维护）。';

  /** 已注入条目记账（id → true），随会话快照持久化。 */
  private injectedEntries: Record<string, true> = {};
  /** 条目 id → 注入正文（构造时从 knowledge 目录加载一次）。 */
  private readonly knowledge: Map<string, string>;
  private logger?: FeatureInitContext['logger'];

  constructor(config: { knowledgeDir?: string } = {}) {
    const defaultDir = join(dirname(__filename), 'knowledge');
    this.knowledge = loadKnowledgeDir(config.knowledgeDir ?? defaultDir);
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
  }

  /**
   * ToolFinished 通知（结果已写入 context，提醒落在结果消息之后）。
   * 一次工具事件最多注入一条——多个条目同时命中时取首个，避免刷屏。
   */
  async injectCraftReminder(ctx: ToolFinishedDecisionContext): Promise<void> {
    try {
      for (const entry of CRAFT_ENTRIES) {
        if (this.injectedEntries[entry.id]) continue;
        if (!entry.match(ctx)) continue;
        const content = this.knowledge.get(entry.id);
        if (!content) {
          this.logger?.warn?.('Craft awareness knowledge missing, skip injection', { entry: entry.id });
          continue;
        }
        this.injectedEntries[entry.id] = true;
        ctx.context.addSystemMessage(CRAFT_PREFIX + content, readCurrentTurn(ctx.context), this.name, 'reminder');
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
    return { injected: { ...this.injectedEntries } };
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
  }
}
