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

/** Plain strings mean command success; failures must throw or explicitly return ok:false. */
export interface CommandResult {
  ok: boolean;
  output: string;
  terminated?: boolean;
}
export interface CommandExecution extends CommandResult {
  index: number;
  verb: string;
  status: 'executed' | 'skipped' | 'not-executed';
}

/** 进程内 adapter：接收校验后参数；有上游管道数据时经 ctx.stdin 接收。 */
export type InProcessAdapter = (
  args: string[],
  context?: {
    stdin: string;
    /** 框架终止原因（'timeout' | 'user' | null）；仅声明 timeout 的工具注入（ticket 034） */
    termination?: () => 'timeout' | 'user' | null;
    /** 框架合并 signal（Tool.timeout / 用户打断共用，ADR-0005） */
    signal?: AbortSignal;
  },
) => Promise<string | CommandResult>;

/** adapter map：adapter 键 → 进程内实现。由工具工厂注入以便测试。 */
export type AdapterMap = Record<string, InProcessAdapter>;

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
  options: { input?: string | null; signal?: AbortSignal; workdir?: string; env?: Record<string, string> } = {},
): Promise<SpawnRunResult> {
  return new Promise<SpawnRunResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.workdir,
      env: options.env ? { ...process.env, ...options.env } : undefined,
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

    const cleanup = () => {
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
        // （spawn 已发生，必须 kill 防止 detached 子进程泄漏）。本分支自管
        // resolve：close 或兜底计时二者先到者收尾（不与后续 settled 检查竞争）。
        let settledHere = false;
        const settleTerminated = () => {
          if (settledHere) return;
          settledHere = true;
          cleanup();
          resolve({ ok: true, stdout: '', stderr: '', exitCode: null, terminated: true });
        };
        killChild();
        const timer = setTimeout(settleTerminated, SPAWN_KILL_FALLBACK_MS);
        timer.unref?.();
        child.once('close', () => {
          clearTimeout(timer);
          settleTerminated();
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
