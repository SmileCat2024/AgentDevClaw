// 全局安全响应头：nosniff、点击劫持防护、引用来源最小化与 CSP。
// CSP 取舍：index.html 含内联启动脚本与内联事件处理器（需 'unsafe-inline'）；
// 代码高亮 / KaTeX / diff2html / marked 均经 /vendor 同源挂载，脚本、样式
// 与字体不再有外部来源；聊天 Markdown 中的外链图片保持可见（img-src 放开
// http(s)）；远程 Claw 连接经本服务代理转发，因此 connect-src 收紧为
// 'self' 即可。
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function securityHeadersMiddleware(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  next();
}
