/**
 * 第二道检查点 — 结构分段与 v1 拒绝特征（ticket 033；glob 引号语义 ticket 035）
 *
 * 原文级预扫描（shell-quote 解析前）：命令替换、变量、进程替换、glob、
 * heredoc、后台命中即终态拒绝。glob 为引号区域感知：仅拒绝引号外的
 * * ? 与词首 [（引号内是 bash 字面量）。随后 shell-quote 切段 + 管道拆分，
 * 只放行：字面量参数 + 管道 | + 重定向 > >> <。
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
  // glob 通配：引号外出现 * ?（任意位置）或词首 [ 才拒绝；引号内全是
  // 字面量（工单 035：单引号内 markdown **bold** 曾被 token 级检查误杀）。
  if (containsGlobOutsideQuotes(cmd)) {
    return 'glob 通配符（* ? [ ]）不被允许；引号内的字符是字面量，需要通配语义时换个写法。';
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

/**
 * 引号外是否出现 glob 字符（工单 035：bash 语义里引号内的 * ? [ ] 是字面量）。
 *
 * 逐字符扫描（containsDollarOutsideSingleQuotes 同款模式）跟踪单引号与双引号
 * 区域：单引号内无任何展开、双引号内 bash 不做 glob，且双引号内的变量展开
 * 已由原文扫描道拦截，引号内的 * ? [ ] 是字面量，放行。
 *
 * 引号外规则与原 token 级 containsGlob 等价：
 * - * ? 任意位置拒绝（引号外几乎必为 glob）；`'a'*` 拼接后 unquoted 部分仍触发 glob；
 * - [ 仅在词首拒绝（bash `ls [abc]` 形态）；词中 [（jq 过滤器 `.[:5]`、
 *   `--flag=[a]` 等）是工具语法，放行——引号本身不算词字符，`''[abc]`
 *   与裸 `[abc]` 同判；
 * - 转义形态 `\*` 视为字面量放行（与 \$ 先例一致）。
 */
export function containsGlobOutsideQuotes(cmd: string): boolean {
  let inSingle = false;
  let inDouble = false;
  /** 当前词内是否已见实质字符（引号本身不计；词首 [ 判定用）。 */
  let tokenStarted = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue; // 引号本身不算词字符
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle) { tokenStarted = true; continue; } // 单引号内无转义无嵌套，全是字面量
    if (inDouble) {
      if (ch === '\\') { i++; tokenStarted = true; continue; } // 双引号内转义跳过下一字符
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(ch)) { tokenStarted = false; continue; }
    if (ch === '\\') { i++; tokenStarted = true; continue; } // 引号外转义：下一字符是字面量
    if (ch === '*' || ch === '?') return true;
    // 词首 [：bash `ls [abc]` 形态的字符类 glob；词中 [ 是工具语法字面量
    // （jq 过滤器等），与原 token 级 startsWith('[') 规则对齐。
    if (ch === '[' && !tokenStarted) return true;
    tokenStarted = true;
  }
  return false;
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

  // 段校验：每段必须有动词（glob / 变量等拒绝特征已在原文级预扫描道处理）
  if (segments.length === 0) {
    return { ok: false, code: 'structure_rejected', message: '命令缺少动词。' + REJECTED_FEATURES_TEXT };
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.verb) {
      return { ok: false, code: 'structure_rejected', message: '管道段缺少命令。' + REJECTED_FEATURES_TEXT };
    }
  }

  return { ok: true, segments };
}
