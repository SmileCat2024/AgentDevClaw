import { fileURLToPath } from 'url';
import type {
  AgentFeature,
  FeatureInitContext,
  PackageInfo,
} from 'agentdev';
import type { Tool } from 'agentdev';
import { createTool, getPackageInfoFromSource } from 'agentdev';

const __filename = fileURLToPath(import.meta.url);

function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function postJson(serverOrigin: string, pathname: string, payload: unknown): Promise<any> {
  const response = await fetch(`${serverOrigin}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();
  const data = bodyText ? JSON.parse(bodyText) : {};
  if (!response.ok) {
    const message = typeof data?.error === 'string'
      ? data.error
      : `${pathname} failed with status ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export interface ContextCompactionControlConfig {
  serverOrigin?: string;
  agentId?: string;
  sessionId?: string | null;
}

export class ContextCompactionControlFeature implements AgentFeature {
  readonly name = 'context-compaction-control';
  readonly dependencies: string[] = [];
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Exposes runtime-accessible compaction controls so the agent can request a summarized context handoff without mutating the current session context.';

  private readonly serverOrigin: string;
  private readonly agentId: string;
  private readonly sessionId: string;
  private logger?: FeatureInitContext['logger'];
  private _packageInfo: PackageInfo | null = null;

  constructor(config: ContextCompactionControlConfig = {}) {
    this.serverOrigin = cleanValue(config.serverOrigin) || 'http://127.0.0.1:1420';
    this.agentId = cleanValue(config.agentId);
    this.sessionId = cleanValue(config.sessionId);
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

  getTools(): Tool[] {
    return [
      createTool({
        name: 'request_summary_compaction',
        description: 'Trigger a background summarized compaction job for the current session and return the generated handoff artifact information.',
        parameters: {
          type: 'object',
          properties: {
            additionalInstructions: {
              type: 'string',
              description: 'Optional extra compact instructions appended to the summarization prompt.',
            },
          },
        },
        execute: async (args) => {
          if (!this.agentId || !this.sessionId) {
            return {
              ok: false,
              error: 'The current runtime is not bound to a resumable session.',
            };
          }

          const additionalInstructions = cleanValue(args?.additionalInstructions);
          const result = await postJson(this.serverOrigin, '/protoclaw/context_handoffs/export', {
            agentId: this.agentId,
            sessionId: this.sessionId,
            policy: {
              strategy: 'summarized-nine-section',
              additionalInstructions,
            },
          });

          const handoff = result?.handoff || {};
          this.logger?.info('Summary compaction requested from tool', {
            handoffId: cleanValue(handoff?.handoffId) || null,
            handoffPath: cleanValue(result?.handoffPath) || null,
            mode: cleanValue(handoff?.mode) || null,
          });

          return {
            ok: true,
            handoffId: cleanValue(handoff?.handoffId),
            handoffPath: cleanValue(result?.handoffPath),
            mode: cleanValue(handoff?.mode),
            summaryShape: cleanValue(handoff?.summaryShape),
          };
        },
      }, this.source),
      createTool({
        name: 'request_summary_compaction_resume',
        description: 'Trigger a summarized compaction job for the current session and create a new compacted resume session from it.',
        parameters: {
          type: 'object',
          properties: {
            additionalInstructions: {
              type: 'string',
              description: 'Optional extra compact instructions appended to the summarization prompt.',
            },
          },
        },
        execute: async (args) => {
          if (!this.agentId || !this.sessionId) {
            return {
              ok: false,
              error: 'The current runtime is not bound to a resumable session.',
            };
          }

          const additionalInstructions = cleanValue(args?.additionalInstructions);
          const result = await postJson(this.serverOrigin, '/protoclaw/context_handoffs/compact_and_resume', {
            agentId: this.agentId,
            sessionId: this.sessionId,
            detached: true,
            policy: {
              strategy: 'summarized-nine-section',
              additionalInstructions,
            },
          });

          this.logger?.info('Summary compaction resume requested from tool', {
            jobId: cleanValue(result?.jobId) || null,
          });

          return {
            ok: true,
            scheduled: true,
            jobId: cleanValue(result?.jobId),
          };
        },
      }, this.source),
      createTool({
        name: 'record_compaction_context',
        description: 'Record the summary, important files and skills for context handoff. This is the ONLY output method — put ALL content into this tool call, do not write summary as plain text.',
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: 'The complete summary text. For exploration sessions: three-section format (goals, findings, important files). For regular sessions: nine-section format. Must not be empty.',
            },
            important_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths that are important for continuing the task.',
            },
            important_skills: {
              type: 'array',
              items: { type: 'string' },
              description: 'Skill names that were used and are important for continuing the task.',
            },
          },
          required: ['summary'],
        },
        execute: async () => ({ ok: true }),
      }, this.source),
    ];
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger;
    this.logger?.info('Context compaction control feature initiated', {
      serverOrigin: this.serverOrigin,
      agentId: this.agentId || null,
      sessionId: this.sessionId || null,
    });
  }
}
