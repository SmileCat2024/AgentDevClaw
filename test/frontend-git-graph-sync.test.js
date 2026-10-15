/**
 * git 面板图形区渲染 churn 回归测试（frontend-vm 沙箱）。
 *
 * 历史缺陷：大提交历史上面板拖垮页面。根因是每个 render 周期（静默刷新 /
 * 轮询 repaint，数据未变也触发）都会全量重建泳道 SVG 并无条件替换
 * .git-history-canvas 的 innerHTML——数千个 SVG DOM 节点随 render 频率反复
 * 销毁重建；computeLanes 也每周期重算。
 *
 * 修复后契约（本测试锁定）：
 *  1. 数据与行几何未变时，重复 render 不得产生 canvas DOM 写入（no-op 守卫）
 *  2. 泳道模型按 commits 数组身份 + 分支配色键 memo，未变数据不重算
 *  3. 行几何变化（offsetTop 漂移）恰好触发一次度量重绘替换
 *  4. 数据变化（新 commits 数组）恰好触发一次泳道重算 + 一次替换
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function makeCommits(n) {
  const commits = [];
  for (let i = 0; i < n; i++) {
    const hash = 'h' + String(i).padStart(6, '0');
    commits.push({
      hash,
      parents: i + 1 < n ? ['h' + String(i + 1).padStart(6, '0')] : [],
      author: 'dev' + (i % 7),
      relTime: '2 hours ago',
      subject: 'commit ' + i,
      refs: i === 0 ? [{ type: 'head', name: 'main' }] : [],
    });
  }
  return commits;
}

function makeHarness() {
  const ROWS = 300;
  const rows = [];
  for (let i = 0; i < ROWS; i++) rows.push({ offsetTop: 26 * i });
  const counts = { canvasWrites: 0 };
  let lastSvg = '';
  const canvas = {
    set innerHTML(v) { counts.canvasWrites++; lastSvg = v; },
    get innerHTML() { return lastSvg; },
  };
  const history = { querySelector: (sel) => (sel === '.git-history-canvas' ? canvas : null) };
  const doc = {
    querySelector(sel) { return sel === '.git-history' ? history : null; },
    querySelectorAll(sel) { return sel === '.git-history-row' ? rows : []; },
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {}, addEventListener() {}, innerHTML: '' }),
    addEventListener() {},
    removeEventListener() {},
    body: { addEventListener() {}, removeEventListener() {} },
  };

  let graphCommits = makeCommits(ROWS);
  const fetchImpl = async (url) => {
    const op = url.split('/').pop();
    if (op === 'status') {
      return { ok: true, json: async () => ({ ok: true, isRepo: true, root: '/repo', head: graphCommits[0].hash, status: { current: 'main', files: [], ahead: 0, behind: 0, tracking: 'origin/main' } }) };
    }
    if (op === 'graph') {
      return { ok: true, json: async () => ({ ok: true, commits: graphCommits, aheadHashes: [] }) };
    }
    if (op === 'branches') {
      return { ok: true, json: async () => ({ ok: true, locals: [{ name: 'main', current: true, relTime: '2 hours ago' }], remotes: [], current: 'main' }) };
    }
    throw new Error('unknown op ' + op);
  };

  const timers = new Set();
  const trackedSetInterval = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
  const trackedClear = (t) => { clearTimeout(t); clearInterval(t); timers.delete(t); };
  const record = { workspace_sessions: { sessions: [{ id: 'sess-1', openDirectory: '/repo' }] } };

  const ctx = createFrontendSandbox({
    fetch: fetchImpl,
    AbortController,
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
    clearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClear,
    featurePanelBody: { addEventListener() {}, querySelector: () => null },
    document: doc,
    activeFeaturePanel: 'git',
    currentRuntimeAgentId: 'agent-1',
    getRuntimeWorkspaceSessionId: () => 'sess-1',
    getActiveWorkspaceSessionId: () => 'sess-1',
    getCurrentAgentRecord: () => record,
    renderFeaturePanel: () => { ctx.__lastHtml = ctx.window.GitPanel.render(); },
  });
  ctx.loadSource('public/src/modules/git-graph.js');
  ctx.loadSource('public/src/modules/git-panel.js');
  ctx.run(`
    const origBuild = window.GitGraph.buildGraphSvg;
    window.__counters = { builds: 0, lanes: 0 };
    window.GitGraph.buildGraphSvg = function () { window.__counters.builds++; return origBuild.apply(this, arguments); };
    const origLanes = window.GitGraph.computeLanes;
    window.GitGraph.computeLanes = function () { window.__counters.lanes++; return origLanes.apply(this, arguments); };
  `);
  ctx.__dispose = () => { for (const t of timers) trackedClear(t); timers.clear(); };
  ctx.__counts = counts;
  ctx.__rows = rows;
  ctx.__setGraphCommits = (c) => { graphCommits = c; };
  return ctx;
}

const counters = (ctx) => ctx.run('({ builds: window.__counters.builds, lanes: window.__counters.lanes })');
const tick = () => new Promise((r) => setTimeout(r, 40));

describe('git 面板图形区渲染 churn 守卫', () => {
  it('数据与行几何未变时，重复 render 零 canvas 写入、零泳道重算', async () => {
    const ctx = makeHarness();
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      assert.equal(ctx.__counts.canvasWrites, 1, '首次加载恰好一次画布替换');
      let c = counters(ctx);
      assert.equal(c.lanes, 1, '首次加载恰好一次泳道计算');

      for (let i = 0; i < 5; i++) ctx.window.GitPanel.render();
      assert.equal(ctx.__counts.canvasWrites, 1, '未变数据重复 render 不得替换画布 DOM');
      c = counters(ctx);
      assert.equal(c.lanes, 1, '未变数据重复 render 不得重算泳道（memo）');
      assert.equal(c.builds, 7, '估算构建 = 加载 2 次（估算+度量）+ 每 render 1 次签名求值，不得退回度量重建');
    } finally {
      ctx.__dispose();
    }
  });

  it('行几何漂移恰好触发一次度量重绘，随后恢复零 churn', async () => {
    const ctx = makeHarness();
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      assert.equal(ctx.__counts.canvasWrites, 1);

      // 模拟布局后行位置漂移（如展开详情撑高后续行）
      for (let i = 10; i < ctx.__rows.length; i++) ctx.__rows[i].offsetTop += 37;
      ctx.window.GitPanel.render();
      assert.equal(ctx.__counts.canvasWrites, 2, '几何变化恰好一次替换');

      ctx.window.GitPanel.render();
      ctx.window.GitPanel.render();
      assert.equal(ctx.__counts.canvasWrites, 2, '替换后未变 render 不再写画布');
    } finally {
      ctx.__dispose();
    }
  });

  it('数据变化（新 commits 数组）恰好触发一次泳道重算与画布替换', async () => {
    const ctx = makeHarness();
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      assert.equal(ctx.__counts.canvasWrites, 1);

      ctx.__setGraphCommits(makeCommits(301)); // 新提交到达：数组身份变化
      ctx.window.GitPanel.refresh();
      await tick(); await tick();
      let c = counters(ctx);
      assert.equal(c.lanes, 2, '新数据恰好一次泳道重算');
      assert.equal(ctx.__counts.canvasWrites, 2, '新数据恰好一次画布替换');

      ctx.window.GitPanel.render();
      assert.equal(ctx.__counts.canvasWrites, 2, '数据稳定后 render 不再写画布');
    } finally {
      ctx.__dispose();
    }
  });
});
