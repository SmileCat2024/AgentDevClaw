import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { killProcessTree } from '../shared/process-tree.js';

const execFileAsync = promisify(execFile);

/**
 * 启动预检与旧实例接管。
 *
 * 上个实例若未退干净（清理挂住、宿主被强杀），端口会残留占用并让本次启动
 * 以 EADDRINUSE 失败。本模块在绑定端口前识别占用者身份：
 * - 端口空闲 → 直接放行；
 * - 是本产品旧实例（/protoclaw/health 响应带 state 契约字段）→ 先经
 *   /protoclaw/shutdown 优雅请退，宽限后仍存活则收割其进程树后放行；
 * - 非 Claw 进程或无法终止 → 明确报错，把决定权留给用户，不盲杀。
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHealth(port, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json().catch(() => null);
  } catch (err) {
    const code = err?.cause?.code;
    if (code === 'ECONNREFUSED') return undefined; // 端口空闲
    throw new Error(
      `端口 ${port} 被占用且探测无响应（${code || err?.name || 'unknown'}），请先手动结束占用进程`,
      { cause: err },
    );
  }
}

async function waitPortFreed(port, timeoutMs, pollIntervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    try {
      await fetch(`http://127.0.0.1:${port}/protoclaw/health`, {
        signal: AbortSignal.timeout(pollIntervalMs),
      });
    } catch (err) {
      if (err?.cause?.code === 'ECONNREFUSED') return true;
    }
  }
  return false;
}

// 旧版本实例的 health 响应不含 pid；Windows 下经 netstat 从端口反查占用者，
// 使过渡期的旧实例同样能被自动接管。查不到返回 null（非 Windows 进程组
// 语义下残留问题本身罕见，走报错路径交给用户）。
async function resolvePortOwnerPid(port) {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true, timeout: 3000, maxBuffer: 1 << 20 });
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
      if (match && Number(match[1]) === port) return Number(match[2]);
    }
  } catch {
    // netstat 不可用时按未知处理
  }
  return null;
}

export async function ensureAppPortRecoverable({
  port,
  probeTimeoutMs = 1200,
  gracefulWaitMs = 8000,
  killWaitMs = 5000,
  pollIntervalMs = 300,
  log = (msg, level) => console[level === 'warn' ? 'warn' : 'log'](`[port-recovery] ${msg}`),
} = {}) {
  const health = await fetchHealth(port, probeTimeoutMs);
  if (health === undefined) return { action: 'clear' };

  if (!health || typeof health.state !== 'string') {
    throw new Error(`端口 ${port} 被非 Claw 进程占用，请先手动结束占用进程`);
  }
  let pid = Number.isInteger(health.pid) ? health.pid : null;
  if (pid === null) {
    pid = await resolvePortOwnerPid(port);
  }
  if (pid === null) {
    throw new Error(
      `端口 ${port} 上的 Claw 旧实例无法定位 pid，请先手动结束它后再启动`,
    );
  }
  log(`detected previous Claw instance pid=${pid} (state=${health.state}), requesting shutdown`);
  try {
    await fetch(`http://127.0.0.1:${port}/protoclaw/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
  } catch {
    // 优雅请求失败不阻塞：后续宽限与强杀路径会接管。
  }

  if (await waitPortFreed(port, gracefulWaitMs, pollIntervalMs)) {
    log(`previous instance pid=${pid} exited gracefully`);
    return { action: 'recovered-graceful', pid };
  }

  log(`previous instance pid=${pid} still holding port after ${gracefulWaitMs}ms, killing process tree`, 'warn');
  const killed = await killProcessTree(pid);
  if (!killed) {
    throw new Error(`无法终止残留实例 pid=${pid}（端口 ${port}），请手动处理`);
  }
  if (await waitPortFreed(port, killWaitMs, pollIntervalMs)) {
    log(`previous instance pid=${pid} terminated by force`);
    return { action: 'recovered-killed', pid };
  }
  throw new Error(`残留实例 pid=${pid} 已终止但端口 ${port} 仍被占用，请手动检查`);
}
