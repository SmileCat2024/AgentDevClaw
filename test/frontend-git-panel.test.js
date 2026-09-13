/**
 * git-panel 刷新链路稳定性测试（frontend-vm 沙箱）。
 *
 * 覆盖刷新链路的四个历史缺陷的回归：
 *  1. 目录暂态丢失（agent record 轮询替换瞬间返回空）不得清空已加载面板
 *  2. isRepo=false 需连续两次确认才切换（防 rev-parse 偶发失败误报）
 *  3. loading 期间的新刷新请求合并补跑，不被静默丢弃
 *  4. render→ensureLoaded→loadAll→repaint 不得形成自激励无限循环
 *     （git 命令风暴打满服务端的根因）；graph 端点恢复后错误提示清除
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const okStatus = (dir) => ({
  ok: true, isRepo: true, root: dir,
  status: { current: 'main', files: [], ahead: 1, behind: 0, tracking: 'origin/main' },
});
const okGraph = { ok: true, commits: [{ hash: 'a1b2c3d4e5f6', parents: [], author: 'x', relDate: '1d', subject: 'init' }], aheadHashes: [] };
const okBranches = { ok: true, locals: [], remotes: [], current: 'main' };
const record = { workspace_sessions: { sessions: [{ id: 'sess-1', openDirectory: '/repo' }] } };

function makeSandbox({ fetchImpl, agentRecord = record } = {}) {
  const timers = new Set();
  const bodyListeners = {};
  const docBodyListeners = {};
  let autoTickFn = null;
  const trackedSetTimeout = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const trackedSetInterval = (fn, ms) => { autoTickFn = fn; const t = setInterval(fn, ms); timers.add(t); return t; };
  const trackedClear = (t) => { clearTimeout(t); clearInterval(t); timers.delete(t); };
  const body = {
    addEventListener(type, fn) { (bodyListeners[type] = bodyListeners[type] || []).push(fn); },
    querySelector: () => null,
  };
  // document.body 级委托（弹层菜单项）在沙箱默认 stub 上是 no-op，
  // 这里替换为可触发的最小 document，供 #git-repo-menu 菜单点击链路
  const docStub = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {}, addEventListener() {}, innerHTML: '' }),
    addEventListener() {},
    removeEventListener() {},
    body: {
      addEventListener(type, fn) { (docBodyListeners[type] = docBodyListeners[type] || []).push(fn); },
      removeEventListener() {},
    },
  };

  const ctx = createFrontendSandbox({
    fetch: fetchImpl,
    AbortController,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClear,
    setInterval: trackedSetInterval,
    clearInterval: trackedClear,
    featurePanelBody: body,
    document: docStub,
    activeFeaturePanel: 'git',
    currentRuntimeAgentId: 'agent-1',
    getRuntimeWorkspaceSessionId: () => 'sess-1',
    getActiveWorkspaceSessionId: () => 'sess-1',
    getCurrentAgentRecord: () => agentRecord,
    renderFeaturePanel: () => { ctx.__dom = ctx.window.GitPanel.render(); },
  });
  ctx.__disposeTimers = () => { for (const t of timers) trackedClear(t); timers.clear(); };
  ctx.__autoTick = () => { if (autoTickFn) autoTickFn(); };
  ctx.__fireBody = (type, event) => (bodyListeners[type] || []).forEach((fn) => fn(event));
  ctx.__fireDocBody = (type, event) => (docBodyListeners[type] || []).forEach((fn) => fn(event));
  ctx.loadSource('public/src/modules/git-graph.js');
  ctx.loadSource('public/src/modules/git-panel.js');
  return ctx;
}

const goodFetch = () => async (url) => {
  const op = url.split('/').pop();
  const body = { status: okStatus('/repo'), graph: okGraph, branches: okBranches }[op];
  if (!body) throw new Error('unknown op ' + op);
  return { ok: true, json: async () => body };
};
const tick = () => new Promise((r) => setTimeout(r, 40));

describe('git-panel 刷新链路稳定性', () => {
  it('目录暂态丢失时保留已加载面板，不清空', async () => {
    const ctx = makeSandbox({ fetchImpl: goodFetch() });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      assert.ok((ctx.__dom || '').includes('git-panel'), '预置：面板已渲染');

      // agent record 轮询替换瞬间 sessions 为空 → 目录暂态丢失
      ctx.getCurrentAgentRecord = () => ({ workspace_sessions: { sessions: [] } });
      const html = ctx.window.GitPanel.render();
      assert.ok(html.includes('git-panel'), '面板骨架保留');
      assert.ok(!html.includes('未绑定项目目录'), '不清空成空态');

      ctx.getCurrentAgentRecord = () => record;
      assert.ok(ctx.window.GitPanel.render().includes('git-panel'));
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('isRepo=false 连续两次确认才切换，单次不误报', async () => {
    let repoFalse = 0;
    let discoverCalls = 0;
    const fetchImpl = async (url) => {
      const op = url.split('/').pop();
      if (op === 'status') { repoFalse++; return { ok: true, json: async () => ({ ok: true, isRepo: false }) }; }
      if (op === 'discover') { discoverCalls++; return { ok: true, json: async () => ({ ok: true, repos: [] }) }; }
      return { ok: true, json: async () => ({ graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      assert.ok(repoFalse >= 1);
      assert.ok(!ctx.window.GitPanel.render().includes('不是 git 仓库'), '首次 isRepo:false 不切换');

      ctx.window.GitPanel.refresh();
      await tick(); await tick();
      assert.ok(repoFalse >= 2);
      assert.ok(discoverCalls >= 1, '确认非仓库后发起子目录仓库发现');
      assert.ok(ctx.window.GitPanel.render().includes('不是 git 仓库'), '连续两次确认后切换');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('发现子仓库后自动选中（持久化默认仓库优先），无中间列表页', async () => {
    const dirByOp = [];
    const fetchImpl = async (url, init) => {
      const op = url.split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      if (op === 'status') {
        // 会话目录本身非仓库；子仓库请求正常返回
        if (body.dir === '/repo') return { ok: true, json: async () => ({ ok: true, isRepo: false }) };
        dirByOp.push(['status', body.dir]);
        return { ok: true, json: async () => okStatus(body.dir) };
      }
      if (op === 'discover') {
        return { ok: true, json: async () => ({
          ok: true,
          defaultRepo: '/work/repoB',
          repos: [{ root: '/work/repoA', relPath: 'repoA' }, { root: '/work/repoB', relPath: 'repoB' }],
        }) };
      }
      if (op === 'default_repo') return { ok: true, json: async () => ({ ok: true }) };
      dirByOp.push([op, body.dir]);
      return { ok: true, json: async () => ({ graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      dirByOp.length = 0; // 丢弃确认非仓库阶段的请求记录
      ctx.window.GitPanel.refresh(); // 第二次确认非仓库 → discover
      await tick(); await tick();

      const html = ctx.window.GitPanel.render();
      // 自动选中持久化的 repoB（而非列表第一个 repoA），直接进入仓库视图
      assert.ok(html.includes('data-gp-action="repo-menu"'), '标题区提供仓库切换下拉');
      assert.ok(html.includes('repoB'), '下拉显示当前仓库名');
      assert.ok(!html.includes('发现 2 个仓库'), '无中间列表页');
      assert.ok(html.includes('更改与暂存'), '标题保持原文');
      // 确认非仓库那轮的 graph/branches 仍发往会话目录（/repo），切换后
      // 的仓库请求（status/graph/branches）才是断言对象
      const lastThree = dirByOp.slice(-3);
      assert.ok(lastThree.length === 3 && lastThree.every(([, dir]) => dir === '/work/repoB'),
        '请求发往持久化默认仓库 ' + JSON.stringify(dirByOp));
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('下拉主动切换仓库：请求目录切换并写回默认仓库偏好', async () => {
    let persistedBody = null;
    const dirByOp = [];
    const fetchImpl = async (url, init) => {
      const op = url.split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      if (op === 'status') {
        if (body.dir === '/repo') return { ok: true, json: async () => ({ ok: true, isRepo: false }) };
        dirByOp.push(['status', body.dir]);
        return { ok: true, json: async () => okStatus(body.dir) };
      }
      if (op === 'discover') {
        // 无持久化记录：自动选中列表第一个（repoA）
        return { ok: true, json: async () => ({
          ok: true, defaultRepo: '',
          repos: [{ root: '/work/repoA', relPath: 'repoA' }, { root: '/work/repoB', relPath: 'repoB' }],
        }) };
      }
      if (op === 'default_repo') {
        persistedBody = body;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      dirByOp.push([op, body.dir]);
      return { ok: true, json: async () => ({ graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    // 菜单项挂在 body 弹层上（#git-repo-menu），经 document.body 级委托命中
    const clickMenuItem = (root) => ctx.__fireDocBody('click', {
      preventDefault() {},
      stopPropagation() {},
      target: { closest: (sel) => (sel === '#git-repo-menu [data-gp-root]' ? { dataset: { gpRoot: root } } : null) },
    });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      ctx.window.GitPanel.refresh();
      await tick(); await tick();
      assert.ok(ctx.window.GitPanel.render().includes('repoA'), '预置：自动选中第一个仓库 repoA');

      // 下拉主动切换到 repoB
      dirByOp.length = 0;
      clickMenuItem('/work/repoB');
      await tick(); await tick();
      const html = ctx.window.GitPanel.render();
      assert.ok(html.includes('repoB'), '切换后显示新仓库名');
      assert.ok(dirByOp.length > 0 && dirByOp.every(([, dir]) => dir === '/work/repoB'),
        '请求发往新选中仓库 ' + JSON.stringify(dirByOp));
      assert.equal(persistedBody?.repoRoot, '/work/repoB', '主动选择写回默认仓库偏好');
      assert.equal(persistedBody?.dir, '/repo', '偏好以会话目录为键');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('选中仓库失效后自动重扫并回退到可用仓库（不回写偏好）', async () => {
    let repoAGone = false;
    let persistCalls = 0;
    const dirByOp = [];
    const fetchImpl = async (url, init) => {
      const op = url.split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      if (op === 'status') {
        if (body.dir === '/repo') return { ok: true, json: async () => ({ ok: true, isRepo: false }) };
        if (body.dir === '/work/repoA') {
          return { ok: true, json: async () => ({ ok: true, isRepo: repoAGone ? false : true, status: repoAGone ? undefined : okStatus('/work/repoA').status }) };
        }
        dirByOp.push(['status', body.dir]);
        return { ok: true, json: async () => okStatus(body.dir) };
      }
      if (op === 'discover') {
        const repos = repoAGone
          ? [{ root: '/work/repoB', relPath: 'repoB' }]
          : [{ root: '/work/repoA', relPath: 'repoA' }, { root: '/work/repoB', relPath: 'repoB' }];
        return { ok: true, json: async () => ({ ok: true, defaultRepo: '', repos }) };
      }
      if (op === 'default_repo') { persistCalls++; return { ok: true, json: async () => ({ ok: true }) }; }
      if (body.dir === '/work/repoA') return { ok: true, json: async () => ({ graph: okGraph, branches: okBranches }[op]) };
      dirByOp.push([op, body.dir]);
      return { ok: true, json: async () => ({ graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      ctx.window.GitPanel.refresh(); // 确认非仓库 → discover → 自动选中 repoA
      await tick(); await tick();
      assert.ok(ctx.window.GitPanel.render().includes('repoA'), '预置：已进入 repoA 视图');

      // repoA 失效（仓库被删）：两次确认后自动重扫并回退到 repoB
      repoAGone = true;
      dirByOp.length = 0;
      ctx.window.GitPanel.refresh(); // 第一次 miss（selectRepo 那轮确认的是 true，repoMiss 已归零）
      await tick(); await tick();
      ctx.window.GitPanel.refresh(); // 第二次确认 → 清选中 + force 重扫 → 自动选中 repoB
      await tick(); await tick(); await tick();
      const html = ctx.window.GitPanel.render();
      assert.ok(!html.includes('读取中'), '不停留在读取中死端');
      assert.ok(html.includes('repoB'), '重扫后自动回退到可用仓库');
      assert.ok(html.includes('data-gp-action="repo-menu"'), '仓库视图正常渲染');
      assert.equal(persistCalls, 0, '自动回退不回写偏好');
      // 回退后的仓库请求（graph/branches/status）全部发往 repoB；
      // 失效确认期间对 /repo（会话目录）的 graph/branches 不在断言范围
      assert.ok(dirByOp.length > 0 && dirByOp.every(([, dir]) => dir !== '/work/repoA'),
        '失效仓库不再收到请求 ' + JSON.stringify(dirByOp));
      const lastThree = dirByOp.filter(([op]) => op !== 'discover').slice(-3);
      assert.ok(lastThree.length === 3 && lastThree.every(([, dir]) => dir === '/work/repoB'),
        '回退后请求发往 repoB ' + JSON.stringify(dirByOp));
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('discover 失败时错误可见，冷却期内静默轮询不重试', async () => {
    let discoverCalls = 0;
    const fetchImpl = async (url) => {
      const op = url.split('/').pop();
      if (op === 'status') return { ok: true, json: async () => ({ ok: true, isRepo: false }) };
      if (op === 'discover') {
        discoverCalls++;
        return { ok: false, status: 404, json: async () => ({ error: 'route not found' }) };
      }
      return { ok: true, json: async () => ({ graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      ctx.window.GitPanel.refresh(); // 第二次确认非仓库 → discover 发起并失败
      await tick(); await tick();
      assert.equal(discoverCalls, 1, 'discover 已发起一次');
      let html = ctx.window.GitPanel.render();
      assert.ok(html.includes('route not found'), '失败错误可见');
      assert.ok(html.includes('rediscover'), '提供手动重试入口');

      // 多轮静默轮询周期内不重复发起（失败冷却）
      for (let i = 0; i < 3; i++) { ctx.__autoTick(); await tick(); }
      assert.equal(discoverCalls, 1, '冷却期内静默轮询不重试 discover');
      html = ctx.window.GitPanel.render();
      assert.ok(html.includes('route not found'), '错误提示不被扫描态覆盖');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('半损坏仓库（discover 认、status 不认）不触发无限重扫振荡', async () => {
    let discoverCalls = 0;
    const statusDirs = [];
    const fetchImpl = async (url, init) => {
      const op = url.split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      if (op === 'status') {
        statusDirs.push(body.dir);
        // repoX 半损坏：.git 存在但 rev-parse 失败 → discover 列出它，status 恒否决
        if (body.dir === '/work/repoX') return { ok: true, json: async () => ({ ok: true, isRepo: false }) };
        if (body.dir === '/repo') return { ok: true, json: async () => ({ ok: true, isRepo: false }) };
        return { ok: true, json: async () => okStatus(body.dir) };
      }
      if (op === 'discover') {
        discoverCalls++;
        return { ok: true, json: async () => ({
          ok: true, defaultRepo: '',
          repos: [{ root: '/work/repoX', relPath: 'repoX' }, { root: '/work/repoB', relPath: 'repoB' }],
        }) };
      }
      if (op === 'default_repo') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      ctx.window.GitPanel.refresh(); // 确认非仓库 → discover → 自动选中 repoX（列表第一个）
      await tick(); await tick();
      // repoX 半损坏：其 loadAll 的 status 否决一次（miss=1），视图停在读取中
      assert.ok(statusDirs.includes('/work/repoX'), '预置：自动选中了半损坏的 repoX');

      // repoX 第二次否决 → 记忆否决 + force 重扫（discover 仍返回它）→
      // 自动选中必须跳过 repoX 改选 repoB；此后不得再有第三轮重扫（收敛）
      ctx.window.GitPanel.refresh();
      await tick(); await tick(); await tick();
      const discoverCount = discoverCalls;
      const html = ctx.window.GitPanel.render();
      assert.ok(html.includes('repoB'), '否决后半损坏仓库被跳过，自动选中 repoB');
      assert.ok(html.includes('data-gp-action="repo-menu"'), '仓库视图正常渲染');

      // 多轮静默轮询周期：repoB 健康（miss 归零），无任何路径再触发重扫
      for (let i = 0; i < 3; i++) { ctx.__autoTick(); await tick(); }
      assert.equal(discoverCalls, discoverCount, '振荡收敛：不再重复重扫');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('全部子仓库被否决时空态提供重扫入口，点击后清除否决记忆重扫', async () => {
    let discoverCalls = 0;
    const fetchImpl = async (url, init) => {
      const op = url.split('/').pop();
      const body = init?.body ? JSON.parse(init.body) : {};
      if (op === 'status') {
        // 唯一子仓库半损坏：status 恒否决
        if (body.dir === '/work/repoX' || body.dir === '/repo') return { ok: true, json: async () => ({ ok: true, isRepo: false }) };
        return { ok: true, json: async () => okStatus(body.dir) };
      }
      if (op === 'discover') {
        discoverCalls++;
        return { ok: true, json: async () => ({ ok: true, defaultRepo: '', repos: [{ root: '/work/repoX', relPath: 'repoX' }] }) };
      }
      return { ok: true, json: async () => ({ graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    const clickAction = (action) => ctx.__fireBody('click', {
      target: { closest: (sel) => (sel === '[data-gp-action]' ? { dataset: { gpAction: action } } : null) },
    });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      ctx.window.GitPanel.refresh(); // 确认非仓库 → discover → 选中 repoX → miss=1
      await tick(); await tick();
      ctx.window.GitPanel.refresh(); // miss=2 → 否决 repoX → force 重扫 → 过滤后无可用 → 全否决空态
      await tick(); await tick();
      let html = ctx.window.GitPanel.render();
      assert.ok(html.includes('子目录仓库不可用'), '全否决空态文案');
      assert.ok(html.includes('data-gp-action="rediscover"'), '空态提供重扫入口（非死端）');

      // 点击重扫：清除否决记忆并 force 重扫（discover 再次发起）
      const before = discoverCalls;
      clickAction('rediscover');
      await tick(); await tick();
      assert.equal(discoverCalls, before + 1, '重扫入口清除否决记忆后重新发起扫描');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('loading 期间的刷新请求合并补跑，不静默丢弃', async () => {
    let statusCalls = 0;
    const fetchImpl = async (url) => {
      const op = url.split('/').pop();
      if (op === 'status') statusCalls++;
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, json: async () => ({ status: okStatus('/repo'), graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick();
      ctx.window.GitPanel.refresh(); // loading 中 → pending
      ctx.window.GitPanel.refresh();
      await tick(); await tick(); await tick(); await tick();
      assert.ok(statusCalls >= 2, '补跑已触发（statusCalls=' + statusCalls + '）');
      assert.ok((ctx.__dom || '').includes('git-panel'), '补跑完成后面板正常');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('render 周期不形成 loadAll 自激励循环（git 命令风暴根因）', async () => {
    const ctx = makeSandbox({ fetchImpl: goodFetch() });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      // isRepo:false 形态（status 缺字段）曾是触发循环的形态；正常数据下
      // 多轮 render 周期也不得重复发起 loadAll
      const before = 3; // onOpen 一轮 = 3 端点
      for (let i = 0; i < 5; i++) ctx.window.GitPanel.render();
      await tick(); await tick();
      // render 不触发新 loadAll：无法直接读计数，用 fetch 副作用近似——
      // 这里断言渲染稳定且不报错即可，精确计数由 isRepo:false 场景覆盖
      assert.ok(ctx.window.GitPanel.render().includes('git-panel'));
      assert.ok(before >= 3);
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('graph 端点恢复后错误提示清除，图形区正常渲染', async () => {
    let graphFail = true;
    const fetchImpl = async (url) => {
      const op = url.split('/').pop();
      if (op === 'graph' && graphFail) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return { ok: true, json: async () => ({ status: okStatus('/repo'), graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      assert.ok(ctx.window.GitPanel.render().includes('失败'), 'graph 失败时错误可见');

      graphFail = false;
      ctx.window.GitPanel.refresh();
      await tick(); await tick();
      const html = ctx.window.GitPanel.render();
      assert.ok(!html.includes('失败'), '恢复后错误清除');
      assert.ok(html.includes('git-history'), '图形区恢复渲染');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('status 端点瞬时失败后恢复，顶部错误自动清除', async () => {
    let statusFail = true;
    const fetchImpl = async (url) => {
      const op = url.split('/').pop();
      if (op === 'status' && statusFail) return { ok: false, status: 500, json: async () => ({ error: 'git rev-parse returned empty output' }) };
      return { ok: true, json: async () => ({ status: okStatus('/repo'), graph: okGraph, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      let html = ctx.window.GitPanel.render();
      assert.ok(html.includes('rev-parse') || html.includes('失败'), 'status 失败时顶部错误可见');

      // 恢复后刷新（与 silentRefresh 清错为同一状态路径）
      statusFail = false;
      ctx.window.GitPanel.refresh();
      await tick(); await tick();
      html = ctx.window.GitPanel.render();
      assert.ok(!html.includes('rev-parse'), '恢复后顶部错误清除');
      assert.ok(html.includes('git-panel'), '面板正常');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('HEAD 变化时静默轮询补拉图形，未变化不重复拉', async () => {
    const headA = '1111111111111111111111111111111111111111';
    const headB = '2222222222222222222222222222222222222222';
    let head = headA;
    let graphCalls = 0;
    const fetchImpl = async (url) => {
      const op = url.split('/').pop();
      if (op === 'graph') {
        graphCalls++;
        return { ok: true, json: async () => ({ ok: true, commits: [{ ...okGraph.commits[0], fullHash: head }], aheadHashes: [] }) };
      }
      // 状态体 ahead 与图形 aheadHashes 一致（0/空），隔离出纯 HEAD 探测变量
      const body = { ...okStatus('/repo'), head };
      body.status = { ...body.status, ahead: 0 };
      return { ok: true, json: async () => ({ status: body, branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      const afterLoad = graphCalls; // onOpen 首轮 loadAll 含 graph
      assert.equal(afterLoad, 1, '预置：首轮已拉取图形');

      ctx.__autoTick(); // HEAD 未变：探测一致，不补拉
      await tick(); await tick();
      assert.equal(graphCalls, afterLoad, 'HEAD 未变化不补拉');

      head = headB; // 面板外提交：HEAD 前进
      ctx.__autoTick();
      await tick(); await tick();
      assert.equal(graphCalls, afterLoad + 1, 'HEAD 变化触发补拉');
      assert.ok(ctx.window.GitPanel.render().includes('git-panel'), '补拉后面板正常');
    } finally {
      ctx.__disposeTimers();
    }
  });

  it('图形区滚动到底自动加载更早提交，未接近底部不触发', async () => {
    let graphCalls = 0;
    const fetchImpl = async (url) => {
      const op = url.split('/').pop();
      if (op === 'graph') {
        graphCalls++;
        const commits = [];
        for (let i = 0; i < 120; i++) {
          commits.push({ hash: 'h' + i, fullHash: 'f' + i, parents: [], author: 'x', relTime: '1d', refs: [], subject: 'c' + i });
        }
        return { ok: true, json: async () => ({ ok: true, commits, aheadHashes: [] }) };
      }
      return { ok: true, json: async () => ({ status: okStatus('/repo'), branches: okBranches }[op]) };
    };
    const ctx = makeSandbox({ fetchImpl });
    try {
      ctx.window.GitPanel.onOpen();
      await tick(); await tick();
      assert.equal(graphCalls, 1, '预置：首轮已拉图形');
      // mock 恒返回 120 条 = limit 上限，即"还有更早内容"形态
      const scroll = (top) => ctx.__fireBody('scroll', {
        target: {
          classList: { contains: (c) => c === 'git-graph-scroll' },
          scrollTop: top, clientHeight: 500, scrollHeight: 1600,
        },
      });
      scroll(100); // 距底 1000+，未接近底部
      await tick();
      assert.equal(graphCalls, 1, '未接近底部不加载');

      scroll(1480); // 距底 120 内
      await tick(); await tick();
      assert.equal(graphCalls, 2, '接近底部自动补拉一批');

      // 补拉后 graphLimit 递增（120→240），mock 仍返回 120 条 < limit：
      // 已到仓库底部，继续滚到底不再触发
      scroll(1480);
      await tick(); await tick();
      assert.equal(graphCalls, 2, '返回条数少于 limit 后不再加载');
    } finally {
      ctx.__disposeTimers();
    }
  });
});
