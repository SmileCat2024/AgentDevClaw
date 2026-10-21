import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function setup() {
  const tasks = new Map();
  let timer = 0;
  const panel = { innerHTML: '' };
  const root = { dataset: { searchAgentId: 'programming-helper', searchDirectory: 'D:/project' }, classList: { add() {}, remove() {} } };
  const requests = [];
  const ctx = createFrontendSandbox({
    phSearchQuery: '', _phSearchTimer: null, savedPhTabState: {},
    URLSearchParams, marked,
    setTimeout(fn) { const id = ++timer; tasks.set(id, fn); return id; },
    clearTimeout(id) { tasks.delete(id); },
    getCurrentAgentRecord: () => ({ id: 'programming-helper' }),
    getSessionShortTime: () => '', getSessionRecencyClass: () => '',
    formatWorkspaceDate: (s) => s, t: (s) => s,
    renderSessionResumeBadge: () => '', renderSessionTodoBadge: () => '',
    renderSessionArchivedBadge: (s) => s.archived ? '已归档' : '',
    renderSessionTitleAiButton: () => '', renderSessionTokenBar: () => '',
    fetch(url) { return new Promise((resolve) => requests.push({ url, resolve })); },
  });
  ctx.document.querySelector = (s) => s === '.ph-session-tabs' ? root : s === '.ph-search-panel' ? panel : null;
  ctx.loadSource('public/src/modules/session-list-render.js');
  ctx.loadSource('public/src/modules/ph-session-list.js');
  const input = (q) => { ctx.window.phOnSearchInput(q); for (const [id, fn] of tasks) { tasks.delete(id); fn(); } };
  const resolve = async (n, data, ok = true) => { requests[n].resolve({ ok, status: ok ? 200 : 500, json: async () => data }); await new Promise(setImmediate); };
  return { ctx, panel, root, requests, input, resolve };
}
const row = { sessionId: 'session-one', title: 'Needle title', updatedAt: '2026-10-01', messageCount: 5, matchCount: 1, matches: [{ index: 2, role: 'assistant', snippet: 'Needle answer', excerpt: 'Needle answer with more context', context: { role: 'user', snippet: 'Original question', relation: 'prev' } }] };

describe('history search UI', () => {
  it('uses the normal row, chronological context, safe title highlights and expansion for one hit', async () => {
    const s = setup();
    s.input('Needle');
    assert.match(s.requests[0].url, /scope=all/);
    await s.resolve(0, { results: [row], total: 1 });
    assert.match(s.panel.innerHTML, /data-ctx-role="session"/);
    assert.match(s.panel.innerHTML, /<mark class="search-highlight">Needle<\/mark> title/);
    assert.ok(s.panel.innerHTML.indexOf('Original question') < s.panel.innerHTML.indexOf('Needle</mark> answer'));
    assert.match(s.panel.innerHTML, /展开上下文/);
    s.ctx.window.phSearchToggleExpand(row.sessionId);
    assert.match(s.panel.innerHTML, /with more context/);
    assert.match(s.panel.innerHTML, /收起/);
  });
  it('expands adjacent hits once each without losing the richer matched excerpt', async () => {
    const s = setup(); s.input('Needle');
    await s.resolve(0, { results: [{ ...row, matchCount: 2, matches: [
      { index: 1, role: 'user', snippet: 'Needle question', context: { index: 2, role: 'assistant', snippet: 'Needle short answer', relation: 'next' } },
      { index: 2, role: 'assistant', snippet: 'Needle short answer', excerpt: 'Needle richer answer', excerptLeadingEllipsis: true, excerptTrailingEllipsis: true },
    ] }], total: 1 });
    s.ctx.window.phSearchToggleExpand(row.sessionId);
    assert.equal((s.panel.innerHTML.match(/richer answer/g) || []).length, 1);
    assert.doesNotMatch(s.panel.innerHTML, /short answer/);
    assert.match(s.panel.innerHTML, /…<mark class="search-highlight">Needle<\/mark> richer answer…/);
  });
  it('namespaces remote result identities and preserves the explicit host for opening', async () => {
    const s = setup();
    s.ctx.loadSource('public/src/modules/remote-connections.js');
    Object.assign(s.root.dataset, { searchAgentId: 'remote:host:programming-helper', searchRemote: 'true' });
    s.input('Needle');
    await s.resolve(0, { results: [row], total: 1 });
    assert.equal(s.ctx.window.ClawFW.phSearch.results[0].sessionId, 'remote:host:session-one');
    assert.match(s.panel.innerHTML, /agentId&quot;:&quot;remote:host:programming-helper/);
    assert.doesNotMatch(s.panel.innerHTML, /draggable="true"/);
  });
  it('does not accept stale results when a query repeats after an intervening input', async () => {
    const s = setup();
    s.input('a'); s.input('b'); s.input('a');
    await s.resolve(0, { results: [row], total: 99 });
    assert.doesNotMatch(s.panel.innerHTML, /99/);
    await s.resolve(2, { results: [], total: 0 });
    assert.match(s.panel.innerHTML, /未找到/);
  });
  it('rejects old project responses without a new request having started', async () => {
    const s = setup(); s.input('Needle');
    s.root.dataset.searchDirectory = 'D:/other';
    await s.resolve(0, { results: [row], total: 1 });
    assert.equal(s.ctx.window.ClawFW.phSearch.results.length, 0);
  });
  it('shows errors with retry rather than reporting no matches', async () => {
    const s = setup(); s.input('Needle');
    await s.resolve(0, {}, false);
    assert.match(s.panel.innerHTML, /搜索失败/);
    assert.match(s.panel.innerHTML, /重试/);
    assert.doesNotMatch(s.panel.innerHTML, /未找到/);
  });
  it('paginates and sends selected scope and sorting to the server', async () => {
    const s = setup(); s.input('Needle');
    await s.resolve(0, { results: [row], total: 2 });
    s.ctx.window.phSearchLoadMore();
    assert.match(s.requests[1].url, /offset=1/);
    await s.resolve(1, { results: [{ ...row, sessionId: 'two' }], total: 2 });
    assert.equal(s.ctx.window.ClawFW.phSearch.results.length, 2);
    s.ctx.window.phSetSearchScopeByValue('archived');
    assert.match(s.requests[2].url, /scope=archived/);
    s.ctx.window.phToggleSearchSort();
    assert.match(s.requests[3].url, /sort=recency/);
  });
  it('observes normal-list pagination separately from search pagination', () => {
    const s = setup();
    let selector = '';
    let observed = 0;
    s.ctx.document.querySelectorAll = (value) => { selector = value; return [{}]; };
    s.ctx.IntersectionObserver = class { observe() { observed++; } disconnect() {} };
    s.ctx.loadSource('public/src/modules/ph-project-actions.js');
    s.ctx.window.phSetupLoadMoreAutoScroll();
    assert.equal(selector, '.ph-session-tab-panel .ph-load-more-wrap');
    assert.equal(observed, 1);
  });
  it('keeps readable markdown text without introducing HTML or nested containers', () => {
    const s = setup();
    assert.equal(s.ctx.run('_phReadableExcerpt("**重点**与 `code`\\n\\n- 第一项\\n- 第二项")'), '重点与 code\n\n\n第一项\n第二项');
    assert.equal(s.ctx.run('_phReadableExcerpt("<img src=x onerror=alert(1)>")'), '<img src=x onerror=alert(1)>');
  });
  it('highlights literal metacharacters without breaking escaped HTML entities', () => {
    const s = setup();
    assert.equal(s.ctx.run('_phHighlightText("<img>&.*", ".*")'), '&lt;img&gt;&amp;<mark class="search-highlight">.*</mark>');
    assert.equal(s.ctx.run('_phHighlightText("<", "lt")'), '&lt;');
  });
});
