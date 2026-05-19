import { fileURLToPath } from 'url';
import type {
  AgentFeature,
  FeatureInitContext,
} from 'agentdev';
import type { CallStartContext } from 'agentdev';
import { CallStart } from 'agentdev';

const __filename = fileURLToPath(import.meta.url);

export class ContextCompactionMirrorFeature implements AgentFeature {
  readonly name = 'context-compaction-mirror';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Disables all LLM-visible tools on the first call of a mirror compaction runtime while preserving tool visibility for cache-friendly prompt shape.';

  private armed = true;
  private logger?: FeatureInitContext['logger'];

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('Context compaction mirror feature initiated');
  }

  @CallStart
  async disableAllToolsOnFirstCall(ctx: CallStartContext): Promise<void> {
    if (!this.armed || !ctx.isFirstCall) {
      return;
    }

    const toolRegistry = typeof (ctx.agent as any)?.getTools === 'function'
      ? (ctx.agent as any).getTools()
      : null;
    const entries = toolRegistry?.getEntries?.() || [];
    let disabledCount = 0;

    for (const entry of entries) {
      const toolName = typeof entry?.tool?.name === 'string' ? entry.tool.name : '';
      if (!toolName) continue;
      if (toolRegistry.disable(toolName)) {
        disabledCount += 1;
      }
    }

    this.armed = false;
    this.logger?.info('Disabled all tools for mirror compaction runtime', {
      disabledCount,
      toolCount: entries.length,
    });
  }
}

