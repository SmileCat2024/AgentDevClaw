import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const bootstrapMatch = indexHtml.match(/<script id="app-base-bootstrap">([\s\S]*?)<\/script>/);

assert.ok(bootstrapMatch, 'base path bootstrap script must exist');

function runBootstrap(pathname) {
  const fetchInputs = [];
  const appended = [];
  const location = {
    protocol: 'https:',
    origin: 'https://example.test',
    href: `https://example.test${pathname}`,
    pathname,
  };
  const window = {
    location,
    fetch: async (input) => {
      fetchInputs.push(input);
      return { ok: true };
    },
  };
  const document = {
    createElement: (tagName) => ({ tagName }),
    head: { appendChild: (node) => appended.push(node) },
  };

  vm.runInNewContext(bootstrapMatch[1], {
    URL,
    Request,
    document,
    window,
  });

  return { appended, fetchInputs, window };
}

describe('gateway base path bootstrap', () => {
  it('keeps direct root deployments unchanged', async () => {
    const { appended, fetchInputs, window } = runBootstrap('/');

    assert.equal(window.__PROTOCLAW_BASE_PATH__, '');
    assert.equal(appended[0].href, 'https://example.test/');
    await window.fetch('/protoclaw/health');
    assert.equal(fetchInputs[0], '/protoclaw/health');
  });

  for (const pathname of ['/agentdev', '/agentdev/', '/agentdev/index.html']) {
    it(`detects the /agentdev mount from ${pathname}`, async () => {
      const { appended, fetchInputs, window } = runBootstrap(pathname);

      assert.equal(window.__PROTOCLAW_BASE_PATH__, '/agentdev');
      assert.equal(appended[0].href, 'https://example.test/agentdev/');
      assert.equal(window.__PROTOCLAW_APP_URL__('/template/agentdev/tool.render.js'), '/agentdev/template/agentdev/tool.render.js');
      assert.equal(window.__PROTOCLAW_APP_URL__('/agentdev/api/agents'), '/agentdev/api/agents');

      await window.fetch('/protoclaw/get_connected_agents');
      await window.fetch('/api/agents');
      await window.fetch('https://cdn.example.test/library.js');
      await window.fetch(new Request('https://example.test/api/templates/feature'));

      assert.deepEqual(fetchInputs.slice(0, 3), [
        '/agentdev/protoclaw/get_connected_agents',
        '/agentdev/api/agents',
        'https://cdn.example.test/library.js',
      ]);
      assert.equal(fetchInputs[3].url, 'https://example.test/agentdev/api/templates/feature');
    });
  }

  it('loads boot-critical vendor scripts without breaking under an injected base', () => {
    assert.match(indexHtml, /src="\.\/vendor\/marked\/lib\/marked\.umd\.js"/);
    // highlight.js 自 210a667 起改为 CDN 绝对地址加载（原 vendor 路径 404），绝对 URL 不受注入的 <base> 影响
    assert.match(indexHtml, /src="https:\/\/[^"]+\/highlight\.min\.js"/);
  });
});
