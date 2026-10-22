/** Bash AST validation. Syntax is independent of the domain command allow-list. */
import { parse } from 'just-bash';
import type { ScriptNode, SimpleCommandNode, WordNode } from 'just-bash';
import { checkArgs, validateParamValue } from './args.js';
import { checkVerbs } from './verbs.js';
import type { CapabilityShellPolicy } from './types.js';

export const SHELL_COMMANDS = ['echo', 'printf', 'true', 'false', 'test', '['] as const;
export const SHELL_BUILTINS = [':', 'read', 'set', 'break', 'continue', 'local', 'declare', 'typeset',
  'export', 'readonly', 'unset', 'return', 'shift', 'exit'] as const;
export const BASH_SYNTAX_DESCRIPTION = 'Bash 语法：变量/数组、for/while/until、if/case、函数、算术、命令替换、管道、;、&&、||、重定向与 heredoc。'
  + '领域命令按动词表和展开后的参数校验；命令名必须静态明确。通用辅助命令仅 echo/printf/true/false/test/[ 及变量、循环控制内建。'
  + '不开放任意系统命令、eval/source/exec、进程替换或后台 &；算术/数组下标内先用变量代替命令替换。'
  + '重定向限 workspace 相对路径且不跟随符号链接。脚本只在本次调用内执行，不挂起续跑；循环上限 10000 次、命令上限 20000 次。';

export interface BashRejection {
  code: 'syntax_rejected' | 'structure_rejected' | 'unknown_verb' | 'arg_rejected';
  stage: 'syntax' | 'structure' | 'verb' | 'args';
  message: string;
  segmentIndex?: number;
}
export interface DomainCommand {
  node: SimpleCommandNode;
  verb: string;
  /** Null means arguments need expansion and must be checked at execution time. */
  args: string[] | null;
}
export interface BashProgram {
  ast: ScriptNode;
  commands: DomainCommand[];
  grouped: boolean;
}

/** Only syntax-free word parts are statically known; never expand with host env. */
export function literalWord(word: WordNode): string | null {
  let text = '';
  for (const part of word.parts) {
    if (part.type === 'Literal' || part.type === 'SingleQuoted' || part.type === 'Escaped') text += part.value;
    else if (part.type === 'DoubleQuoted') {
      const value = literalWord({ type: 'Word', parts: part.parts });
      if (value === null) return null;
      text += value;
    } else return null;
  }
  return text;
}

export function parseBashProgram(command: string, policy: CapabilityShellPolicy): BashProgram | BashRejection {
  let ast: ScriptNode;
  try {
    if (!command.trim()) throw new Error('命令为空。');
    ast = parse(command);
  } catch (error) {
    return { code: 'syntax_rejected', stage: 'syntax', message: String(error) };
  }
  const commands: DomainCommand[] = [];
  const functions = new Set<string>();
  const forbidden = new Set(['eval', 'source', '.', 'exec', 'command', 'builtin', 'trap', 'bash', 'sh',
    'enable', 'alias', 'unalias', 'coproc']);
  let rejection: BashRejection;
  let grouped = ast.statements.length > 1;
  const reject = (message: string) => {
    rejection ??= { code: 'structure_rejected', stage: 'structure', message };
  };
  const auxiliary = new Set<string>([...SHELL_COMMANDS, ...SHELL_BUILTINS, 'help']);
  const walk = (value: unknown, visit: (node: any) => void) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const child of value) walk(child, visit); return; }
    visit(value);
    for (const child of Object.values(value)) walk(child, visit);
  };
  walk(ast, (node) => {
    if (node.type === 'FunctionDef') {
      grouped = true;
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(node.name) || auxiliary.has(node.name) || forbidden.has(node.name)
        || Object.hasOwn(policy.verbs, node.name)) reject(`函数不得覆盖领域或内建命令：${node.name}`);
      functions.add(node.name);
    }
  });
  walk(ast, (node) => {
    if (node.type === 'Statement') {
      if (node.deferredError) rejection ??= { code: 'syntax_rejected', stage: 'syntax', message: node.deferredError.message };
      if (node.background) reject('不支持后台 &；后台执行由领域命令负责。');
      if (node.pipelines.length > 1) grouped = true;
    }
    if (['For', 'CStyleFor', 'While', 'Until', 'If', 'Case', 'Group', 'Subshell'].includes(node.type)) grouped = true;
    if (node.type === 'CommandSubstitution') grouped = true;
    if (node.type === 'ProcessSubstitution') reject('不支持进程替换。');
    if (node.type === 'ArithCommandSubst') reject('算术表达式内不接受命令替换；请先用变量捕获命令结果。');
    if ((node.type === 'Assignment' && /\$\(|`/.test(node.name))
      || (node.type === 'ParameterExpansion' && /\$\(|`/.test(node.parameter))) {
      reject('数组下标内不接受命令替换；请先用变量捕获命令结果。');
    }
    if (node.type === 'Transform' && node.operator === 'P') reject('不支持提示符执行展开 @P。');
    if (node.type === 'Redirection') {
      if (!['<', '>', '>>', '<<', '<<-', '<<<', '>&'].includes(node.operator) || node.fdVariable) {
        reject(`不支持的重定向：${node.operator}`);
      } else if (node.operator === '>&') {
        if (node.target.type !== 'Word' || !['1', '2'].includes(literalWord(node.target))) reject('文件描述符重定向仅支持 >&1 / >&2。');
      } else if (['<', '>', '>>'].includes(node.operator) && node.target.type === 'Word') {
        const path = literalWord(node.target);
        if (path !== null) {
          const message = validateParamValue(path, { name: 'redirect', kind: 'path' });
          if (message || path.includes('\\')) rejection ??= { code: 'arg_rejected', stage: 'args', message: message || '重定向路径请使用 /。' };
        }
      }
    }
    if (node.type === 'SimpleCommand' && !node.name && !node.assignments.length && !node.redirections.length) {
      rejection ??= { code: 'syntax_rejected', stage: 'syntax', message: '连接符前后缺少命令。' };
    }
    if (node.type !== 'SimpleCommand' || !node.name) return;
    const verb = literalWord(node.name);
    if (verb === null || !verb) { reject('命令名必须是静态领域动词或允许的辅助命令，不能由变量或命令替换生成。'); return; }
    if (forbidden.has(verb)) {
      rejection ??= { code: 'unknown_verb', stage: 'verb', message: `不开放命令入口：${verb}。` };
      return;
    }
    if (!Object.hasOwn(policy.verbs, verb)) {
      if ((!auxiliary.has(verb) && !functions.has(verb)) || Object.hasOwn(policy.unknownVerbHints ?? {}, verb)) {
        const check = checkVerbs(policy.name, [{ verb, args: [] }], policy.verbs, policy.unknownVerbHints);
        rejection ??= { code: 'unknown_verb', stage: 'verb', message: check.message };
      }
      return;
    }
    const args = node.args.map(literalWord);
    const known = args.every((arg) => arg !== null) ? args as string[] : null;
    const index = commands.length;
    commands.push({ node, verb, args: known });
    if (known) {
      const check = checkArgs([{ verb, args: known }], policy.verbs);
      if (!check.ok) rejection ??= { code: 'arg_rejected', stage: 'args', message: check.message, segmentIndex: index };
    }
  });
  return rejection ?? { ast, commands, grouped };
}

/** Replace only command entry points and redirect targets; the interpreter owns Bash semantics. */
export function instrumentProgram(program: BashProgram, commandNames: string[], redirectGuard: string): ScriptNode {
  for (let index = 0; index < program.commands.length; index++) {
    program.commands[index].node.name = { type: 'Word', parts: [{ type: 'Literal', value: commandNames[index] }] };
  }
  let redirectIndex = 0;
  const walk = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(walk);
    for (const key of Object.keys(value)) value[key] = walk(value[key]);
    const redirects = (value.redirections ?? []).filter((redirect) => ['<', '>', '>>'].includes(redirect.operator));
    if (!redirects.length) return value;
    const assignments = redirects.map((redirect) => {
      const variable = `${redirectGuard}_${redirectIndex++}`;
      const assignment = parse(`${variable}=$(${redirectGuard} ${redirect.operator === '<' ? 'read' : 'write'})`).statements[0];
      const word = (assignment.pipelines[0].commands[0] as SimpleCommandNode).assignments[0].value;
      const substitution = word.parts[0];
      if (substitution.type === 'CommandSubstitution') {
        (substitution.body.statements[0].pipelines[0].commands[0] as SimpleCommandNode).args.push({
          type: 'Word', parts: [{ type: 'DoubleQuoted', parts: redirect.target.parts }],
        });
      }
      redirect.target = { type: 'Word', parts: [{ type: 'DoubleQuoted', parts: [
        { type: 'ParameterExpansion', parameter: variable, operation: null },
      ] }] };
      return assignment;
    });
    // Evaluate each target exactly once before the command; redirects themselves may
    // be evaluated more than once by the interpreter. Private variables carry data only.
    return { type: 'Group', body: [...assignments, { type: 'Statement', pipelines: [
      { type: 'Pipeline', commands: [value], negated: false },
    ], operators: [], background: false }], redirections: [] };
  };
  return walk(program.ast);
}
