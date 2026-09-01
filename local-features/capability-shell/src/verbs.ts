/**
 * 第三道检查点 — 逐段动词校验（ticket 033）
 *
 * 每个管道段的首词必须在领域策略声明的动词表内；未命中 → 终态拒绝，
 * 报错列出该 shell 全部可用动词（unknown_verb），模型可自我纠正。
 *
 * 本道为纯函数。
 */

import type { ShellSegment } from './types.js';

export interface VerbCheckResult {
  ok: boolean;
  /** 拒绝错误码（ok=false 时存在） */
  code?: 'unknown_verb';
  /** 给模型的拒绝文案（必含可用动词清单） */
  message?: string;
  /** 命中未知动词的段序号 */
  segmentIndex?: number;
  /** 命中的未知动词 */
  verb?: string;
}

/**
 * 第三道检查点：逐段动词校验。
 *
 * 每个管道段的首词必须在动词表内。未命中 → 终态拒绝并列出可用动词清单
 * （稳定排序），模型可自我纠正。策略声明了 unknownVerbHints 时，被排除
 * 动词的拒绝报文附加其结构化指引（如 rotation_failed 需人工介入）。
 */
export function checkVerbs(
  shellName: string,
  segments: ShellSegment[],
  verbs: Record<string, unknown>,
  unknownVerbHints: Record<string, string> = {},
): VerbCheckResult {
  for (let i = 0; i < segments.length; i++) {
    const verb = segments[i].verb;
    if (!(verb in verbs)) {
      const hint = unknownVerbHints?.[verb];
      return {
        ok: false,
        code: 'unknown_verb',
        message: `“${verb}” 不是 ${shellName} 的可用动词。可用动词：${listVerbs(verbs)}。` +
          (hint ? `\n${hint}` : ''),
        segmentIndex: i,
        verb,
      };
    }
  }
  return { ok: true };
}

/** 可用动词清单（稳定排序，模型可读；unknown_verb 报文与工具描述共用）。 */
export function listVerbs(verbs: Record<string, unknown>): string {
  return Object.keys(verbs).sort().join(', ');
}
