import { parseRemoteNamespace, resolveHostTarget } from './request-target.js';
import { getProxyConnectionLookup } from './proxy.js';

// ADR-0011：protoclaw 域远程适配的共享取用。转发基址、裸 id、命名空间 →
// 显式 host target，供路由内远程分支复用。连接查找复用宿主装配进 proxy.js
// 的 ConnectionStore（server.js 单点注册，测试可注入替身）。

/**
 * 转发基址：远程 target 用隧道 origin，本地 target 用本地 viewerOrigin。
 * 远程 target 上 viewerOrigin 为 undefined，直接拼 URL 会产生 "undefined/…"。
 */
export function forwardBase(target) {
  return target?.origin || target?.viewerOrigin || null;
}

/**
 * 裸 id：剥离 remote:<connId>: 前缀；非命名空间 id 原样返回。
 */
export function bareId(value) {
  if (typeof value !== 'string') return value;
  const namespace = parseRemoteNamespace(value);
  return namespace ? namespace.agentId : value;
}

/**
 * 从一组身份候选（runtimeId / agentId / sessionId…）解析显式 host target：
 * 第一个携带 remote: 命名空间的身份派生 connectionId（ADR-0008 #5：host 默认
 * 本地、远程必须显式）；全为本地身份时返回 { scope: 'local' }。未知或停用
 * 连接按 request-target 的契约抛 RequestTargetError（target_not_found 404 /
 * transport_unavailable 503 retryable）。
 */
export function resolveForwardHostTarget(...identities) {
  for (const value of identities) {
    if (typeof value !== 'string' || !value) continue;
    const namespace = parseRemoteNamespace(value);
    if (!namespace) continue;
    return resolveHostTarget(
      { connectionId: namespace.connectionId },
      { findConnection: getProxyConnectionLookup() },
    );
  }
  return { scope: 'local' };
}
