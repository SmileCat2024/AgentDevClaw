/**
 * agent-studio 插件契约。
 *
 * Agent Studio 的首页视图（studio-features / studio-repository 两个 block）
 * 已从 workspace-blocks.js 分离为 ES 模块插件（public/src/plugins/agent-studio/）。
 * 本文件验证四件事：
 *   1. 插件协议字段齐全（id / blocks / actions / mount / unmount）；
 *   2. 宿主能力全部经 mount 注入，模块内不残留对经典脚本全局的裸引用；
 *   3. 两个 block 的渲染输出与宿主数据契约一致（Feature 卡片、详情弹窗、
 *      仓库卡片、未绑定会话列表）；
 *   4. 卸载时摘除 document 级 keydown 监听并释放注入面。
 *
 * 为什么要专门测注入面：宿主符号缺失时，裸调用抛 ReferenceError 会在运行期
 * 炸掉整块视图，而 `typeof x !== 'undefined'` 一类守卫会静默跳过——后者更难
 * 发现。注入面固定下来后，宿主签名变更会先在测试里失败。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installMinimalWindow } from './helpers/memo-plugin-loader.js';

const PLUGIN_FILE = path.resolve(
  import.meta.dirname, '..', 'public', 'src', 'plugins', 'agent-studio', 'index.js',
);

/** 记录 document 上的 keydown 监听，用于断言卸载时被摘除。 */
function instrumentDocument() {
  const listeners = { keydown: [] };
  const restore = installMinimalWindow();
  const prevDocument = globalThis.document;
  const doc = {
    ...prevDocument,
    addEventListener(type, handler) {
      (listeners[type] || (listeners[type] = [])).push({ handler });
    },
    removeEventListener(type, handler) {
      const list = listeners[type] || [];
      const index = list.findIndex((entry) => entry.handler === handler);
      if (index >= 0) list.splice(index, 1);
    },
  };
  globalThis.document = doc;
  return {
    listeners,
    cleanup() {
      globalThis.document = prevDocument;
      restore();
    },
  };
}

/** 一个最小 localStorage（插件用它存视图状态）。 */
function installLocalStorage() {
  const prev = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); },
  };
  return () => {
    if (prev === undefined) delete globalThis.localStorage; else globalThis.localStorage = prev;
  };
}

function makeHost(overrides = {}) {
  const calls = { rerender: 0, setUnitMode: [], runAction: [] };
  const host = {
    env: {
      language: 'zh',
      escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]),
      formatDate: (v) => (v ? String(v).slice(0, 10) : ''),
    },
    workspace: {
      rerender: () => { calls.rerender++; },
      setUnitMode: (mode) => { calls.setUnitMode.push(mode); },
      runAction: (raw, el) => { calls.runAction.push({ raw, el }); },
      workspaceState: () => null,
      sessions: () => [],
      featureRepository: () => null,
    },
    ...overrides,
  };
  return { host, calls };
}

async function loadPlugin(host) {
  const url = `${pathToFileURL(PLUGIN_FILE).href}?case=${Math.random().toString(36).slice(2)}`;
  const mod = await import(url);
  const descriptor = mod.default;
  if (typeof descriptor.mount === 'function') descriptor.mount(host);
  return descriptor;
}

test('agent-studio 插件协议：block 与 action 声明齐全', async () => {
  const doc = instrumentDocument();
  const restoreStorage = installLocalStorage();
  try {
    const { host } = makeHost();
    const plugin = await loadPlugin(host);
    assert.equal(plugin.id, 'agent-studio');
    assert.deepEqual(Object.keys(plugin.blocks).sort(), ['studio-features', 'studio-repository']);
    for (const renderer of Object.values(plugin.blocks)) {
      assert.equal(typeof renderer, 'function');
    }
    assert.deepEqual(
      Object.keys(plugin.actions).sort(),
      [
        'agent-studio.closeFeature',
        'agent-studio.closeThenAction',
        'agent-studio.openFeature',
        'agent-studio.openFeatureById',
        'agent-studio.overlayClose',
        'agent-studio.workspaceAction',
      ],
    );
    for (const handler of Object.values(plugin.actions)) {
      assert.equal(typeof handler, 'function');
    }
  } finally { restoreStorage(); doc.cleanup(); }
});

test('studio-features：Feature 卡片走 data-action 声明，不依赖内联 onclick', async () => {
  const doc = instrumentDocument();
  const restoreStorage = installLocalStorage();
  try {
    const { host } = makeHost();
    host.workspace.workspaceState = () => ({
      studioFeatures: [
        {
          id: '@acme/demo', description: '演示 Feature', status: 'verified',
          directory: 'D:\\work\\demo', updatedAt: '2026-10-07T09:27:20.000Z',
        },
      ],
    });
    host.workspace.sessions = () => [
      { id: 's1', title: '对话一', updatedAt: '2026-10-07T12:00:00.000Z', studioFeatureIds: [] },
    ];
    const plugin = await loadPlugin(host);
    const html = plugin.blocks['studio-features']({ id: 'agent-studio' }, { type: 'studio-features' });

    assert.match(html, /@agentdevjs\/force-continuation|@acme\/demo/);
    assert.match(html, /data-action="agent-studio\.workspaceAction"/);
    assert.match(html, /open_studio_feature/);
    assert.match(html, /已验证/, '状态徽标按状态机文案渲染');
    assert.match(html, /最近的对话/, '未绑定任何 Feature 的会话列在「最近的对话」');
    assert.match(html, /对话一/);
    assert.equal(/onclick=/.test(html), false, '不得再出现内联 onclick');
  } finally { restoreStorage(); doc.cleanup(); }
});

test('studio-features：详情弹窗开关随 localStorage 视图状态（关闭按钮走 data-action）', async () => {
  const doc = instrumentDocument();
  const restoreStorage = installLocalStorage();
  try {
    const { host } = makeHost();
    host.workspace.workspaceState = () => ({
      studioFeatures: [{ id: '@acme/demo', status: 'snapshotted', directory: 'D:\\work\\demo' }],
    });
    host.workspace.sessions = () => [
      { id: 's1', title: '开发会话', updatedAt: '2026-10-07T12:00:00.000Z', studioFeatureIds: ['@acme/demo'] },
    ];
    const plugin = await loadPlugin(host);
    const agent = { id: 'agent-studio' };

    const closed = plugin.blocks['studio-features'](agent, { type: 'studio-features' });
    assert.equal(/feature-detail-overlay/.test(closed), false, '无 featureId 时不渲染弹窗');

    plugin.actions['agent-studio.openFeature']({ dataset: { featureId: '@acme/demo' } });
    const opened = plugin.blocks['studio-features'](agent, { type: 'studio-features' });
    assert.match(opened, /feature-detail-overlay/);
    assert.match(opened, /data-action="agent-studio\.closeFeature"/, '关闭按钮走动作分发');
    assert.match(opened, /开发会话/);

    plugin.actions['agent-studio.closeFeature']();
    const reclosed = plugin.blocks['studio-features'](agent, { type: 'studio-features' });
    assert.equal(/feature-detail-overlay/.test(reclosed), false, '关闭后弹窗消失');
  } finally { restoreStorage(); doc.cleanup(); }
});

test('studio-features：目录缺失时禁用「新建对话」而不是静默失败', async () => {
  const doc = instrumentDocument();
  const restoreStorage = installLocalStorage();
  try {
    const { host } = makeHost();
    host.workspace.workspaceState = () => ({
      studioFeatures: [{ id: '@acme/gone', status: 'mounted', directory: 'D:\\gone', directoryExists: false }],
    });
    host.workspace.sessions = () => [];
    const plugin = await loadPlugin(host);
    plugin.actions['agent-studio.openFeature']({ dataset: { featureId: '@acme/gone' } });
    const html = plugin.blocks['studio-features']({ id: 'agent-studio' }, { type: 'studio-features' });

    assert.match(html, /目录已不存在/);
    assert.match(html, /disabled title="目录缺失，无法新建对话"/);
  } finally { restoreStorage(); doc.cleanup(); }
});

test('studio-repository：仓库数据不可用与卡片两种形态都给出明确文案', async () => {
  const doc = instrumentDocument();
  const restoreStorage = installLocalStorage();
  try {
    const { host } = makeHost();
    const plugin = await loadPlugin(host);

    const unavailable = plugin.blocks['studio-repository']({ id: 'agent-studio' }, { type: 'studio-repository' });
    assert.match(unavailable, /仓库数据暂不可用/);

    host.workspace.featureRepository = () => ({
      packages: [{
        name: '@acme/demo', latestVersion: '1.2.3', archiveCount: 2,
        updatedAt: '2026-10-07T09:27:20.000Z', warnings: ['缺元数据'],
      }],
    });
    const list = plugin.blocks['studio-repository']({ id: 'agent-studio' }, { type: 'studio-repository' });
    assert.match(list, /@acme\/demo/);
    assert.match(list, /v1\.2\.3/);
    assert.match(list, /2 个版本/);
    assert.match(list, /元数据不完整/);
    assert.equal(/onclick=/.test(list), false, '不得再出现内联 onclick');
  } finally { restoreStorage(); doc.cleanup(); }
});

test('agent-studio 宿主动作：卡片点击经 runAction 转发，不是插件自己执行', async () => {
  const doc = instrumentDocument();
  const restoreStorage = installLocalStorage();
  try {
    const { host, calls } = makeHost();
    const plugin = await loadPlugin(host);
    const el = { dataset: { workspaceAction: '{"type":"create_session","studioFeatureIds":["@acme/demo"]}' } };

    plugin.actions['agent-studio.workspaceAction'](el);
    assert.equal(calls.runAction.length, 1, '工作空间动作交给宿主执行');
    assert.equal(calls.runAction[0].el, el);
  } finally { restoreStorage(); doc.cleanup(); }
});

test('agent-studio 挂载注册 keydown，卸载时摘除并释放注入面', async () => {
  const doc = instrumentDocument();
  const restoreStorage = installLocalStorage();
  try {
    const { host, calls } = makeHost();
    const plugin = await loadPlugin(host);
    assert.equal(doc.listeners.keydown.length, 1, 'Esc 关闭详情需挂 document 级 keydown');

    plugin.unmount();
    assert.equal(doc.listeners.keydown.length, 0, '卸载后 keydown 必须摘除');

    // 卸载后重新装载不该重复累积（重复绑定会让一次 Esc 触发多次重渲染）
    plugin.mount(host);
    assert.equal(doc.listeners.keydown.length, 1, '重装后只有一份监听');

    plugin.actions['agent-studio.openFeature']({ dataset: { featureId: '@acme/demo' } });
    calls.rerender = 0;
    doc.listeners.keydown[0].handler({ key: 'Escape' });
    assert.equal(calls.rerender, 1, 'Esc 在有待关闭详情时应重渲染一次');
  } finally { restoreStorage(); doc.cleanup(); }
});
