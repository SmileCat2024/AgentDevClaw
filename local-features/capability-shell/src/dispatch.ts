/**
 * 分派层 — adapter map 分派与数组 spawn（ticket 033）
 *
 * 动词校验通过后按声明的 adapter 分派：
 * - 进程内函数：直接调用，接收校验后的参数数组
 * - 文本工具（spawn）：数组 spawn，上游 stdout 写下游 stdin（内存串流，
 *   不落盘、不进 env）；终止语义沿用 ADR-0005（signal aborted 即终止收集）。
 *
 * 执行层参照 @agentdevjs/shell-feature shell-core 的 spawn 管线语义实现
 * （runCollectedProcess 未从包入口导出，框架仓库不可修改；此处按同一契约
 * 实现数组 spawn：终止时 kill 进程组 → drain → resolve 部分输出）。
 */

import { spawn } from 'child_process';

/** 进程内 adapter：接收校验后参数；有上游管道数据时经 ctx.stdin 接收。 */
export type InProcessAdapter = (args: string[], context?: { stdin: string }) => Promise<string>;

/** adapter map：adapter 键 → 进程内实现。由工具工厂注入以便测试。 */
export type AdapterMap = Record<string, InProcessAdapter>;

export interface DispatchResult {
  ok: boolean;
  /** 输出文本（管道最后一段的 stdout，或进程内函数返回值） */
  output?: string;
  /** 失败错误码 */
  code?: 'dispatch_failed';
  message?: string;
}

/** 已校验的管道段（第三/四道检查点通过后的产物）。 */
export interface DispatchSegment {
  verb: string;
  args: string[];
  /** adapter map 中的键 */
  adapterKey: string;
  /** 该段的分派形态：'function'（进程内）或 'spawn'（数组 spawn 段） */
  kind: 'function' | 'spawn';
}

export interface DispatchOptions {
  /** 进程内函数 adapter map（注入以便测试） */
  adapters?: AdapterMap;
  /** 框架注入的合并 signal（用户打断与框架超时共用，ticket 023） */
  signal?: AbortSignal;
  /** spawn 工作目录 */
  workdir?: string;
}

/**
 * 分派执行一组已校验的管道段。
 *
 * - 段声明的 adapter 键命中 adapter map → 进程内函数：直接调用；
 *   若存在上游管道数据，以上下文成员 `stdin` 传入（适配器自行决定是否消费）。
 * - 未命中 adapter map 的段按 spawn 命令处理：数组 spawn，上游 stdout
 *   写下游 stdin（内存串流，不落盘、不进 env）。
 * - signal aborted：整条链以终止态收尾（kill → 收集部分输出，ADR-0005）。
 */
export async function dispatchPipeline(
  segments: DispatchSegment[],
  options: DispatchOptions,
): Promise<DispatchResult> {
  if (segments.length === 0) {
    return { ok: false, code: 'dispatch_failed', message: '没有可执行的命令段。' };
  }

  const adapters = options.adapters ?? {};
  let upstream: string | null = null;

  try {
    for (const seg of segments) {
      const fn = adapters[seg.adapterKey];
      if (typeof fn === 'function') {
        // 进程内函数：接收校验后参数；上游管道数据经 ctx.stdin 传入
        const result = await fn(seg.args.slice(), { stdin: upstream ?? '' });
        upstream = typeof result === 'string' ? result : String(result ?? '');
      } else {
        // spawn 段：adapterKey 即可执行名；上游输出写 stdin
        const run = await runCollectedSpawn(seg.adapterKey, seg.args, {
          input: upstream,
          signal: options.signal,
          workdir: options.workdir,
        });
        if (!run.ok) {
          return {
            ok: false,
            code: 'dispatch_failed',
            message: `命令 “${seg.adapterKey}” 执行失败：${detailFrom(run)}`,
          };
        }
        upstream = run.stdout;
      }
    }

    return { ok: true, output: upstream ?? '' };
  } catch (err) {
    return { ok: false, code: 'dispatch_failed', message: String(err) };
  }
}

function detailFrom(result: SpawnRunResult): string {
  if (result.terminated) return '命令被终止（中断/超时），已收集部分输出。';
  if (result.stderr.trim()) return result.stderr.trim();
  return `退出码 ${result.exitCode ?? 'unknown'}`;
}

/** 单段 spawn 的 collect 结果。 */
export interface SpawnRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** 终止态（signal aborted：kill 后 resolve 部分输出，ADR-0005 中断即结果） */
  terminated?: boolean;
}

/**
 * 单段进程 spawn（collect 模式，参照 shell-feature shell-core 语义）：
 * - 正常完成：resolve stdout/stderr/exitCode（非 0 → ok: false，不 throw）
 * - signal aborted：kill → drain 到 EOF → resolve 已积累输出（terminated: true）
 */
export async function runCollectedSpawn(
  command: string,
  args: string[],
  options: { input?: string | null; signal?: AbortSignal; workdir?: string } = {},
): Promise<SpawnRunResult> {
  return new Promise<SpawnRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // POSIX 下独立进程组，abort 时可整组 kill（shell-feature 同款语义）
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    const killChild = () => {
      try {
        if (child.pid != null && process.platform !== 'win32') {
          process.kill(-child.pid, 'SIGKILL'); // 进程组
        } else {
          child.kill('SIGKILL');
        }
      } catch { /* 已退出 */ }
    };

    const timer = setTimeout(() => {
      // 兜底：kill 后等 close 事件收尾（正常 abort 路径不走这里）
      if (!settled) {
        settled = true;
        cleanup();
        resolve({ ok: false, stdout, stderr, exitCode: null, terminated: true });
      }
    }, SPAWN_KILL_FALLBACK_MS);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      killChild();
      // 终止收集（ADR-0005 中断即结果）：立即 resolve 已积累输出
      resolve({ ok: false, stdout, stderr, exitCode: null, terminated: true });
    };

    if (options.signal) {
      if (options.signal.aborted) {
        // 执行前已中断：kill 刚 spawn 的进程，等 close 释放句柄后以终止态收尾
        // （spawn 已发生，必须 kill 防止 detached 子进程泄漏）
        settled = true;
        killChild();
        child.once('close', () => {
          clearTimeout(timer);
          resolve({ ok: true, stdout: '', stderr: '', exitCode: null, terminated: true });
        });
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      // ENOENT 等起不来的情况：ok=false，stderr 带诊断
      resolve({ ok: false, stdout, stderr: stderr + String(err), exitCode: null });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });

    if (options.input != null) {
      child.stdin.on('error', () => { /* EPIPE（下游提前退出）忽略 */ });
      child.stdin.end(options.input, 'utf-8');
    } else {
      child.stdin.end();
    }
  });
}

/** SPAWN_KILL 兜底：kill 后等待 EOF 的上限（孙进程占 pipe 兜底）。 */
const SPAWN_KILL_FALLBACK_MS = 1000;
