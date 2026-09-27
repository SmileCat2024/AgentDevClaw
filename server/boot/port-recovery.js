/**
 * Non-destructive startup port check.
 *
 * A process that discovers another listener must never take over that
 * listener: it cannot prove ownership merely from an HTTP health response.
 * In particular, startup must not call a shutdown route or kill a process
 * tree. The caller can report the conflict and let the user decide what to do.
 */
async function fetchHealth(port, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/protoclaw/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json().catch(() => null);
  } catch (err) {
    const code = err?.cause?.code;
    if (code === 'ECONNREFUSED') return undefined; // port is free
    throw new Error(
      `端口 ${port} 被占用但无法确认服务身份；为保护现有进程，本次启动停止且不会尝试关停或终止它（${code || err?.name || 'unknown'}）`,
      { cause: err },
    );
  }
}

export async function ensureAppPortAvailable({
  port,
  probeTimeoutMs = 1200,
  log = (msg, level) => console[level === 'warn' ? 'warn' : 'log'](`[port-check] ${msg}`),
} = {}) {
  const health = await fetchHealth(port, probeTimeoutMs);
  if (health === undefined) return { action: 'clear' };

  const state = typeof health?.state === 'string' ? health.state : 'unknown';
  const pid = Number.isInteger(health?.pid) ? health.pid : null;
  const identity = state === 'unknown' ? 'unknown process' : `Claw service (state=${state})`;
  const owner = pid === null ? '' : ` pid=${pid}`;
  const message = `port ${port} is already held by ${identity}${owner}; refusing startup without stopping or killing the existing process`;
  log(message, 'warn');
  throw new Error(
    `端口 ${port} 已被 ${state === 'unknown' ? '其他或身份未知的进程' : `Claw 服务（state=${state}${pid === null ? '' : `, pid=${pid}`}）`}占用。为保护正在运行的进程，本次启动已停止；请由用户显式处理端口冲突。`,
  );
}
