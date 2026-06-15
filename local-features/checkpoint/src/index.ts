/**
 * CheckpointFeature — Agent 自主 Checkpoint 与 Rollback
 *
 * 提供两个 exclusive 工具：
 * - set_checkpoint: 建立检查点（同时只允许存在一个）
 * - rollback_to_checkpoint: 回退到检查点，携带失败分支摘要
 *
 * 工具本身不操作 runtime，只通过 context.registerContinuationRequest
 * 登记请求。实际 checkpoint 创建和恢复由 CallArbiter barrier 完成。
 *
 * 简化模型：同时只能存在一个 checkpoint（固定 ID "__active__"）。
 */

import type { AgentFeature, FeatureStateSnapshot, InlineRenderTemplate } from 'agentdev';
import { createTool } from 'agentdev';

/** 固定 checkpoint ID（单 checkpoint 模型） */
const ACTIVE_CHECKPOINT_ID = '__active__';

/** summary 最大长度 */
const MAX_SUMMARY_LENGTH = 2000;

export class CheckpointFeature implements AgentFeature {
  readonly name = 'checkpoint';
  readonly description = 'Agent 自主 checkpoint 与 rollback 能力';

  /** 当前是否有活跃的 checkpoint */
  private _hasActiveCheckpoint = false;

  getTools() {
    return [
      createTool({
        name: 'set_checkpoint',
        description: [
          'Set a checkpoint at the current point in the conversation.',
          'You can later call rollback_to_checkpoint to discard everything after this point',
          'and continue from here with a summary of what was tried.',
          '',
          'Only one checkpoint can exist at a time. Calling this again replaces the previous one.',
          'This tool must be the only tool call in the current turn.',
          '',
          'Use this when you are about to explore an uncertain direction and want a safe return point.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            note: {
              type: 'string',
              description: 'Brief description of what you plan to explore from this checkpoint.',
            },
          },
        },
        execute: async (args: any, context?: any) => {
          // 标记活跃 checkpoint
          this._hasActiveCheckpoint = true;

          // 登记 continuation request — CallArbiter 会在 onCall 结束后创建 checkpoint
          if (typeof context?.registerContinuationRequest === 'function') {
            context.registerContinuationRequest({
              kind: 'checkpoint',
              checkpointId: ACTIVE_CHECKPOINT_ID,
              metadata: args?.note ? { note: args.note } : undefined,
            });
          }

          return {
            message: 'Checkpoint established. Explore freely — call rollback_to_checkpoint if this direction fails.',
            note: args?.note || '',
          };
        },
        render: { call: 'set-checkpoint', result: 'set-checkpoint' },
        executionMode: 'exclusive',
      }),

      createTool({
        name: 'rollback_to_checkpoint',
        description: [
          'Roll back to the previously set checkpoint, discarding everything after it.',
          'You must provide a summary of what was attempted and why it failed.',
          'The conversation will be restored to the checkpoint state, and your summary',
          'will be injected as context for the next step.',
          '',
          'IMPORTANT: rollback only restores conversation context and Feature state.',
          'External side effects (file writes, shell commands, API calls) are NOT undone.',
          'After rollback, verify the real state of any external resources you modified.',
          '',
          'This tool must be the only tool call in the current turn.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            summary: {
              type: 'string',
              description: [
                'Summary of what was tried after the checkpoint and why it failed.',
                'Include: methods attempted, failure reasons, and suggested next direction.',
                'This summary will be carried into the restored checkpoint context.',
              ].join(' '),
            },
          },
          required: ['summary'],
        },
        execute: async (args: any, context?: any) => {
          // 前置检查：没有活跃 checkpoint 时友好失败
          if (!context?.hasActiveCheckpoint) {
            return {
              error: 'No active checkpoint exists. Call set_checkpoint first before attempting rollback.',
            };
          }

          const summary: string = typeof args?.summary === 'string' ? args.summary : '';

          if (!summary.trim()) {
            return { error: 'summary is required and must not be empty.' };
          }

          if (summary.length > MAX_SUMMARY_LENGTH) {
            return { error: `summary is too long (${summary.length} chars, max ${MAX_SUMMARY_LENGTH}).` };
          }

          // 登记 rollback continuation request
          if (typeof context?.registerContinuationRequest === 'function') {
            context.registerContinuationRequest({
              kind: 'rollback',
              checkpointId: ACTIVE_CHECKPOINT_ID,
              summary,
            });
          }

          return {
            message: 'Rolling back to checkpoint. The exploration branch will be discarded.',
            summaryPreview: summary.slice(0, 200),
          };
        },
        render: { call: 'rollback-checkpoint', result: 'rollback-checkpoint' },
        executionMode: 'exclusive',
      }),
    ];
  }

  /**
   * 通过 context injector 向 rollback_to_checkpoint 注入 hasActiveCheckpoint 状态。
   *
   * 这使得工具可以在 execute 时检查 checkpoint 是否存在，
   * 而不是等到 CallArbiter barrier 中才发现 checkpoint 不存在。
   */
  getContextInjectors() {
    const map = new Map<string | RegExp, (call: any) => Record<string, unknown>>();
    map.set(/^rollback_to_checkpoint$/, () => ({
      hasActiveCheckpoint: this._hasActiveCheckpoint,
    }));
    return map;
  }

  // ── Feature state snapshot ──

  captureState(): FeatureStateSnapshot {
    return { hasActiveCheckpoint: this._hasActiveCheckpoint };
  }

  restoreState(snapshot: FeatureStateSnapshot): void {
    const s = snapshot as { hasActiveCheckpoint?: boolean } | null;
    this._hasActiveCheckpoint = s?.hasActiveCheckpoint ?? false;
  }

  // ── Render templates ──

  getRenderTemplates(): Record<string, InlineRenderTemplate> {
    return {
      'set-checkpoint': {
        call: (data: Record<string, any>) =>
          `<div class="tool-call checkpoint-call"><span class="checkpoint-icon">📍</span> Set Checkpoint${data?.note ? `: ${escapeHtml(data.note)}` : ''}</div>`,
        result: (_data: Record<string, any>, success?: boolean) =>
          success
            ? `<div class="tool-result checkpoint-result">Checkpoint established — safe to explore.</div>`
            : `<div class="tool-error">Checkpoint failed.</div>`,
      },
      'rollback-checkpoint': {
        call: (data: Record<string, any>) => {
          const preview = data?.summary ? escapeHtml(String(data.summary).slice(0, 150)) : '';
          return `<div class="tool-call rollback-call"><span class="rollback-icon">↩️</span> Rollback to Checkpoint${preview ? `: ${preview}…` : ''}</div>`;
        },
        result: (_data: Record<string, any>, success?: boolean) =>
          success
            ? `<div class="tool-result rollback-result">Restoring checkpoint — conversation will continue from the saved point.</div>`
            : `<div class="tool-error">Rollback failed.</div>`,
      },
    };
  }
}

// ── Utilities ──

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
