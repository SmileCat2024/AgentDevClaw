/**
 * 基线审定前的桥注销钉子（P2 装配域收口）。
 *
 * 钉什么：4 个「消费方全部 ESM import」的桥键已注销——不是删导出，而是撤掉
 * window 访问器，语义与命名导出不变：
 *   assembly-actions : applyWorkspaceBundle
 *   assembly-data    : normalizeWorkspaceStartupDraft / saveWorkspaceFormDraft
 *   fw-config-panel  : maybeWarnAssemblySessionDrift
 *
 * 断言面分三块：
 *   1. 同 case 真实整图：classic 相按 index.html 先行脚本序执行真实 classic 链
 *      （test/p2-classic-hosts.js 的 prepareClassicSandbox），ESM 相经 withP2EsmCase
 *      真实 import 批次入口 p2-w2-10-assembly-bootstrap.js——四个键既不进
 *      defineKey 注册面，window 上也没有访问器，命名导出仍在。
 *   2. 原行为不丢：四个键各自仍有真实业务断言（装配环境草稿归一、表单草稿
 *      读写往返、批量勾选预设包、恢复旧对话前的漂移提示两分支），一律经模块
 *      命名空间调用（真实 import 调用路径），不恢复顶层全局。
 *   3. 源码面：桥对象字面量里不再有这四个键、导出面仍有它们；全 public 没有
 *      window.<键> 消费，也没有 classic 文件引用它们。
 *
 * 本文件不引入第二套图夹具：case 隔离、classic 链、真实 import 全部复用既有
 * helper；documents / fetch 只是外部能力桩（与 frontend-fw-config-panel.test.js
 * 同口径），不是模块替身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const REPO = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(REPO, 'public');
const ENTRY = 'public/src/modules/p2-w2-10-assembly-bootstrap.js';

/** 注销项：键 → 定义模块（真实模块路径）。 */
const RETIRED_BRIDGES = [
  { domain: 'assembly-actions', key: 'applyWorkspaceBundle', file: 'public/src/modules/assembly-actions.js' },
  { domain: 'assembly-data', key: 'normalizeWorkspaceStartupDraft', file: 'public/src/modules/assembly-data.js' },
  { domain: 'assembly-data', key: 'saveWorkspaceFormDraft', file: 'public/src/modules/assembly-data.js' },
  { domain: 'fw-config-panel', key: 'maybeWarnAssemblySessionDrift', file: 'public/src/modules/fw-config-panel.js' },
];

const source = (relativePath) => readFileSync(path.join(REPO, relativePath), 'utf8');

// ── 外部能力桩（document / fetch）──────────────────────────────────

function createElementStub(id = '') {
  const classes = new Set();
  return {
    id,
    innerHTML: '', textContent: '', value: '', hidden: false, className: '',
    style: {}, dataset: {}, children: [],
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const next = force === undefined ? !classes.has(name) : Boolean(force);
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
    },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    removeChild() {},
    insertAdjacentHTML() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {}, blur() {},
  };
}

/**
 * 最小 document：按 id 稳定复用元素（classic 相 sidebar-render 等脚本在装载期
 * 就取元素挂监听），漂移对话框经 createElement + body.appendChild 建宿主。
 */
function createDocumentStub() {
  const elements = new Map();
  const doc = {
    elements,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElementStub(id));
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement(tag) { return createElementStub(tag); },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {}, removeEventListener() {},
    body: {
      appendChild(child) {
        if (child?.id) elements.set(child.id, child);
      },
      innerHTML: '',
    },
    head: createElementStub('head'),
    documentElement: createElementStub('html'),
    activeElement: null,
    readyState: 'complete',
  };
  return doc;
}

// ── 用例上下文：真实 classic 链 + 真实 ESM 整图 ─────────────────────

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

/**
 * classic 相：真实先行脚本链（prepareClassicSandbox）。唯一用例侧补面是
 * renderCurrentMainView 计数替身（app-ui 首屏全量渲染需要 index.html 后半程
 * 全部 classic 脚本，不在本文件契约内），不是宿主契约。escapeHtml 不再补面：
 * markdown-utils 自带实现与桥键，ESM 图装载即注册。
 */
function loadClassicChain(sandbox) {
  prepareClassicSandbox(sandbox);
  sandbox.__renderCalls = 0;
  sandbox.renderCurrentMainView = () => { sandbox.__renderCalls += 1; };
}

/**
 * 一个用例 = 一份 classic 沙箱 + 一张真实 ESM 图；回调收到 case 上下文与
 * 批次入口装载后的模块命名空间（同图同实例）。
 */
async function withAssemblyCase(options, fn) {
  const { documentStub = createDocumentStub(), fetch: fetchImpl, classic = loadClassicChain } = options || {};
  const consoleErrors = [];
  const consoleWarns = [];
  const defaultFetch = async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '' });
  return withP2EsmCase({
    globals: {
      document: documentStub,
      fetch: fetchImpl || defaultFetch,
      console: {
        log: () => {},
        info: () => {},
        debug: () => {},
        warn: (...args) => { consoleWarns.push(args); },
        error: (...args) => { consoleErrors.push(args); },
      },
    },
    classic,
  }, async (c) => {
    const result = await fn(c);
    assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
    assert.deepEqual(consoleErrors, [], '用例内不应出现非预期 console.error');
    assert.deepEqual(consoleWarns, [], '用例内不应出现非预期 console.warn');
    return result;
  });
}

/** 同图装载：批次入口（六模块整图）+ 三个定义模块的命名空间。 */
async function loadGraph(c) {
  await c.load(ENTRY);
  const mods = {
    'assembly-actions': await c.load('public/src/modules/assembly-actions.js'),
    'assembly-data': await c.load('public/src/modules/assembly-data.js'),
    'fw-config-panel': await c.load('public/src/modules/fw-config-panel.js'),
  };
  return mods;
}

// ── 1. 注销面：注册为零、导出仍在、window 缺席 ──────────────────────

test('注销面：整图装载后四个键不进 defineKey 注册面，window 无访问器，命名导出仍在', async () => {
  await withAssemblyCase({}, async (c) => {
    const recordedKeys = [];
    const recordedClaims = [];
    const kernel = c.window.KernelState;
    const originalDefineKey = kernel.defineKey;
    const originalClaim = kernel.claim;
    kernel.defineKey = (domain, key, initialValue) => {
      recordedKeys.push(`${domain}:${key}`);
      return originalDefineKey.call(kernel, domain, key, initialValue);
    };
    kernel.claim = (domain, impl) => {
      recordedClaims.push(domain);
      return originalClaim.call(kernel, domain, impl);
    };
    let mods;
    try {
      mods = await loadGraph(c);
    } finally {
      kernel.defineKey = originalDefineKey;
      kernel.claim = originalClaim;
    }

    for (const { domain, key } of RETIRED_BRIDGES) {
      // 注册面：任何 domain 下都不再注册该 window 键（键名全名唯一，跨域同名会抛错）
      const sameName = recordedKeys.filter((entry) => entry.split(':')[1] === key);
      assert.deepEqual(sameName, [], `${key} 不应再注册桥键（实际：${sameName.join(', ')}）`);
    }

    // 三个定义域仍各自 claim 一次（注销只撤单键访问器，不动域所有权）
    for (const domain of ['assembly-actions', 'assembly-data', 'fw-config-panel']) {
      assert.equal(recordedClaims.filter((entry) => entry === domain).length, 1,
        `${domain} 应恰好 claim 一次`);
    }

    for (const { domain, key } of RETIRED_BRIDGES) {
      assert.equal(typeof mods[domain][key], 'function', `${domain}:${key} 应仍是命名导出`);
      assert.equal(Object.prototype.hasOwnProperty.call(c.window, key), false,
        `${key} 的桥已注销，window 上不得再有该键`);
      assert.equal(Object.getOwnPropertyDescriptor(c.window, key), undefined,
        `${key} 不应残留桥访问器`);
    }
  });
});

// ── 2. 原行为：四个键的业务断言全部经命名导出调用 ───────────────────

test('normalizeWorkspaceStartupDraft：feature-creator 的装配环境草稿归一语义不变', async () => {
  await withAssemblyCase({}, async (c) => {
    const mods = await loadGraph(c);
    const normalize = mods['assembly-data'].normalizeWorkspaceStartupDraft;
    const agent = {
      id: 'feature-creator',
      workspace_data: { 'startup-form': { systemInstallRoot: '/opt/agentdev' } },
    };

    // 非 custom 一律按 system 收敛，target_dir 取块声明里的系统安装根
    assert.deepEqual(
      normalize(agent, { install_mode: 'whatever', target_dir: '/leftover' }),
      { install_mode: 'system', target_dir: '/opt/agentdev' },
    );
    // custom 保留草稿目录
    assert.deepEqual(
      normalize(agent, { install_mode: 'custom', target_dir: '/custom/out' }),
      { install_mode: 'custom', target_dir: '/custom/out' },
    );
    // 其它 agent：浅拷贝原草稿，不改入参
    const raw = { feature_name: 'demo-feature' };
    const normalized = normalize({ id: 'programming-helper' }, raw);
    assert.deepEqual(normalized, raw);
    assert.notEqual(normalized, raw, '返回的应是副本，不是同一个对象');
  });
});

test('saveWorkspaceFormDraft：表单草稿写入 localStorage 并被 getWorkspaceFormDraft 读回', async () => {
  await withAssemblyCase({}, async (c) => {
    const mods = await loadGraph(c);
    const { saveWorkspaceFormDraft, getWorkspaceFormDraft } = mods['assembly-data'];
    const agent = {
      id: 'agent-creator',
      workspace_state: { forms: { 'startup-form': { target_dir: '/server/root' } } },
      workspace_data: {},
    };

    saveWorkspaceFormDraft('agent-creator', { 'assembly-form': { assembly_name: 'demo-agent' } });
    const stored = JSON.parse(c.window.localStorage.getItem('protoclaw:workspace-form:agent-creator'));
    assert.deepEqual(stored, { 'assembly-form': { assembly_name: 'demo-agent' } },
      '草稿应按 agent 粒度落到本地存储键');

    // 读回：server forms 与本地草稿合并，本地草稿覆盖同名表单；
    // agent-creator 的 assembly 表单在读回时按草稿归一（缺省字段补齐）
    const draft = getWorkspaceFormDraft(agent);
    assert.equal(draft['assembly-form'].assembly_name, 'demo-agent');
    assert.equal(draft['assembly-form'].env_created, '0', '读回应走 normalizeAssemblyDraft 归一');
    // startup-form 同样在读回时归一：agent-creator 默认 system 安装模式，
    // 无块声明（workspace_data 为空）时系统安装根为空
    assert.deepEqual(draft['startup-form'], { target_dir: '', install_mode: 'system' },
      '服务端 startup 草稿按 agent 归一后读回');
  });
});

test('applyWorkspaceBundle：批量勾选预设包合并进草稿并落盘、触发一次重渲染', async () => {
  const fetchCalls = [];
  await withAssemblyCase({
    // 服务端回显 request body 里的 state（与 /protoclaw/workspace_state 契约同形）
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      const state = JSON.parse(init?.body || '{}').state || {};
      return { ok: true, status: 200, json: async () => state, text: async () => '' };
    },
  }, async (c) => {
    const mods = await loadGraph(c);
    const agent = {
      id: 'agent-creator',
      workspace_state: {
        forms: { 'assembly-form': { selected_features: 'memory-feature' } },
      },
      workspace_data: {},
    };
    c.window.getCurrentAgentRecord = () => agent;
    const rendersBefore = c.window.__renderCalls;

    await mods['assembly-actions'].applyWorkspaceBundle('assembly-form', {
      features: ['@agentdevjs/shell-feature'],
      toolkits: ['mcp-gateway'],
    });

    const stored = JSON.parse(c.window.localStorage.getItem('protoclaw:workspace-form:agent-creator'));
    assert.deepEqual(stored['assembly-form'].selected_features.split('\n').sort(),
      ['@agentdevjs/shell-feature', 'memory-feature'],
      '预设包 feature 应与草稿已有选择合并（含规范化）');
    assert.equal(stored['assembly-form'].recommended_toolkits, 'mcp-gateway');
    assert.equal(fetchCalls.length, 1, '应经 workspace_state 端点持久化一次');
    assert.equal(fetchCalls[0].url, '/protoclaw/workspace_state');
    assert.equal(c.window.__renderCalls, rendersBefore + 1, '批量勾选后触发一次重渲染');
  });
});

test('maybeWarnAssemblySessionDrift：无漂移直接放行，有漂移出对话框并等确认', async () => {
  const documentStub = createDocumentStub();
  await withAssemblyCase({ documentStub }, async (c) => {
    const mods = await loadGraph(c);
    const maybeWarn = mods['fw-config-panel'].maybeWarnAssemblySessionDrift;

    // 分支 1：session 不存在 / 不是装配会话 → 直接执行 onConfirm
    let passthrough = 0;
    await maybeWarn({ id: 'agent-creator', workspace_sessions: { sessions: [] } }, 'sess-missing', async () => {
      passthrough += 1;
    });
    assert.equal(passthrough, 1, '无漂移时应直接放行');
    assert.equal(documentStub.elements.has('assembly-drift-dialog-host'), false, '无漂移不建对话框宿主');

    // 分支 2：装配会话保存后配置被改过 → 弹漂移对话框，确认前不放行
    const agent = {
      id: 'agent-creator',
      workspace_sessions: {
        sessions: [{
          id: 'sess-old',
          formId: 'assembly-form',
          agentName: 'proj-a',
          updatedAt: '2026-01-01T00:00:00Z',
        }],
      },
      workspace_state: {
        forms: {},
        assemblyConfigs: [{ id: 'proj-a', name: 'proj-a', updatedAt: '2026-02-01T00:00:00Z' }],
      },
      workspace_data: {},
    };
    let confirmed = 0;
    await maybeWarn(agent, 'sess-old', async () => { confirmed += 1; });
    await flushAsync();

    assert.equal(documentStub.elements.has('assembly-drift-dialog-host'), true, '有漂移时应建出对话框宿主');
    const host = documentStub.elements.get('assembly-drift-dialog-host');
    assert.match(host.innerHTML, /data-action="fw\.driftProceed"/, '对话框应给出「继续打开」入口');
    assert.match(host.innerHTML, /feature-detail-overlay/, '应渲染漂移对话框主体');
    assert.equal(confirmed, 0, '确认前不得放行');

    // 真实动作分发器（本模块顶层 registerMany）→ 确认后执行 onConfirm 并清空对话框
    await c.window.ClawFW.actions.invoke('fw.driftProceed');
    await flushAsync();
    assert.equal(confirmed, 1, '确认后应执行 onConfirm');
    assert.equal(documentStub.elements.get('assembly-drift-dialog-host').innerHTML, '',
      '确认后对话框内容应清空');
  });
});

// ── 3. 源码面：桥对象不再含这四键、导出面保留、消费面归零 ────────────

function listPublicSources(dir = PUBLIC, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'vendor' || entry.name === 'assets' || entry.name === 'node_modules') continue;
      listPublicSources(full, out);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const isEsm = (text) => /^\s*(?:import|export)\s/m.test(text);

test('源码面：桥对象字面量不再含这四个键，导出面保留', () => {
  for (const { file, key } of RETIRED_BRIDGES) {
    const text = source(file);
    const bridgeBlock = text.match(/const bridgeState = \{[\s\S]*?\n\};/);
    assert.ok(bridgeBlock, `${file} 应有 bridgeState 字面量`);
    assert.equal(new RegExp(`\\b${key}\\b`).test(bridgeBlock[0]), false,
      `${file} 的桥对象不应再含 ${key}`);
    assert.match(text, new RegExp(`\\b${key}\\b`), `${file} 仍应定义/导出 ${key}`);
    assert.match(text, new RegExp(`^\\s+${key},$`, 'm'), `${file} 的 export 清单应仍含 ${key}`);
  }
});

test('消费面归零：全 public 无 window.<键> 访问，classic 文件不再引用这四个键', () => {
  const files = [...listPublicSources(), path.join(PUBLIC, 'index.html')];
  const failures = [];
  for (const { key } of RETIRED_BRIDGES) {
    const windowAccess = new RegExp(
      `\\bwindow\\s*(?:\\?\\.|\\.)\\s*${key}\\b|\\bwindow\\s*\\[\\s*['"]${key}['"]\\s*\\]`,
    );
    const mentions = new RegExp(`\\b${key}\\b`);
    const defines = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?function\\s+${key}\\b|(?:export\\s+)?(?:const|let|var)\\s+${key}\\b`,
    );
    const imports = new RegExp(`import\\s*\\{[^}]*\\b${key}\\b[^}]*\\}\\s*from`);

    for (const file of files) {
      const rel = path.relative(REPO, file);
      const text = readFileSync(file, 'utf8');
      const isHtml = file.endsWith('.html');
      if (!isHtml && windowAccess.test(text)) {
        failures.push(`${rel}: 仍有 window.${key} 访问`);
      }
      if (isHtml || (!mentions.test(text))) continue;
      // classic 文件不得再引用（引用即裸标识符全局消费）
      if (!isEsm(text)) {
        failures.push(`${rel}: classic 文件仍引用 ${key}`);
        continue;
      }
      // ESM 文件要么是 owner（定义/导出），要么以 import 引入
      if (!defines.test(text) && !imports.test(text)) {
        failures.push(`${rel}: ESM 文件引用 ${key} 但既未定义也未 import`);
      }
    }
  }
  assert.deepEqual(failures, [], `注销后仍有残留消费：\n${failures.join('\n')}`);
});
