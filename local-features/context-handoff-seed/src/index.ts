import { fileURLToPath } from 'url';
import type {
  AgentFeature,
  FeatureContext,
  FeatureInitContext,
  FeatureStateSnapshot,
  LLMResponse,
} from 'agentdev';
import type { CallStartContext } from 'agentdev';
import { CallStart } from 'agentdev';

const __filename = fileURLToPath(import.meta.url);

export interface ContextHandoffSeedMessage {
  role: string;
  content: string;
  turn?: number | null;
}

export interface ContextHandoffSeedPayload {
  packageId?: string;
  sourceSessionId?: string;
  sourceSummary?: string;
  mode?: string;
  seedMessages?: ContextHandoffSeedMessage[];
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

function normalizeSeedMessages(seedMessages: unknown): ContextHandoffSeedMessage[] {
  if (!Array.isArray(seedMessages)) return [];
  return seedMessages
    .map((message) => ({
      role: cleanValue((message as any)?.role),
      content: cleanValue((message as any)?.content),
      turn: Number.isFinite((message as any)?.turn) ? Number((message as any).turn) : null,
    }))
    .filter((message) => message.role && message.content);
}

function buildFallbackSeedMessage(handoff: ContextHandoffSeedPayload): string {
  const lines = [
    '## Context Handoff Seed',
    '',
    'The following compacted context was exported from an earlier session so this runtime can continue the same task.',
    '以下压缩上下文来自更早的一次会话导出，用于让当前运行时继续同一个任务。',
  ];

  const sourceSessionId = cleanValue(handoff.sourceSessionId);
  if (sourceSessionId) {
    lines.push('', `Source session: ${sourceSessionId}`, `来源会话：${sourceSessionId}`);
  }

  const sourceSummary = cleanValue(handoff.sourceSummary);
  if (sourceSummary) {
    lines.push('', sourceSummary);
  }

  return lines.join('\n');
}

function replayAssistantMessage(ctx: CallStartContext, message: ContextHandoffSeedMessage, turn: number): void {
  const response: LLMResponse = {
    content: message.content,
    toolCalls: [],
  };
  ctx.context.addAssistantMessage(response, turn);
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
    this.handoff = {
      packageId: cleanValue(config?.handoff?.packageId),
      sourceSessionId: cleanValue(config?.handoff?.sourceSessionId),
      sourceSummary: cleanValue(config?.handoff?.sourceSummary),
      mode: cleanValue(config?.handoff?.mode),
      seedMessages: normalizeSeedMessages(config?.handoff?.seedMessages),
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
    const seedMessages = Array.isArray(this.handoff.seedMessages) ? this.handoff.seedMessages : [];

    if (seedMessages.length > 0) {
      seedMessages.forEach((message, index) => {
        const turn = Number.isFinite(message.turn) ? Number(message.turn) : (fallbackTurn + index);
        if (message.role === 'user') {
          ctx.context.addUserMessage(message.content, turn);
          return;
        }
        if (message.role === 'assistant') {
          replayAssistantMessage(ctx, message, turn);
          return;
        }
        ctx.context.addSystemMessage(message.content, turn, this.name);
      });
    } else if (this.handoff.sourceSummary) {
      ctx.context.addSystemMessage(buildFallbackSeedMessage(this.handoff), fallbackTurn, this.name);
    } else {
      return;
    }

    this.injected = true;
    this.logger?.info('Injected context handoff seed', {
      packageId: this.handoff.packageId || null,
      sourceSessionId: this.handoff.sourceSessionId || null,
      seedMessageCount: seedMessages.length,
      turn: fallbackTurn,
    });
  }
}
