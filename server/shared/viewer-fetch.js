/**
 * viewer-fetch.js — server 进程对本地 ViewerWorker HTTP 面的统一消费入口
 *
 * ADR-0037 M5-A：非回环 HTTP 绑定（AGENTDEV_VIEWER_HTTP_BIND）时 ViewerWorker
 * 全端点强制 Bearer（PROTOCLAW_INTERNAL_TOKEN）。server 自身的 viewer 消费面
 * （READY 确认、interrupt、群聊状态查询、本地 viewer 代理）是平台的合法内部
 * 客户端，统一经此入口携带内部 token；回环模式 viewer 不校验，多余 header
 * 无害。token 与 viewer 校验端同源读 env（auth 初始化写入）。
 *
 * headers 合并必须经 Headers 实例：调用方（如 proxy.js 的本地 viewer 转发）
 * 传入的 init.headers 是 Headers 实例，对象展开会把它展成空对象，转发请求
 * 的 content-type / 操作元数据头会整体丢失。
 */

function viewerAuthHeaders() {
  const token = typeof process.env.PROTOCLAW_INTERNAL_TOKEN === 'string'
    ? process.env.PROTOCLAW_INTERNAL_TOKEN.trim()
    : '';
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * 内部认证 header 的裸导出：供无法整体改走 viewerFetch 的调用方（如
 * user-turn 的本地/远程双基址 fetch）按基址选择性注入。仅对本地 viewer
 * 基址有意义——远程隧道端 token 不同，注入反而制造 401。
 */
export { viewerAuthHeaders };

function withViewerAuth(init) {
  const auth = viewerAuthHeaders();
  // 回环无 token：init 原样直通，Headers 实例 / 普通对象两种形态都不动。
  if (!Object.keys(auth).length) return init;
  const headers = new Headers(init.headers || undefined);
  for (const [key, value] of Object.entries(auth)) headers.set(key, value);
  return { ...init, headers };
}

export async function viewerFetch(origin, pathname, init = {}) {
  return fetch(`${origin}${pathname}`, withViewerAuth(init));
}

/** 完整 URL 变体：本地 viewer 代理转发（URL 已拼好）统一补内部 token。 */
export async function viewerFetchUrl(url, init = {}) {
  return fetch(url, withViewerAuth(init));
}
