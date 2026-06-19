import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { join, resolve, normalize, dirname } from 'path';
import type {
  AgentFeature,
  FeatureContext,
  FeatureInitContext,
  FeatureStateSnapshot,
} from 'agentdev';
import type { CallStartContext } from 'agentdev';
import { CallStart } from 'agentdev';

const __filename = fileURLToPath(import.meta.url);

const MAX_FILE_CHARS = 8000;
const MAX_TOTAL_FILE_CHARS = 30000;
const MAX_SKILL_CHARS = 5000;
const MAX_TOTAL_SKILL_CHARS = 15000;

export interface ContextHandoffSeedMessage {
  role: string;
  content: string;
  turn?: number | null;
  toolCalls?: Array<{ name: string; arguments: string; id: string }>;
  toolCallId?: string;
}

export interface ContextHandoffSeedPayload {
  packageId?: string;
  sourceSessionId?: string;
  sourceSummary?: string;
  mode?: string;
  seedMessages?: ContextHandoffSeedMessage[];
  importantFiles?: string[];
  importantSkills?: string[];
  fileRanges?: Record<string, string>;
}

export interface ContextHandoffSeedFeatureConfig {
  handoff: ContextHandoffSeedPayload;
}

interface ContextHandoffSeedSnapshot {
  injected: boolean;
}

function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function countValidSeedMessages(seedMessages: unknown): number {
  if (!Array.isArray(seedMessages)) return 0;
  return seedMessages.filter((m) => typeof (m as any)?.role === 'string' && (m as any).role).length;
}

function buildTrimContextLabel(handoff: ContextHandoffSeedPayload): string {
  const lines = [
    '## 会话续接元信息',
    '',
    '当前会话是从更早的对话裁剪续接而来。上方已注入裁剪后的完整对话历史。',
    '以下仅为该会话的任务元信息，不需要重新执行这些任务。',
  ];
  const sourceSessionId = cleanValue(handoff.sourceSessionId);
  if (sourceSessionId) {
    lines.push('', `来源会话：${sourceSessionId}`);
  }
  const sourceSummary = cleanValue(handoff.sourceSummary);
  if (sourceSummary) {
    lines.push('', sourceSummary);
  }
  return lines.join('\n');
}

function buildSummarySeedMessage(handoff: ContextHandoffSeedPayload): string {
  const lines = [
    '## 上下文交接摘要',
    '',
    '以下压缩上下文来自更早的一次会话导出，用于让当前运行时继续同一个任务。',
  ];
  const sourceSessionId = cleanValue(handoff.sourceSessionId);
  if (sourceSessionId) {
    lines.push('', `来源会话：${sourceSessionId}`);
  }
  const sourceSummary = cleanValue(handoff.sourceSummary);
  if (sourceSummary) {
    lines.push('', sourceSummary);
  }
  return lines.join('\n');
}

export class ContextHandoffSeedFeature implements AgentFeature {
  readonly name = 'context-handoff-seed';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Injects a trimmed handoff transcript exactly once on the first CallStart when a runtime is booted from a handoff package.';

  private readonly handoff: ContextHandoffSeedPayload;
  private injected = false;
  private logger?: FeatureInitContext['logger'];

  constructor(config: ContextHandoffSeedFeatureConfig) {
    // Store seedMessages as raw array — no normalization, no filtering
    const rawSeedMessages = Array.isArray(config?.handoff?.seedMessages)
      ? config.handoff.seedMessages
      : [];
    this.handoff = {
      packageId: cleanValue(config?.handoff?.packageId),
      sourceSessionId: cleanValue(config?.handoff?.sourceSessionId),
      sourceSummary: cleanValue(config?.handoff?.sourceSummary),
      mode: cleanValue(config?.handoff?.mode),
      seedMessages: rawSeedMessages as any,
      importantFiles: Array.isArray(config?.handoff?.importantFiles)
        ? config.handoff.importantFiles.filter(f => typeof f === 'string')
        : [],
      importantSkills: Array.isArray(config?.handoff?.importantSkills)
        ? config.handoff.importantSkills.filter(s => typeof s === 'string')
        : [],
      fileRanges: typeof config?.handoff?.fileRanges === 'object' && config.handoff.fileRanges !== null
        ? config.handoff.fileRanges
        : {},
    };
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('Context handoff seed feature initiated', {
      packageId: this.handoff.packageId || null,
      sourceSessionId: this.handoff.sourceSessionId || null,
      mode: this.handoff.mode || null,
      seedMessageCount: this.handoff.seedMessages?.length || 0,
      hasSourceSummary: Boolean(this.handoff.sourceSummary),
    });
  }

  async onDestroy(_ctx: FeatureContext): Promise<void> {
    this.logger?.info('Context handoff seed feature destroyed', {
      injected: this.injected,
    });
  }

  captureState(): FeatureStateSnapshot {
    const snapshot: ContextHandoffSeedSnapshot = {
      injected: this.injected,
    };
    return snapshot;
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const state = snapshot as ContextHandoffSeedSnapshot | null | undefined;
    this.injected = Boolean(state?.injected);
  }

  @CallStart
  async injectHandoffSummary(ctx: CallStartContext): Promise<void> {
    if (this.injected || !ctx.isFirstCall) {
      return;
    }

    const fallbackTurn = typeof (ctx.agent as any)?._callIndex === 'number' ? (ctx.agent as any)._callIndex : 0;
    const seedMessages: any[] = Array.isArray(this.handoff.seedMessages) ? this.handoff.seedMessages : [];

    let injectionTurn = fallbackTurn;

    // Inject seed messages as-is — they are raw conversation messages, no processing needed
    if (seedMessages.length > 0) {
      seedMessages.forEach((message, index) => {
        const turn = typeof message?.turn === 'number' && Number.isFinite(message.turn)
          ? Number(message.turn)
          : (fallbackTurn + index);
        injectionTurn = Math.max(injectionTurn, turn + 1);
        ctx.context.add({ ...message, turn, source: 'handoff-seed' });
      });

      // Advance the runtime call index past all seed turns so the first real
      // user message gets a non-colliding turn value. Without this, seed turns
      // (e.g. 0,1,2,3,4,5) overlap with the first local user call (turn=0).
      const agentRef = ctx.agent as any;
      if (typeof agentRef?._callIndex === 'number' && injectionTurn - 1 > agentRef._callIndex) {
        agentRef._callIndex = injectionTurn - 1;
      }
    }

    // Inject sourceSummary as a system message only when seedMessages is empty (legacy fallback)
    if (this.handoff.sourceSummary && seedMessages.length === 0) {
      const isTrim = cleanValue(this.handoff.mode).startsWith('trim');
      const label = isTrim
        ? buildTrimContextLabel(this.handoff)
        : buildSummarySeedMessage(this.handoff);
      ctx.context.addSystemMessage(label, injectionTurn, this.name);
    }

    if (seedMessages.length === 0 && !this.handoff.sourceSummary) {
      return;
    }

    this.injected = true;
    this.logger?.info('Injected context handoff seed', {
      packageId: this.handoff.packageId || null,
      sourceSessionId: this.handoff.sourceSessionId || null,
      seedMessageCount: seedMessages.length,
      turn: fallbackTurn,
    });

    this.injectImportantContext(ctx, injectionTurn);
  }

  private injectImportantContext(ctx: CallStartContext, baseTurn: number): void {
    const projectRoot = typeof (ctx.agent as any)?.projectRoot === 'string'
      ? (ctx.agent as any).projectRoot
      : process.cwd();

    let injectionTurn = baseTurn + 1;

    const fileBlocks = this.buildFileBlocks(projectRoot);
    for (const block of fileBlocks) {
      ctx.context.addSystemMessage(block, injectionTurn, this.name);
      injectionTurn += 1;
    }

    const skillBlocks = this.buildSkillBlocks(projectRoot);
    for (const block of skillBlocks) {
      ctx.context.addSystemMessage(block, injectionTurn, this.name);
      injectionTurn += 1;
    }
  }

  private resolveFilePath(filePath: string, projectRoot: string): string {
    if (existsSync(filePath)) return filePath;
    const resolved = resolve(projectRoot, filePath);
    if (existsSync(resolved)) return resolved;
    return filePath;
  }

  private buildFileBlocks(projectRoot: string): string[] {
    const files = this.handoff.importantFiles || [];
    if (files.length === 0) return [];

    const ranges = this.handoff.fileRanges || {};
    const blocks: string[] = [];
    const nameOnlyList: string[] = [];
    let totalChars = 0;

    for (const filePath of files) {
      const resolved = this.resolveFilePath(filePath, projectRoot);
      const content = this.tryReadFile(resolved);
      const range = ranges[filePath];
      const rangeLabel = range ? `（上次阅读行 ${range}）` : '';

      if (content === null) {
        nameOnlyList.push(`${filePath} ${rangeLabel}（文件未找到）`);
        continue;
      }
      const budget = Math.max(0, MAX_TOTAL_FILE_CHARS - totalChars);
      if (content.length <= budget && content.length <= MAX_FILE_CHARS) {
        blocks.push([
          `以下文件在此会话的前一轮中被标记为重要，内容已重新加载（行号为参考值，文件可能已变更）：`,
          '',
          `### ${filePath} ${rangeLabel}`,
          content,
        ].join('\n'));
        totalChars += content.length;
      } else {
        nameOnlyList.push(`${filePath} ${rangeLabel}`);
      }
    }

    if (nameOnlyList.length > 0) {
      const nameBlockLines = [
        '以下文件在此会话的前一轮中被标记为重要，但因超出显示上限或文件未找到仅保留路径（行号为参考值，文件可能已变更）：',
        '',
      ];
      for (const p of nameOnlyList) nameBlockLines.push(`- ${p}`);
      blocks.push(nameBlockLines.join('\n'));
    }

    return blocks;
  }

  private buildSkillBlocks(projectRoot: string): string[] {
    const skills = this.handoff.importantSkills || [];
    if (skills.length === 0) return [];

    const blocks: string[] = [];
    const nameOnlyList: string[] = [];
    let totalChars = 0;

    for (const skillName of skills) {
      const skillDir = join(projectRoot, '.agentdev', 'skills', skillName);
      const skillMdPath = join(skillDir, 'SKILL.md');
      const content = this.tryReadFile(skillMdPath);
      const basePath = normalize(skillDir);

      if (content === null) {
        nameOnlyList.push(`${skillName}（技能定义未找到，目录：${basePath}）`);
        continue;
      }

      const parsed = this.parseSkillMd(content);
      const header = [
        `**技能名称**：${parsed.name || skillName}`,
        parsed.description ? `**技能描述**：${parsed.description}` : '',
        `**技能的基础目录路径**：\`${basePath}\``,
        '',
        '---',
        '',
        parsed.body,
      ].filter(Boolean).join('\n');

      const budget = Math.max(0, MAX_TOTAL_SKILL_CHARS - totalChars);
      const truncated = header.length > MAX_SKILL_CHARS
        ? header.slice(0, MAX_SKILL_CHARS) + '\n（已截断）'
        : header;
      if (truncated.length <= budget) {
        blocks.push([
          '以下技能在此会话的前一轮中被标记为重要：',
          '',
          `### 技能: ${skillName}`,
          truncated,
        ].join('\n'));
        totalChars += truncated.length;
      } else {
        nameOnlyList.push(`${skillName}（目录：${basePath}）`);
      }
    }

    if (nameOnlyList.length > 0) {
      const nameBlockLines = [
        '以下技能在此会话的前一轮中被标记为重要，但因超出显示上限或定义未找到仅保留名称：',
        '',
      ];
      for (const s of nameOnlyList) nameBlockLines.push(`- ${s}`);
      blocks.push(nameBlockLines.join('\n'));
    }

    return blocks;
  }

  private parseSkillMd(content: string): { name: string; description: string; body: string } {
    const result = { name: '', description: '', body: content };
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return result;
    const yaml = frontmatterMatch[1];
    const nameMatch = yaml.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    if (nameMatch) result.name = nameMatch[1].trim();
    const descMatch = yaml.match(/^description:\s*["'](.+?)["']\s*$/m);
    if (descMatch) result.description = descMatch[1].trim();
    result.body = content.slice(frontmatterMatch[0].length).trim();
    return result;
  }

  private tryReadFile(filePath: string): string | null {
    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf8');
      return content.length > MAX_FILE_CHARS
        ? content.slice(0, MAX_FILE_CHARS) + '\n（已截断）'
        : content;
    } catch {
      return null;
    }
  }
}
