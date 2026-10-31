/**
 * external-runtime-registry.js — 外部 runtime 平台注册记录（ADR-0037 决策 4）
 *
 * 与 managedAgents（agent-access.js）平行的进程内注册表。托管 runtime 的
 * 生命周期权威在 server（spawn / 退出事件强绑定 ChildProcess）；外部 runtime
 * 的生命周期权威在 runtime 自身进程——server 只持有其注册声明，记录不落盘，
 * 服务重启后由 runtime 重新注册。存活呈现（connected）仍以 ViewerWorker
 * 连接状态为准，本表为声明过注册的外部 runtime 提供停止通道目标与目录等
 * 归属补充。
 */
const externalRuntimes = new Map();

function normalizeKey(viewerAgentId) {
  return String(viewerAgentId || '').trim();
}

export function registerExternalRuntime({ viewerAgentId, name = '', projectRoot = '' }) {
  const key = normalizeKey(viewerAgentId);
  if (!key) return null;
  const now = new Date().toISOString();
  const existing = externalRuntimes.get(key);
  const record = {
    viewerAgentId: key,
    name: String(name || existing?.name || ''),
    projectRoot: String(projectRoot || existing?.projectRoot || ''),
    registeredAt: existing?.registeredAt || now,
    lastSeenAt: now,
  };
  externalRuntimes.set(key, record);
  return { ...record };
}

export function removeExternalRuntime(viewerAgentId) {
  return externalRuntimes.delete(normalizeKey(viewerAgentId));
}

export function getExternalRuntime(viewerAgentId) {
  const record = externalRuntimes.get(normalizeKey(viewerAgentId));
  return record ? { ...record } : null;
}

export function listExternalRuntimes() {
  return Array.from(externalRuntimes.values()).map((record) => ({ ...record }));
}
