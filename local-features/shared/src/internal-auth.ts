/**
 * Agent → Claw Server 内部调用的认证头。
 *
 * Claw server 开启登录保护后，/protoclaw 等路径要求认证；agent runtime
 * 子进程经 PROTOCLAW_INTERNAL_TOKEN 环境变量持有内部服务 token，随请求
 * 以 Bearer 头出示。与 server/shared/internal-auth.js 保持同一语义：
 * 未注入 token 时（server 未开启保护、或独立运行的测试进程）不添加
 * Authorization 头，行为与无保护时一致。
 */

export function internalAuthHeaders(
  headers: Record<string, string> = {},
  token: string | undefined = process.env.PROTOCLAW_INTERNAL_TOKEN,
): Record<string, string> {
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  return normalizedToken
    ? { ...headers, Authorization: `Bearer ${normalizedToken}` }
    : { ...headers };
}
