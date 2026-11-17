/**
 * 历史搜索 UI 行为。
 *
 * 装载路线（P2 W2-8 测试改造）：ph-session-list 已迁 ESM → withP2EsmCase
 * 真实 import（每 case 一张图，搜索状态不跨用例）；classic 侧仍真实
 * loadSource 跑 action-dispatcher / app-core（p2-bootstrap 工厂）/ i18n（t）
 * 与按需的 remote-connections（远程命名空间能力）。断言改为调用命名导出与
 * 真实请求形状、可观察 DOM（搜索面板 innerHTML）。
 *
 * 原用例直调模块私有 `_phReadableExcerpt` / `_phHighlightText`；它们不为测试
 * 扩导出，现统一经公开的搜索状态机 + 面板渲染（`_buildPhSearchPanelHtml`
 * 的真实消费路径）断言同样的事实：Markdown 只留可读文本、frontmatter 元数据
 * 不进摘要、字面元字符高亮不切断已转义实体。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const PH_SESSION_LIST = 'public/src/modules/ph-session-list.js';
const PH_PROJECT_ACTIONS = 'public/src/modules/ph-project-actions.js';

/** 最小元素桩（app-core 装载期按 id 取到的引用必须稳定）。 */
function makeElement(id = '') {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    insertBefore() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };
}

function createDocumentStub({ root, panel, state }) {
  const byId = new Map();
  return {
    querySelector(selector) {
      if (selector === '.ph-session-tabs') return root;
      if (selector === '.ph-search-panel') return panel;
      return null;
    },
    querySelectorAll(selector) {
      // 「普通列表分页观察」用例断言被观察的选择器与观察次数。
      state.lastQueryAll = selector;
      return selector === '.ph-session-tab-panel .ph-load-more-wrap' ? [{}] : [];
    },
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeElement(id));
      return byId.get(id);
    },
    createElement() { return makeElement(); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    removeEventListener() {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    readyState: 'complete',
    activeElement: null,
  };
}

async function setup({ remoteConnections = false } = {}, probe) {
  const tasks = new Map();
  const state = { lastQueryAll: '', observed: 0 };
  let timer = 0;
  const panel = { innerHTML: '' };
  const root = { dataset: { searchAgentId: 'programming-helper', searchDirectory: 'D:/project' }, classList: { add() {}, remove() {} } };
  const requests = [];
  const document = createDocumentStub({ root, panel, state });
  // 搜索防抖：句柄与回调按原夹具语义排队，由 input() 同步推进（不真实等待）。
  const setTimeoutStub = (fn) => { const id = ++timer; tasks.set(id, fn); return id; };
  const clearTimeoutStub = (id) => { tasks.delete(id); };
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.loadSource('public/src/modules/action-dispatcher.js');
      // app-core 提供 p2-bootstrap 工厂与 i18n 桥初值；i18n 提供 classic t()。
      sandbox.loadSource('public/src/app-core.js');
      // ESM 图求值期读取的 loader host 工厂与 classic 宿主函数（最小契约替身）。
      sandbox.run(`
        renderCurrentMainView = function () {};
        getCurrentAgentRecord = function () { return { id: 'programming-helper' }; };
        createAgentSnapshotLoaderHost = () => ({ state: {} });
        createRuntimeSwitchHost = () => ({ state: {} });
        createWorkspaceSurfaceHost = () => ({ state: {} });
        createCompactResumeHost = () => ({ state: {}, now: () => Date.now() });
        createAgentCallStatesHost = () => ({ state: {} });
        createSessionViewCommitHost = () => ({ state: {} });
        createP2BootstrapSidebarRenderHost = () => ({ lastAgentListRenderSignature: '' });
        // 轮询协调器宿主（classic app-main 工厂）：ESM 图经 agent-data-loader →
        // input-actions 触达 poll-coordinator-host，后者在模块求值期取该工厂。
        createPollCoordinatorHost = () => ({
          run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
        });
      `);
    },
    globals: {
      document,
      marked,
      URLSearchParams,
      setTimeout: setTimeoutStub,
      clearTimeout: clearTimeoutStub,
      IntersectionObserver: class {
        observe() { state.observed += 1; }
        disconnect() {}
      },
      fetch(url) { return new Promise((resolve) => requests.push({ url: String(url), resolve })); },
    },
  }, async (c) => {
    // ph-search-locate 的远程身份解析经 window.RemoteConnections（已迁 ESM，P4 T3）；
    // 只有远程身份用例才装它，其余用例保持「远程域缺席」的最小面。
    if (remoteConnections) await c.load('public/src/modules/remote-connections.js');
    const list = await c.load(PH_SESSION_LIST);
    const input = (q) => {
      list.phOnSearchInput(q);
      for (const [id, fn] of tasks) { tasks.delete(id); fn(); }
    };
    const resolve = async (n, data, ok = true) => {
      requests[n].resolve({ ok, status: ok ? 200 : 500, json: async () => data });
      await new Promise(setImmediate);
    };
    return probe({ c, list, panel, root, requests, input, resolve, state });
  });
}

const row = { sessionId: 'session-one', title: 'Needle title', updatedAt: '2026-10-01', messageCount: 5, matchCount: 1, matches: [{ index: 2, role: 'assistant', snippet: 'Needle answer', excerpt: 'Needle answer with more context', context: { role: 'user', snippet: 'Original question', relation: 'prev' } }] };

describe('history search UI', () => {
  it('uses the normal row, chronological context, safe title highlights and expansion for one hit', async () => {
    await setup({}, async ({ list, panel, requests, input, resolve }) => {
      input('Needle');
      assert.match(requests[0].url, /scope=all/);
      await resolve(0, { results: [row], total: 1 });
      assert.match(panel.innerHTML, /data-ctx-role="session"/);
      assert.match(panel.innerHTML, /<mark class="search-highlight">Needle<\/mark> title/);
      assert.ok(panel.innerHTML.indexOf('Original question') < panel.innerHTML.indexOf('Needle</mark> answer'));
      assert.match(panel.innerHTML, /展开上下文/);
      list.phSearchToggleExpand(row.sessionId);
      assert.match(panel.innerHTML, /with more context/);
      assert.match(panel.innerHTML, /收起/);
    });
  });

  it('expands adjacent hits once each without losing the richer matched excerpt', async () => {
    await setup({}, async ({ list, panel, input, resolve }) => {
      input('Needle');
      await resolve(0, { results: [{ ...row, matchCount: 2, matches: [
        { index: 1, role: 'user', snippet: 'Needle question', context: { index: 2, role: 'assistant', snippet: 'Needle short answer', relation: 'next' } },
        { index: 2, role: 'assistant', snippet: 'Needle short answer', excerpt: 'Needle richer answer', excerptLeadingEllipsis: true, excerptTrailingEllipsis: true },
      ] }], total: 1 });
      list.phSearchToggleExpand(row.sessionId);
      assert.equal((panel.innerHTML.match(/richer answer/g) || []).length, 1);
      assert.doesNotMatch(panel.innerHTML, /short answer/);
      assert.match(panel.innerHTML, /…<mark class="search-highlight">Needle<\/mark> richer answer…/);
    });
  });

  it('namespaces remote result identities and preserves the explicit host for opening', async () => {
    await setup({ remoteConnections: true }, async ({ list, panel, root, input, resolve }) => {
      Object.assign(root.dataset, { searchAgentId: 'remote:host:programming-helper', searchRemote: 'true' });
      input('Needle');
      await resolve(0, { results: [row], total: 1 });
      assert.equal(list._phSearch.results[0].sessionId, 'remote:host:session-one');
      assert.match(panel.innerHTML, /agentId&quot;:&quot;remote:host:programming-helper/);
      assert.doesNotMatch(panel.innerHTML, /draggable="true"/);
    });
  });

  it('does not accept stale results when a query repeats after an intervening input', async () => {
    await setup({}, async ({ list, panel, input, resolve }) => {
      input('a'); input('b'); input('a');
      await resolve(0, { results: [row], total: 99 });
      assert.doesNotMatch(panel.innerHTML, /99/);
      await resolve(2, { results: [], total: 0 });
      assert.match(panel.innerHTML, /未找到/);
      assert.equal(list._phSearch.results.length, 0);
    });
  });

  it('rejects old project responses without a new request having started', async () => {
    await setup({}, async ({ list, root, input, resolve }) => {
      input('Needle');
      root.dataset.searchDirectory = 'D:/other';
      await resolve(0, { results: [row], total: 1 });
      assert.equal(list._phSearch.results.length, 0);
    });
  });

  it('shows errors with retry rather than reporting no matches', async () => {
    await setup({}, async ({ panel, input, resolve }) => {
      input('Needle');
      await resolve(0, {}, false);
      assert.match(panel.innerHTML, /搜索失败/);
      assert.match(panel.innerHTML, /重试/);
      assert.doesNotMatch(panel.innerHTML, /未找到/);
    });
  });

  it('paginates and sends selected scope and sorting to the server', async () => {
    await setup({}, async ({ list, requests, input, resolve }) => {
      input('Needle');
      await resolve(0, { results: [row], total: 2 });
      list.phSearchLoadMore();
      assert.match(requests[1].url, /offset=1/);
      await resolve(1, { results: [{ ...row, sessionId: 'two' }], total: 2 });
      assert.equal(list._phSearch.results.length, 2);
      list.phSetSearchScopeByValue('archived');
      assert.match(requests[2].url, /scope=archived/);
      list.phToggleSearchSort();
      assert.match(requests[3].url, /sort=recency/);
    });
  });

  it('observes normal-list pagination separately from search pagination', async () => {
    await setup({}, async ({ c, state }) => {
      const actions = await c.load(PH_PROJECT_ACTIONS);
      actions.phSetupLoadMoreAutoScroll();
      assert.equal(state.lastQueryAll, '.ph-session-tab-panel .ph-load-more-wrap');
      assert.equal(state.observed, 1);
    });
  });

  it('keeps readable markdown text without introducing HTML or nested containers', async () => {
    await setup({}, async ({ panel, input, resolve }) => {
      input('重点');
      await resolve(0, { results: [{ ...row, title: 'md', matchCount: 1, matches: [
        { index: 1, role: 'assistant', snippet: '**重点**与 `code`\n\n- 第一项\n- 第二项' },
      ] }], total: 1 });
      const html = panel.innerHTML;
      // 摘要呈现可读文本：强调/代码/列表标记被摊平，正文完整保留。
      assert.match(html, /<mark class="search-highlight">重点<\/mark>与 code/);
      assert.match(html, /第一项/);
      assert.match(html, /第二项/);
      assert.doesNotMatch(html, /\*\*重点\*\*|`code`|- 第一项/);
      // Markdown 渲染不进入摘要：不产生段落/列表/代码等嵌套结构。
      assert.doesNotMatch(html, /<pre|<code|<p>|<ul>|<li>/);
      // 消息里的 HTML 只作为文本：同一搜索状态机换查询后，转义呈现，不生成元素。
      input('img');
      await resolve(1, { results: [{ ...row, title: 'html', matchCount: 1, matches: [
        { index: 1, role: 'assistant', snippet: '<img src=x onerror=alert(1)>' },
      ] }], total: 1 });
      const htmlAsText = panel.innerHTML;
      // 字面尖括号整体转义；查询命中只在文本内部打点，不生成元素。
      assert.match(htmlAsText, /&lt;<mark class="search-highlight">img<\/mark> src=x onerror=alert\(1\)&gt;/);
      assert.doesNotMatch(htmlAsText, /<img\s/);
    });
  });

  it('drops YAML frontmatter metadata from the excerpt, keeping the body', async () => {
    await setup({}, async ({ panel, input, resolve }) => {
      // 消息里整段贴 SKILL.md 时，摘要只应出现正文，不应出现 name/description 元数据
      const src = '---\nname: demo-skill\ndescription: 一句话说明\n---\n\n# 正文标题\n\n正文段落。';
      input('正文');
      await resolve(0, { results: [{ ...row, title: 'skill', matchCount: 1, matches: [
        { index: 1, role: 'assistant', snippet: src },
      ] }], total: 1 });
      const html = panel.innerHTML;
      assert.match(html, /<mark class="search-highlight">正文<\/mark>标题/);
      assert.match(html, /<mark class="search-highlight">正文<\/mark>段落。/);
      assert.doesNotMatch(html, /demo-skill|description:/);
    });
  });

  it('highlights literal metacharacters without breaking escaped HTML entities', async () => {
    await setup({}, async ({ panel, input, resolve }) => {
      input('.*');
      await resolve(0, { results: [{ ...row, title: '<img>&.*', matches: [] }], total: 1 });
      // 标题整体转义后，查询串按字面高亮：元字符不参与正则。
      assert.match(panel.innerHTML, /&lt;img&gt;&amp;<mark class="search-highlight">\.\*<\/mark>/);
      // 命中落在实体内部也不得切开：换查询 "lt" 后整个 `<` 保持 `&lt;`，不插入 mark。
      input('lt');
      await resolve(1, { results: [{ ...row, title: '<', matches: [] }], total: 1 });
      assert.match(panel.innerHTML, />&lt;<\/div>/);
      assert.doesNotMatch(panel.innerHTML, /&<mark|l<mark/);
    });
  });
});
