/**
 * 第四道检查点 — 参数校验（ticket 033）
 *
 * 按动词声明的参数约束逐段校验：参数个数（超缺均拒绝）、字面量枚举、
 * 路径边界（workspace 相对路径内，拒绝 .. 逃逸与绝对路径）。
 *
 * 本道为纯函数。
 */

import type { ShellParamDecl, ShellSegment, ShellVerbDecl } from './types.js';

export interface ParamCheckResult {
  ok: boolean;
  /** 拒绝错误码（ok=false 时存在） */
  code?: 'arg_rejected';
  /** 给模型的拒绝文案 */
  message?: string;
  /** 命中拒绝的段序号 */
  segmentIndex?: number;
}

/**
 * 第四道检查点：参数校验。
 *
 * 按动词声明的参数约束逐段校验：
 * - 参数个数：声明长度即期望个数（超缺均拒绝）
 * - kind=path：拒绝绝对路径与 `..` 逃逸（workspace 相对路径内）
 * - kind=literal：enum 白名单（若声明）
 */
export function checkArgs(
  segments: ShellSegment[],
  verbs: Record<string, ShellVerbDecl>,
): ParamCheckResult {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const decl = verbs[seg.verb];
    if (!decl) continue; // 动词道已拦截，此处防御性跳过

    if (seg.args.length !== decl.params.length) {
      return {
        ok: false,
        code: 'arg_rejected',
        message: `“${seg.verb}” 期望 ${decl.params.length} 个参数，实际 ${seg.args.length} 个。` +
          (decl.usage ? ` 用法：${decl.usage}` : ''),
        segmentIndex: i,
      };
    }

    for (let j = 0; j < seg.args.length; j++) {
      const rejected = validateParamValue(seg.args[j], decl.params[j]);
      if (rejected) {
        return {
          ok: false,
          code: 'arg_rejected',
          message: rejected + (decl.usage ? ` 用法：${decl.usage}` : ''),
          segmentIndex: i,
        };
      }
    }
  }
  return { ok: true };
}

/** 单参数校验（返回拒绝文案或 null）。 */
export function validateParamValue(
  value: string,
  constraint: ShellParamDecl,
): string | null {
  if (constraint.kind === 'path') {
    if (isAbsoluteLike(value)) {
      return `路径参数 “${constraint.name}” 必须是 workspace 相对路径，拒绝绝对路径 “${value}”。`;
    }
    if (escapesWorkspace(value)) {
      return `路径 “${constraint.name}” 含 “..”，逃逸 workspace 边界，拒绝。`;
    }
  }
  if (constraint.enum && !constraint.enum.includes(value)) {
    return `参数 “${constraint.name}” 的值 “${value}” 不在允许范围 [${constraint.enum.join(', ')}] 内。`;
  }
  return null;
}

/** 绝对路径形态检测：POSIX / 与 Windows 盘符。 */
export function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/** `..` 逃逸检测：路径任一段为 `..` 即逃逸（'..'、'../a'、'a/../b'）。 */
export function escapesWorkspace(pathValue: string): boolean {
  return pathValue.split('/').some(seg => seg === '..');
}
