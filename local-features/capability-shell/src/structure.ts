/**
 * 第二道检查点 — 结构分段与 v1 拒绝特征（ticket 033）
 *
 * shell-quote 切段 + 管道拆分；命中 v1 拒绝特征（命令替换、变量、进程替换、
 * glob、heredoc、后台）即终态拒绝。只放行：字面量参数 + 管道 | + 重定向 > >> <。
 *
 * 本道为纯函数。
 */

import { parse } from 'shell-quote';
import type { ShellSegment } from './types.js';

export interface StructureCheckResult {
  ok: boolean;
  /** 拒绝错误码（ok=false 时存在） */
  code?: 'structure_rejected';
  /** 给模型的拒绝文案（可用动词清单由上层拼接） */
  message?: string;
  /** 命中拒绝特征的管道段序号（0-based） */
  segmentIndex?: number;
  /** 分段结果（ok 时存在） */
  segments?: ShellSegment[];
}

/** v1 白名单/拒绝特征说明（报错文案固定后缀，模型可据此自我纠正）。 */
const REJECTED_FEATURES_TEXT =
  '本 shell v1 只放行：字面量参数、管道 |、重定向 > >> <。' +
  '拒绝：命令替换 $() 与反引号、变量 $x、进程替换 <(...)、glob 通配符、heredoc、后台 &。';

type ShellToken = string | { op: string } | { comment: string };

/** 原文级拒绝特征扫描（在 shell-quote 解析前，防解析差异绕过）。 */
function rejectRawFeatures(cmd: string): string | null {
  if (/\$\(/.test(cmd)) return '命令替换 $() 不被允许。';
  if (cmd.includes('`')) return '反引号命令替换不被允许。';
  if (/<[()]/.test(cmd) || />[()]/.test(cmd)) return '进程替换 <(...) / >(...) 不被允许。';
  // heredoc：<<（含 <<- 与 <<< here-string）
  if (/<<-?/.test(cmd)) return 'heredoc（<<）不被允许。';
  // 后台 &：&& 与 & 都不在白名单；裸 &（非 &&）在此拒绝，&& 由 op 扫描拒绝
  if (/(^|[^&])&(?!&)/.test(cmd)) return '后台运行 & 不被允许。';
  // 变量引用：单引号外出现 $name / ${name} / $1 / $? 即拒绝。
  // 逐字符扫描跟踪单引号（单引号内无任何展开，$ 是字面量）；
  // 双引号内变量仍会展开，同样拒绝。
  if (containsDollarOutsideSingleQuotes(cmd)) {
    return '变量引用 $x 不被允许。';
  }
  return null;
}

/**
 * 单引号外是否出现 `$`（含双引号内 —— 双引号内变量仍展开）。
 * 转义形态 `\$` 视为字面量放行（shell-quote 同样剥成 $HOME token，
 * 但语义是转义字面量，不属于变量展开注入面）。
 */
export function containsDollarOutsideSingleQuotes(cmd: string): boolean {
  let inSingle = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '\\') { i++; continue; } // 转义：跳过下一字符
    if (ch === '$') return true;
  }
  return false;
}

/** glob 通配检测：未引用的 * ? 与段首 [...] 字符类 */
export function containsGlob(token: string): boolean {
  // * 与 ? 在字面量参数中几乎必为 glob（工单 v1 一律拒绝）
  if (/[*?]/.test(token)) return true;
  // [...] 字符类：仅在 token 以 [ 开头时判定为 glob（bash `ls [abc]` 形态）。
  // jq 过滤器等工具语法（如 '.[:5]'）中段出现的 [ ] 是字面量，放行 ——
  // shell-quote 不保留引号信息，无法区分引用内外；`$()` 等注入形态已由
  // 原文扫描拦截，此处收窄是为避免误伤工具过滤表达式（工单验收用例）。
  return token.startsWith('[');
}

/**
 * 第二道检查点：shell-quote 结构分段 + v1 拒绝特征扫描。
 *
 * shell-quote 把 `|` 解析为 { op: '|' }；重定向 `>` `>>` `<` 同为 op。
 * 每段首词为动词，其余为参数；段间数据只经管道传递。
 */
export function checkStructure(command: string): StructureCheckResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, code: 'structure_rejected', message: '命令为空。' + REJECTED_FEATURES_TEXT };
  }

  // 原文级预扫描：命令替换 / 反引号 / 进程替换 / heredoc / 后台 ——
  // shell-quote 会把其中一部分当普通 token 吞掉，必须在解析前拒绝。
  const rawReject = rejectRawFeatures(trimmed);
  if (rawReject) {
    return { ok: false, code: 'structure_rejected', message: rawReject + ' ' + REJECTED_FEATURES_TEXT };
  }

  let tokens: ShellToken[];
  try {
    tokens = parse(trimmed) as ShellToken[];
  } catch (err) {
    return { ok: false, code: 'structure_rejected', message: `无法解析命令：${String(err)}` };
  }

  if (tokens.length === 0) {
    return { ok: false, code: 'structure_rejected', message: '命令为空。' + REJECTED_FEATURES_TEXT };
  }

  const segments: ShellSegment[] = [];
  let current: ShellSegment | null = null;
  /** 已出现但未闭合的管道 op（尾悬空检测用）。 */
  let sawTrailingPipe = false;

  for (const token of tokens) {
    if (typeof token === 'string') {
      if (!current) {
        // 段首词 = 动词（管道后或段首）
        current = { verb: token, args: [] };
        sawTrailingPipe = false;
        continue;
      }
      current.args.push(token);
      continue;
    }

    if ('comment' in token) {
      return { ok: false, code: 'structure_rejected', message: '不允许注释。' + REJECTED_FEATURES_TEXT };
    }

    const op = token.op;
    if (op === '|') {
      if (!current || current.verb === '') {
        return { ok: false, code: 'structure_rejected', message: '管道 | 左侧缺少命令。' + REJECTED_FEATURES_TEXT };
      }
      segments.push(current);
      current = null;
      sawTrailingPipe = true;
      continue;
    }

    if (op === '>' || op === '>>' || op === '<') {
      // shell-quote 把重定向目标作为后续普通 token 给出，本道只校验 op 本身；
      // 目标路径校验在参数校验道做（路径边界）。
      if (!current) {
        return {
          ok: false,
          code: 'structure_rejected',
          message: `重定向 ${op} 缺少左侧命令。` + REJECTED_FEATURES_TEXT,
        };
      }
      continue;
    }

    // 其余 op（&& || ; & |& 等）全部拒绝
    return {
      ok: false,
      code: 'structure_rejected',
      message: `bash 结构 “${op}” 不在本 shell 白名单内。` + REJECTED_FEATURES_TEXT,
    };
  }

  // 尾悬空管道：| 后没有后续段
  if (sawTrailingPipe) {
    return { ok: false, code: 'structure_rejected', message: '管道 | 右侧缺少命令。' + REJECTED_FEATURES_TEXT };
  }

  if (current) segments.push(current);

  // 段校验：每段必须有动词；token 级拒绝特征（变量展开 / glob）
  if (segments.length === 0) {
    return { ok: false, code: 'structure_rejected', message: '命令缺少动词。' + REJECTED_FEATURES_TEXT };
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.verb) {
      return { ok: false, code: 'structure_rejected', message: '管道段缺少命令。' + REJECTED_FEATURES_TEXT };
    }
    for (const arg of [seg.verb, ...seg.args]) {
      if (containsGlob(arg)) {
        return {
          ok: false,
          code: 'structure_rejected',
          message: `参数 “${arg}” 含 glob 通配符（* ? [ ]），不被允许。` + REJECTED_FEATURES_TEXT,
          segmentIndex: i,
        };
      }
    }
  }

  return { ok: true, segments };
}
