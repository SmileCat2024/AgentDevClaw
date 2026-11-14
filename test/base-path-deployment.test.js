import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const bootstrapMatch = indexHtml.match(/<script id="app-base-bootstrap">([\s\S]*?)<\/script>/);

assert.ok(bootstrapMatch, 'base path bootstrap script must exist');

function runBootstrap(pathname, { eventSource } = {}) {
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
  if (eventSource) window.EventSource = eventSource;
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

// EventSource 构造器 patch 的观察面：记录原生构造收到的 URL
function makeEventSourceProbe() {
  return class {
    constructor(url, config) {
      this.url = url;
      this.config = config;
    }
  };
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
    // ./ 相对引用经注入的 <base> 解析，base path 部署下仍指向本服务的 /vendor 挂载
    assert.match(indexHtml, /src="\.\/vendor\/marked\/lib\/marked\.umd\.js"/);
    assert.match(indexHtml, /src="\.\/vendor\/hljs\/highlight\.min\.js"/);
  });

  it('patches EventSource: 根路径字符串在子路径部署下带前缀到达原生构造', () => {
    const Native = makeEventSourceProbe();
    const { window } = runBootstrap('/agentdev/', { eventSource: Native });

    const es = new window.EventSource('/protoclaw/events?threads=1', { withCredentials: true });

    assert.ok(es instanceof Native, '实例仍是原生 EventSource（prototype 继承）');
    assert.equal(es.url, '/agentdev/protoclaw/events?threads=1');
    assert.equal(es.config.withCredentials, true, '第二参数透传');
  });

  it('patches EventSource: 根部署恒等，非根路径字符串原样透传', () => {
    const Native = makeEventSourceProbe();
    const { window } = runBootstrap('/', { eventSource: Native });

    assert.equal(new window.EventSource('/protoclaw/events').url, '/protoclaw/events', '根部署不改写');
    assert.equal(new window.EventSource('./events').url, './events', '相对路径不改写');
    assert.equal(new window.EventSource('https://cdn.example.test/s').url, 'https://cdn.example.test/s', '完整 URL 不改写');
  });

  it('EventSource 缺席时不 patch，bootstrap 仍可运行', () => {
    const { window } = runBootstrap('/agentdev/');
    assert.equal(window.EventSource, undefined);
  });
});
