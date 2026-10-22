/** Domain commands run through existing adapters; Bash evaluation stays in just-bash. */
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path/posix';
import { Bash, ReadWriteFs, defineCommand, decodeBytesToUtf8 } from 'just-bash';
import { checkArgs, validateParamValue } from './args.js';
import { runCollectedSpawn } from './dispatch.js';
import type { AdapterMap, CommandExecution } from './dispatch.js';
import { SHELL_COMMANDS, instrumentProgram } from './bash-program.js';
import type { BashProgram, BashRejection } from './bash-program.js';
import type { CapabilityShellPolicy } from './types.js';

export interface BashRuntimeOptions {
  adapters?: AdapterMap;
  signal?: AbortSignal;
  workdir?: string;
  termination?: () => 'timeout' | 'user' | null;
  help: string;
}

export async function executeBashProgram(policy: CapabilityShellPolicy, program: BashProgram, options: BashRuntimeOptions, source: string) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const commands: CommandExecution[] = [];
  let rejection: BashRejection;
  const fs = new ReadWriteFs({ root: options.workdir ?? process.cwd() });
  // Private names are generated only after AST validation; user source cannot invoke them.
  const prefix = `__claw_${randomBytes(12).toString('hex')}`;
  const names = program.commands.map((_, index) => `${prefix}_${index}`);
  const guardName = `${prefix}_redirect`;
  const reject = (message: string) => {
    rejection ??= { code: 'arg_rejected', stage: 'args', message };
    controller.abort();
    return { stdout: '', stderr: `${message}\n`, exitCode: 1 };
  };
  const customCommands = program.commands.map((command, index) => defineCommand(names[index], async (args, context) => {
    if (signal.aborted) return { stdout: '', stderr: '工具已终止，命令未启动。', exitCode: 130 };
    const check = checkArgs([{ verb: command.verb, args }], policy.verbs);
    if (!check.ok) return reject(check.message);
    const decl = policy.verbs[command.verb];
    const record: CommandExecution = { index, verb: command.verb, status: 'executed', ok: false, output: '' };
    commands.push(record);
    try {
      const adapter = options.adapters?.[decl.adapter.key];
      const argv = [...(decl.adapter.argPrefix ?? []), ...args];
      const stdin = decodeBytesToUtf8(context.stdin);
      if (adapter) {
        const value = await adapter(argv, { stdin, signal, termination: options.termination });
        Object.assign(record, typeof value === 'string' ? { ok: true, output: value } : value);
      } else {
        const run = await runCollectedSpawn(decl.adapter.key, argv, { input: stdin, signal, workdir: options.workdir });
        Object.assign(record, { ok: run.ok, terminated: run.terminated,
          output: run.ok ? run.stdout : [run.stdout, run.stderr || `退出码 ${run.exitCode}`].filter(Boolean).join('\n') });
      }
    } catch (error) { record.output = String(error); }
    if (record.terminated || signal.aborted) {
      record.ok = false;
      record.terminated = true;
      controller.abort();
    }
    return { stdout: record.ok ? record.output : '', stderr: record.ok ? '' : `${record.output}\n`,
      exitCode: record.terminated ? 130 : record.ok ? 0 : 1, stdoutKind: 'text' as const };
  }));
  customCommands.push(defineCommand(guardName, async ([mode, target]) => {
    if (signal.aborted) return { stdout: '', stderr: '工具已终止。', exitCode: 130 };
    const message = validateParamValue(target, { name: 'redirect', kind: 'path' });
    if (!target || message || target.includes('\\')) return reject(message || '重定向要求非空 workspace 相对路径，使用 / 分隔。');
    const path = `/${target}`;
    try {
      // Validate before command side effects, not just when output gets written.
      await fs.stat(dirname(path));
      try {
        const stat = await fs.lstat(path);
        if (stat.isSymbolicLink || !stat.isFile) return reject('重定向不接受符号链接或非普通文件。');
      } catch (error) {
        if (mode !== 'write' || !String(error).includes('ENOENT')) throw error;
      }
      if (mode === 'read') await fs.stat(path);
      return { stdout: path, stderr: '', exitCode: 0 };
    } catch (error) { return reject(`重定向路径不可用：${String(error)}`); }
  }));
  customCommands.push(defineCommand('help', async () => ({ stdout: options.help, stderr: '', exitCode: 0 })));
  const bash = new Bash({
    fs, cwd: '/', env: {}, commands: SHELL_COMMANDS.filter((name) => name !== '[' && name !== 'test'), customCommands,
    // All callbacks are trusted host adapters, not guest JS. Do not patch host globals.
    defenseInDepth: false,
    executionLimits: { maxExecutionTimeMs: Infinity, maxLoopIterations: 10_000,
      maxCommandCount: 20_000, maxOutputSize: 32 * 1024 * 1024 },
  });
  const ast = instrumentProgram(program, names, guardName);
  let entered = false;
  bash.registerTransformPlugin({ name: 'domain-validated-program', transform: () => {
    if (entered) {
      reject('不接受将字符串重新解释为脚本；请使用已校验的命令替换。');
      throw new Error('Dynamic script execution is not allowed');
    }
    entered = true;
    return { ast };
  } });
  let result: { stdout: string; stderr: string; exitCode: number };
  try { result = await bash.exec(source, { signal, rawScript: true }); }
  catch (error) { result = { stdout: '', stderr: String(error), exitCode: 1 }; }
  const seen = new Set(commands.map((command) => command.index));
  for (let index = 0; index < program.commands.length; index++) {
    if (!seen.has(index)) commands.push({ index, verb: program.commands[index].verb, ok: false,
      status: signal.aborted ? 'not-executed' : 'skipped',
      output: signal.aborted ? '工具已终止，未执行。' : '分支或条件未执行。' });
  }
  const ok = result.exitCode === 0 && !signal.aborted && !rejection;
  const text = [signal.aborted ? 'terminated：工具已终止；已发生的领域操作不回滚。' : '',
    result.stdout, result.stderr,
    ...(!program.grouped && signal.aborted ? commands.map((command) => command.output) : []),
    rejection?.message,
    !ok && !result.stdout && !result.stderr && !signal.aborted && !rejection ? `退出码 ${result.exitCode}` : '',
  ].filter(Boolean).join('\n');
  // Receipts stay outside shell stdout: substitutions/pipes see only command output.
  const receipts = program.grouped ? commands.map((command) =>
    `[${command.index + 1}] ${command.verb} ${command.status} ${command.ok ? 'ok' : 'failed'}\n${command.output}`).join('\n\n') : '';
  return { ok, output: [text, receipts].filter(Boolean).join('\n\n'), commands,
    ...(rejection ? { rejection } : !ok ? { rejection: { code: 'dispatch_failed' as const, stage: 'dispatch' as const,
      message: text || (signal.aborted ? '工具已终止。' : `退出码 ${result.exitCode}`) } } : {}) };
}
