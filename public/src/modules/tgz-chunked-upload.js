/**
 * tgz-chunked-upload.js — 插件包 tgz 上传（直传 / 分片自适应）
 *
 * 公网部署常经反向代理暴露（如 nginx 默认 client_max_body_size 仅 1MB），
 * 单请求传大 tgz 会在到达应用前被网关以 413 拒绝。行业标准解法是分片
 * 上传（S3 Multipart / tus 同思路）：
 *   - 小包（≤ 直传阈值）仍走 parse_upload 单请求，行为与升级前一致；
 *   - 大包切 512KB 分片（低于常见网关默认限制，同时规避慢速公网下
 *     Node 默认 5 分钟 requestTimeout 对单请求接收期的约束），并发 3
 *     逐块传输；服务端拼装后返回与 parse_upload 同形的
 *     { uploadId, summary }，后续 confirm / cancel 流程不变。
 *
 * 失败路径：任何一步失败 best-effort 调 chunk_abort 让服务端立即回收
 * 会话（不等 TTL 清理）；错误信息带 HTTP 状态码，便于区分网关拒绝
 * （413）与应用错误。
 *
 * 消费方：feature-store.js（插件管理器）、fw-config-panel.js（工作空间
 * 配置面板的 Feature 导入）。测试：test/frontend-tgz-chunked-upload.test.js
 */

const DIRECT_UPLOAD_MAX_BYTES = 512 * 1024;
const CHUNK_SIZE = 512 * 1024;
const CHUNK_CONCURRENCY = 3;

async function responseError(prefix, resp) {
  const detail = await resp.text().catch(() => '');
  // 网关错误页可能是整页 HTML，只保留头部一截避免弹窗被撑爆
  const trimmed = String(detail).replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(trimmed ? `${prefix} HTTP ${resp.status}: ${trimmed}` : `${prefix} HTTP ${resp.status}`);
}

/**
 * 上传 tgz 并解析，返回 { uploadId, summary }（两个路径同形）。
 * onProgress(0..1) 随分片完成推进（直传路径在完成时回调一次 1）。
 * agentId：导入归属——缺省/空 = 全局用户仓库；有值 = 该工作空间私有仓库
 * （ADR-0046 空间级仓库）。
 */
export async function uploadTgzChunked(file, { onProgress, agentId } = {}) {
  if (!(file instanceof File) || typeof file.size !== 'number' || file.size < 1) {
    throw new Error('invalid file');
  }
  const scope = typeof agentId === 'string' && agentId.trim() ? agentId.trim() : '';
  if (file.size <= DIRECT_UPLOAD_MAX_BYTES) {
    const formData = new FormData();
    formData.append('file', file);
    if (scope) formData.append('agentId', scope);
    const resp = await fetch('/protoclaw/feature_repository/parse_upload', { method: 'POST', body: formData });
    if (!resp.ok) throw await responseError('parse upload failed', resp);
    onProgress?.(1);
    return resp.json();
  }

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const initResp = await fetch('/protoclaw/feature_repository/chunk_init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, totalChunks, totalSize: file.size, ...(scope ? { agentId: scope } : {}) }),
  });
  if (!initResp.ok) throw await responseError('chunk init failed', initResp);
  const { uploadId } = await initResp.json();

  try {
    const pending = Array.from({ length: totalChunks }, (_, i) => i);
    let done = 0;
    const worker = async () => {
      for (;;) {
        const index = pending.shift();
        if (index === undefined) return;
        const form = new FormData();
        form.append('file', file.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), file.name);
        const resp = await fetch(
          `/protoclaw/feature_repository/chunk_append?uploadId=${encodeURIComponent(uploadId)}&index=${index}`,
          { method: 'POST', body: form },
        );
        if (!resp.ok) throw await responseError(`chunk ${index} failed`, resp);
        done += 1;
        onProgress?.(done / totalChunks);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, totalChunks) }, worker));

    const completeResp = await fetch('/protoclaw/feature_repository/chunk_complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    });
    if (!completeResp.ok) throw await responseError('chunk complete failed', completeResp);
    return completeResp.json();
  } catch (error) {
    // best-effort 中止：让服务端立即回收会话与临时文件（不等 TTL）
    fetch('/protoclaw/feature_repository/chunk_abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId }),
    }).catch(() => {});
    throw error;
  }
}
