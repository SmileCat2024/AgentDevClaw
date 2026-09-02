/**
 * 第四道检查点 — 参数校验（ticket 033；可选尾参 ticket 035）
 *
 * 按动词声明的参数约束逐段校验：参数个数（超过声明数拒绝、不足必填数拒绝，
 * required: false 的尾参可缺省、variadic: true 的尾参可重复）、字面量枚举、
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
 * - 参数个数：超过声明长度拒绝；不足必填数（required !== false 的前缀参数）
 *   拒绝，声明了可选尾参时报文案为「必填~上限」区间
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

    // 尾随声明 flag 剥离：不占位置参数个数（只在尾部识别；未声明的
    // `--` 前缀参数不剥离，仍按位置参数校验）
    const declaredFlags = decl.flags ?? [];
    const positional = [...seg.args];
    while (
      positional.length > 0 &&
      declaredFlags.includes(positional[positional.length - 1])
    ) {
      positional.pop();
    }

    // 必填数 = required !== false 的前缀参数（可选参只允许尾随，此处按
    // 必填前缀长度计：首个 required !== false 之后全部视为可选）
    let minRequired = decl.params.length;
    for (let j = decl.params.length - 1; j >= 0; j--) {
      if (decl.params[j].required !== false) break;
      minRequired = j;
    }
    // 尾参 variadic：末位声明可重复，超过声明个数不拒绝（可变部分的值
    // 仍按末位约束逐个校验）
    const variadicTail = decl.params[decl.params.length - 1]?.variadic === true;
    if ((!variadicTail && positional.length > decl.params.length) || positional.length < minRequired) {
      const expected = variadicTail
        ? `${minRequired}+`
        : minRequired === decl.params.length
          ? `${decl.params.length}`
          : `${minRequired}~${decl.params.length}`;
      return {
        ok: false,
        code: 'arg_rejected',
        message: `“${seg.verb}” 期望 ${expected} 个参数，实际 ${positional.length} 个。` +
          (decl.usage ? ` 用法：${decl.usage}` : ''),
        segmentIndex: i,
      };
    }

    for (let j = 0; j < positional.length; j++) {
      const constraint = decl.params[Math.min(j, decl.params.length - 1)];
      const rejected = validateParamValue(positional[j], constraint);
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
