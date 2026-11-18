import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { uploadTgzChunked } from '../public/src/modules/tgz-chunked-upload.js';

// tgz-chunked-upload 纯逻辑 + fetch：真实 ESM 导入（不走 vm 沙箱），注入面
// 只 stub 全局 fetch。契约：小包单请求直传；大包 init → append×N（并发、
// 512KB 切片）→ complete；任一步失败抛带 HTTP 状态码的错误并 best-effort
// abort 服务端会话。

const CHUNK_SIZE = 512 * 1024;

function makeFile(size, name = 'demo-plugin-1.0.0.tgz') {
  return new File([Buffer.alloc(size, 7)], name);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('uploadTgzChunked', () => {
  let calls;
  let realFetch;

  beforeEach(() => {
    calls = [];
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const installRouter = (routes) => {
    globalThis.fetch = async (url, init = {}) => {
      const clean = String(url);
      calls.push({ url: clean, method: init.method || 'GET', body: init.body });
      for (const [pattern, handler] of routes) {
        if (clean.includes(pattern)) return handler(clean, init, calls.length - 1);
      }
      return jsonResponse({ error: `unexpected url ${clean}` }, 500);
    };
  };

  const callCount = (fragment) => calls.filter((c) => c.url.includes(fragment)).length;

  it('小包（≤512KB）单请求直传 parse_upload，不触分片端点，onProgress(1)', async () => {
    installRouter([
      ['/protoclaw/feature_repository/parse_upload', () => jsonResponse({ uploadId: 'direct-1', summary: { name: 'demo' } })],
    ]);
    const progress = [];
    const result = await uploadTgzChunked(makeFile(CHUNK_SIZE), { onProgress: (p) => progress.push(p) });
    assert.equal(result.uploadId, 'direct-1');
    assert.equal(callCount('parse_upload'), 1);
    assert.equal(callCount('chunk_'), 0);
    assert.deepEqual(progress, [1]);
    // 直传体是 FormData 且含文件本体
    assert.ok(calls[0].body instanceof FormData);
  });

  it('大包走 init → append×N → complete，切片与并发正确，返回 complete 响应', async () => {
    const uploadId = 'chunked-uuid-1';
    const size = CHUNK_SIZE * 2 + 1; // 3 片：512K + 512K + 1
    const chunkSizes = [];
    installRouter([
      ['/chunk_init', (_u, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.totalChunks, 3);
        assert.equal(body.totalSize, size);
        assert.equal(body.fileName, 'demo-plugin-1.0.0.tgz');
        return jsonResponse({ uploadId });
      }],
      ['/chunk_append', async (url, init) => {
        assert.match(url, new RegExp(`uploadId=${uploadId}&index=\\d+$`));
        const file = init.body.get('file');
        chunkSizes.push((await file.arrayBuffer()).byteLength);
        return jsonResponse({ received: chunkSizes.length, totalChunks: 3 });
      }],
      ['/chunk_complete', (_u, init) => {
        assert.equal(JSON.parse(init.body).uploadId, uploadId);
        return jsonResponse({ uploadId, summary: { name: 'assembled' } });
      }],
    ]);

    const progress = [];
    const result = await uploadTgzChunked(makeFile(size), { onProgress: (p) => progress.push(p) });

    assert.equal(result.summary.name, 'assembled');
    assert.equal(callCount('chunk_init'), 1);
    assert.equal(callCount('chunk_append'), 3);
    assert.equal(callCount('chunk_complete'), 1);
    // 切片边界：前两片满 512KB，末片余 1 字节（乱序完成，按序断言）
    assert.deepEqual([...chunkSizes].sort((a, b) => b - a), [CHUNK_SIZE, CHUNK_SIZE, 1]);
    // 进度单调推进到 1
    assert.equal(progress.at(-1), 1);
    assert.deepEqual([...progress].sort((a, b) => a - b), progress);
  });

  it('分片失败抛带 HTTP 状态码的错误，并 best-effort abort 服务端会话', async () => {
    const uploadId = 'fail-uuid';
    installRouter([
      ['/chunk_init', () => jsonResponse({ uploadId })],
      ['/chunk_append', (url) => (url.includes('index=1') ? jsonResponse({ error: 'boom' }, 500) : jsonResponse({ received: 1, totalChunks: 3 }))],
      ['/chunk_complete', () => jsonResponse({ uploadId, summary: {} })],
      ['/chunk_abort', (_u, init) => {
        assert.equal(JSON.parse(init.body).uploadId, uploadId);
        return jsonResponse({ success: true });
      }],
    ]);

    await assert.rejects(
      uploadTgzChunked(makeFile(CHUNK_SIZE * 3)),
      /chunk 1 failed HTTP 500/,
    );
    assert.equal(callCount('chunk_abort'), 1);
    assert.equal(callCount('chunk_complete'), 0);
  });

  it('init 失败直接抛错，不产生 append / complete / abort 请求', async () => {
    installRouter([
      ['/chunk_init', () => jsonResponse({ error: 'too large' }, 400)],
    ]);
    await assert.rejects(uploadTgzChunked(makeFile(CHUNK_SIZE * 2)), /chunk init failed HTTP 400/);
    assert.equal(callCount('chunk_append'), 0);
    assert.equal(callCount('chunk_abort'), 0);
  });
});
