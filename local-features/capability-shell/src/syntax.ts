/**
 * 第一道检查点 — 语法验收（ticket 033）
 *
 * 语法 = bash 方言。优先 `bash -n`（只读不执行）；bash 缺失时降级为纯
 * shell-quote 分段 + 更保守白名单，缺席状态由调用方在启动日志声明。
 *
 * 本道是管线四道中唯一的非纯函数道（需 spawn bash）。
 */

import { spawn } from 'child_process';

export interface SyntaxCheckOptions {
  /** bash 路径（findBashPath 产物）；null = 降级模式 */
  bashPath: string | null;
  /** bash -n 超时（防挂起；缺省 5s） */
  timeoutMs?: number;
}

export interface SyntaxCheckResult {
  ok: boolean;
  /** 降级状态：bash 不可得，本次跳过 bash -n */
  degraded: boolean;
  /** bash -n 的 stderr（拒绝时给模型的诊断信息） */
  stderr?: string;
}

/** bash -n 超时上限（防挂起；正常 <100ms）。 */
const BASH_N_DEFAULT_TIMEOUT_MS = 5000;

/**
 * bash 可得性探测：复用 @agentdevjs/shell-feature 的 findGitBashPath 查找逻辑
 * （Linux/macOS: $SHELL || /bin/bash；Windows: Git Bash 常见位置）。
 *
 * 返回 null 表示 bash 不可得 → 调用方按降级模式运行并在启动日志声明。
 */
export async function findBashPath(configuredPath?: string): Promise<string | null> {
  try {
    const mod = await import('@agentdevjs/shell-feature');
    return mod.findGitBashPath(configuredPath);
  } catch {
    return null;
  }
}

export { findBashPath as resolveBashForSyntaxCheck };

/**
 * 第一道检查点：语法验收。
 *
 * - bash 可得：`bash -n`（只读解析不执行）。非零退出 → 拒绝（syntax_rejected）。
 * - bash 缺失：降级为跳过（degraded: true），后续道以更保守策略兜底。
 */
export async function checkSyntax(
  command: string,
  options: SyntaxCheckOptions,
): Promise<SyntaxCheckResult> {
  const { bashPath } = options;
  if (!bashPath) {
    // 降级：bash 不可得，跳过语法验收（缺席状态应由调用方在启动日志声明）
    return { ok: true, degraded: true };
  }

  const timeoutMs = options.timeoutMs ?? BASH_N_DEFAULT_TIMEOUT_MS;
  return new Promise<SyntaxCheckResult>((resolve) => {
    let stderr = '';

    const child = spawn(bashPath, ['-n'], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, degraded: false, stderr: stderr || 'bash -n timed out' });
    }, timeoutMs);
    timer.unref?.();

    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      // bash 进程起不来 = 降级（与缺失同态）
      resolve({ ok: true, degraded: true, stderr: String(err) });
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, degraded: false });
      } else {
        resolve({ ok: false, degraded: false, stderr: stderr.trim() });
      }
    });

    child.stdin.on('error', () => { /* EPIPE 等忽略 */ });
    child.stdin.end(command, 'utf-8');
  });
}
