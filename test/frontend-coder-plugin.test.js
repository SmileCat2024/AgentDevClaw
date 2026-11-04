/**
 * coder 前端插件契约。
 *
 * coder 的线程列表视图（原 modules/coder-threads-ui.js）已迁移为 ES 模块
 * 插件（public/src/plugins/coder/index.js）。本文件验证：
 *   1. 插件协议字段齐全（id / blocks / actions / mount / unmount），
 *      coder-threads block 必须由插件注册——宿主查表分发（claw-host
 *      renderBlock）找不到注册方时整个首页报「未知区块类型」，这是
 *      f9c8e104 试点时真实发生过的回归（当时删除了 if 链分发却无人接管）；
 *   2. 行动作用 data-action + data-thread-id 声明，属性值经转义不被
 *      引号截断（memo 便签点击回归的同类防线）；
 *   3. 卡片动作的条件语义：非归档卡片整卡可点（打开 head），归档卡片
 *      不可点（openConversationTarget 对归档线程会被服务端拒绝）；
 *   4. 卸载契约：自动刷新定时器被清除、视图状态（activeTab）复位。
 *
 * 装载纪律（全量回归稳定性）：动态 import 每次都是新模块图编译，启动
 * burst 会挤压真实子进程测试（ph-* runtime 6s 启动预算）的 CPU 余量
 * ——本文件与 ph-* 并行运行时实测挤掉过其预算。因此按状态需求分组共享
 * 实例：A 组（协议 / 默认渲染 / 属性编码）只读初始状态，共享一个实例；
 * B 组（tab 切换 / 卡片条件）自行管理 tab 状态，共享一个实例；卸载用例
 * 必须独享新实例。共享实例的自动刷新定时器在 after 钩子统一清理，失败
 * 路径也不泄漏（否则 Timeout 句柄让 node --test 挂住不退出）。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMinimalWindow } from './helpers/memo-plugin-loader.js';

const PLUGIN_FILE = path.resolve(
  import.meta.dirname, '..', 'public', 'src', 'plugins', 'coder', 'index.js',
);

async function loadPlugin(host) {
  const url = `${pathToFileURL(PLUGIN_FILE).href}?case=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  const descriptor = mod.default;
  if (typeof descriptor.mount === 'function') descriptor.mount(host);
  return descriptor;
}

function makeHost(overrides = {}) {
  const calls = { rerender: 0 };
  const host = {
    env: {
      language: 'zh',
      isZh: () => true,
      escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]),
      newIdempotencyKey: () => 'test-key',
    },
    workspace: {
      currentAgent: () => ({ id: 'coder' }),
      agentById: (id) => (id === 'coder'
        ? { id: 'coder', workspace_sessions: { sessions: [{ id: 'head-1', title: '索引标题' }] } }
        : null),
      rerender: () => { calls.rerender++; },
    },
    ...overrides,
  };
  return { host, calls };
}

function withThreads(threads) {
  globalThis.window.ClawThreads = { threads, initialLoadDone: true };
}

const SAMPLE_THREADS = [
  { threadId: 'wt-exec', agentId: 'coder', lifeState: 'executing', headSessionId: 'head-1',
    headViewerAgentId: 'agent-1', lastEventAt: Date.now() - 60000 },
  { threadId: 'wt-idle', agentId: 'coder', lifeState: 'idle', headSessionId: 'head-1',
    lastEventAt: Date.now() - 3600000 },
  { threadId: 'wt-arch', agentId: 'coder', lifeState: 'archived', headSessionId: 'head-1',
    lastEventAt: Date.now() - 86400000 },
];

// 共享实例（按状态需求分组，见文件头注）。未装载时为 null，用例首次使用
// 时装载；after 统一 unmount，无论用例成败。
const shared = { A: null };
after(() => {
  for (const key of Object.keys(shared)) {
    try { shared[key]?.unmount(); } catch { /* unmount 自身的失败不掩盖测试结果 */ }
    shared[key] = null;
  }
});

async function pluginA() {
  if (!shared.A) shared.A = await loadPlugin(makeHost().host);
  // 共享实例跨用例：每个用例开头的 installMinimalWindow() 会重建 window、
  // 清掉线程夹具，因此每次取用都重新布置，保证断言输入稳定。
  withThreads(SAMPLE_THREADS);
  return shared.A;
}

test('coder 插件协议：coder-threads block 与行动作声明齐全', async () => {
  const restore = installMinimalWindow();
  try {
    const plugin = await pluginA();
    assert.equal(plugin.id, 'coder');
    assert.deepEqual(Object.keys(plugin.blocks), ['coder-threads']);
    assert.deepEqual(
      Object.keys(plugin.actions).sort(),
      [
        'coderThreads.archive',
        'coderThreads.interrupt',
        'coderThreads.openArchived',
        'coderThreads.openHead',
        'coderThreads.remove',
        'coderThreads.resume',
        'coderThreads.switchTab',
        'coderThreads.unarchive',
      ],
    );
    for (const handler of Object.values(plugin.actions)) {
      assert.equal(typeof handler, 'function');
    }
    assert.equal(typeof plugin.mount, 'function');
    assert.equal(typeof plugin.unmount, 'function');
  } finally { restore(); }
});

test('线程卡片渲染：状态徽标、动作按钮走 data-action，不残留内联 onclick', async () => {
  const restore = installMinimalWindow();
  try {
    const plugin = await pluginA();
    const html = plugin.blocks['coder-threads']({ id: 'coder' }, { type: 'coder-threads' });

    assert.ok(!html.includes('onclick='), '迁移后不得残留内联 onclick');
    assert.match(html, /data-action="coderThreads\.archive" data-thread-id="wt-exec"/);
    assert.match(html, /data-action="coderThreads\.interrupt" data-thread-id="wt-exec"/);
    // 执行中的线程按生命状态排在空闲前面（LIFE_ORDER 契约）
    assert.ok(html.indexOf('wt-exec') < html.indexOf('wt-idle'), 'executing 排在 idle 前');
    // 默认 tab 只含活跃线程：已归档线程不在「线程」页出现
    assert.ok(!html.includes('data-thread-id="wt-arch"'));
    // 标题回退链：索引标题（headSessionTitle）优先于短 id
    assert.ok(html.includes('索引标题'));
  } finally { restore(); }
});

test('属性编码安全：threadId 含引号与尖括号时 data-thread-id 不被截断', async () => {
  const restore = installMinimalWindow();
  try {
    const plugin = await pluginA();
    const hostile = 'wt-"x><script>';
    withThreads([{ threadId: hostile, agentId: 'coder', lifeState: 'idle', headSessionId: 'h1' }]);
    const html = plugin.blocks['coder-threads']({ id: 'coder' }, { type: 'coder-threads' });
    withThreads(SAMPLE_THREADS); // 还原共享实例的全局夹具，不影响后续用例

    // 每一个 data-thread-id 属性值解码后必须还原原值（按钮与整卡动作
    // 两个输出点都被校验——只查单点或只查「含转义形态」会漏掉另一输出
    // 点未转义的回归）。memo 便签回归（6c1a5968）的根因正是裸双引号
    // 截断属性值后解析失败、点击静默无反应。
    const decodeAttr = (value) => value
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const values = [...html.matchAll(/data-thread-id="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(values.length >= 2, '按钮与整卡动作两处都输出 data-thread-id');
    for (const value of values) {
      assert.ok(!value.includes('<') && !value.includes('>'), '属性值中的尖括号必须已转义');
      assert.equal(decodeAttr(value), hostile, '属性值解码后还原原 threadId');
    }
  } finally { restore(); }
});

test('归档 tab：switchTab 动作切换列表并经宿主重渲染', async () => {
  const restore = installMinimalWindow();
  try {
    const { host, calls } = makeHost();
    const plugin = await loadPlugin(host); // B 组状态起点（threads tab）
    try {
      withThreads(SAMPLE_THREADS);
      plugin.actions['coderThreads.switchTab']({ dataset: { tab: 'archived' } });
      assert.equal(calls.rerender, 1, '切 tab 经宿主 rerender 重建视图');
      const html = plugin.blocks['coder-threads']({ id: 'coder' }, { type: 'coder-threads' });
      assert.ok(!html.includes('data-thread-id="wt-exec"'), '已归档 tab 不含活跃线程');
      assert.ok(html.includes('data-thread-id="wt-arch"'));
      assert.match(html, /data-action="coderThreads\.unarchive" data-thread-id="wt-arch"/);
      // 复位回默认 tab，供 B 组后续用例从初始状态开始
      plugin.actions['coderThreads.switchTab']({ dataset: { tab: 'threads' } });
    } finally { plugin.unmount(); }
  } finally { restore(); }
});

test('卡片动作条件：非归档卡片整卡可点，归档卡片不带打开动作', async () => {
  const restore = installMinimalWindow();
  try {
    const plugin = await loadPlugin(makeHost().host);
    try {
      withThreads(SAMPLE_THREADS);
      const activeHtml = plugin.blocks['coder-threads']({ id: 'coder' }, { type: 'coder-threads' });
      const cardExec = activeHtml.split('<article').find((chunk) => chunk.includes('wt-exec'));
      assert.ok(cardExec.includes('data-action="coderThreads.openHead"'), '非归档卡片整卡可点打开 head');

      plugin.actions['coderThreads.switchTab']({ dataset: { tab: 'archived' } });
      const archivedHtml = plugin.blocks['coder-threads']({ id: 'coder' }, { type: 'coder-threads' });
      const cardArch = archivedHtml.split('<article').find((chunk) => chunk.includes('wt-arch'));
      assert.ok(!cardArch.includes('data-action="coderThreads.openHead"'), '归档卡片不可点开 head（服务端会拒绝）');
      assert.ok(cardArch.includes('data-action="coderThreads.openArchived"'), '归档行的查看动作是只读浏览');
    } finally { plugin.unmount(); }
  } finally { restore(); }
});

test('卸载契约：自动刷新定时器被清除，视图状态复位', async () => {
  const restore = installMinimalWindow();
  let plugin;
  try {
    const { host, calls } = makeHost();
    plugin = await loadPlugin(host);
    withThreads(SAMPLE_THREADS);
    plugin.blocks['coder-threads']({ id: 'coder' }, { type: 'coder-threads' }); // 触发 scheduleAutoRefresh

    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.ok(timersBefore > 0, '渲染后存在自动刷新定时器');

    plugin.actions['coderThreads.switchTab']({ dataset: { tab: 'archived' } });
    plugin.unmount();
    const timersAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.equal(timersAfter, timersBefore - 1, 'unmount 清除自动刷新定时器');

    // 状态复位：重新装载后从默认「线程」tab 开始
    const reloaded = await loadPlugin(makeHost().host);
    try {
      withThreads(SAMPLE_THREADS);
      const html = reloaded.blocks['coder-threads']({ id: 'coder' }, { type: 'coder-threads' });
      assert.ok(html.includes('data-thread-id="wt-exec"'), '重新装载回到默认线程 tab');
      assert.equal(calls.rerender, 1);
    } finally { reloaded.unmount(); }
  } finally { plugin?.unmount(); restore(); }
});
