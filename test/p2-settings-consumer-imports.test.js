/**
 * 设置域消费方显式依赖收敛（P2 收尾 · 设置批次）契约。
 *
 * 本批把设置域的 window 消费面收成命名导出，测试锁定三件事：
 *   1. ph-settings 的「思考档位表」与「下拉增强」走命名导出：把 window 面上的
 *      等价入口毒化后，面板渲染链路照常产出真实选项，且毒化入口零调用——
 *      证明不存在 window 兜底读取（原先靠 `window.ClawFW.getThinkingEffortOptions`
 *      / `window.ClawSelect` 守卫的路径已删除）；
 *   2. container-images 的两个面板生命周期入口不再是 window 全局键（唯一消费方
 *      ph-settings 已静态 import）；
 *   3. 设置态不再是 window.ClawFW 借宿键：settingsData / settingsEditing /
 *      codexConnectionView 与目录页四键（modelCatalogs / modelCatalogSelection /
 *      modelCatalogMulti / modelCatalogAvailable）归 model-settings 模块私有，
 *      语音预设编辑态归 speech-settings 持有并经命名导出与面板 owner 互通，
 *      界面行为不变；settingsOpen / settingsTab 仍留在 ClawFW（classic app-ui 读写）；
 *   4. 私有状态的活读面有正向证据（删掉实现即红）：Codex 连接视图 / 预设编辑态经
 *      宿主 getter 决定「查账号列表还是查单预设 token」、目录多选的勾选集合跨渲染
 *      存活并可落盘、model-settings 与 feature-config-editor 渲染尾部的 enhanceAll
 *      真的增强了原生 select。
 *
 * 装载路线（ESM 迁移配方第三节）：一次用例 = 一条真实 classic 链
 * （p2-classic-hosts 的 prepareClassicSandbox，宿主工厂就是生产实现）+ 一张真实
 * ESM 图（withP2EsmCase 的 case 级命名空间）。断言全部走公开入口：模块渲染入口
 * 与 data-action 分发器，不为测试暴露内部函数。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const PH_SETTINGS = 'public/src/modules/ph-settings.js';
const MODEL_SETTINGS = 'public/src/modules/model-settings.js';

/** 按 id 复用的最小 DOM：面板渲染只写 innerHTML，读取按 id 定位宿主。 */
function createDocumentStub() {
  const elements = new Map();
  // 用例注入面：可增强的原生 select 清单、多选勾选中的复选框清单
  const state = { selects: [], checkedInputs: [] };
  const matchesSelectQuery = (selector) => String(selector).includes('select[data-claw-select]');
  const makeElement = (id) => ({
    id,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: (selector) => (matchesSelectQuery(selector) ? state.selects : []),
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    type: 'text',
  });
  const doc = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: (selector) => (String(selector).includes('checked') ? state.checkedInputs : []),
    createElement: () => makeElement(''),
    createTextNode: (text) => ({ textContent: text }),
    addEventListener() {},
    body: makeElement('body'),
    head: makeElement('head'),
    documentElement: makeElement('html'),
    activeElement: null,
    readyState: 'complete',
  };
  doc.elements = elements;
  doc.state = state;
  return doc;
}

/**
 * 可被 claw-select 真实增强的原生 select 替身：记录 enhance 插入的包裹元素。
 * enhance 的产物是「.claw-select 包裹 + 触发器 + 原生元素搬入包裹」，因此
 * `dataset.clawEnhanced` 与插入记录共同构成「调用真的发生过」的正向证据。
 */
function createEnhanceableSelect(id) {
  const parent = {
    insertions: [],
    insertBefore(node, reference) { this.insertions.push({ node, reference }); },
  };
  const select = {
    tagName: 'SELECT',
    id,
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    disabled: false,
    selectedIndex: 0,
    options: [{ value: 'probe', textContent: 'Probe' }],
    parentNode: parent,
    getAttribute: () => null,
    removeAttribute() {},
    setAttribute() {},
    addEventListener() {},
    closest: () => null,
  };
  select.enhancedWrapper = () => parent.insertions.find((entry) => entry.reference === select)?.node || null;
  return select;
}

/** 让后台链（目录 / 账号列表 / token 查询）结清 */
async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 真实 classic 链 + 用例局部 DOM / fetch；rAF 同步执行，让渲染尾部的增强落地。 */
function withSettingsCase({ document, fetch }, fn) {
  return withP2EsmCase({
    globals: { document, fetch },
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
      // prepareClassicSandbox 关掉 rAF（首屏渲染不在用例范围）；设置面板的重渲染
      // 尾部用 rAF 做下拉增强，这里改成同步执行以便断言增强是否落地。
      sandbox.run('requestAnimationFrame = (callback) => { callback(); return 0; };');
    },
  }, fn);
}

const defaultFetch = async () => ({ ok: true, json: async () => ({}) });

test('ph-settings：思考档位与下拉增强走命名导出，毒化 window 面不影响渲染', async () => {
  const document = createDocumentStub();
  await withSettingsCase({ document, fetch: defaultFetch }, async (c) => {
    const settings = await c.load(PH_SETTINGS);
    settings.setPhSettingsAgentId('programming-helper');

    // 毒化等价 window 入口：若面板仍有 window 兜底读取，就会写这些计数器
    const realClawSelect = c.window.ClawSelect;
    c.window.ClawSelect = { enhanceAll: () => { c.window.__clawSelectCalls = (c.window.__clawSelectCalls || 0) + 1; } };
    c.window.ClawFW.getThinkingEffortOptions = () => { c.window.__effortCalls = (c.window.__effortCalls || 0) + 1; return ['poisoned']; };

    try {
      settings.renderPhSettingsOverlay(
        { id: 'programming-helper', modelPresets: { default: { primary: 'anthropic-a' } } },
        [
          { name: 'anthropic-a', provider: 'anthropic', model: 'claude-test' },
          { name: 'openai-b', provider: 'openai', model: 'gpt-test' },
        ],
      );
      const html = document.getElementById('ph-settings-host').innerHTML;
      // 真实档位表（input-model-switcher 命名导出）：anthropic 族含 max、不含 minimal
      assert.match(html, /<option value="max"/, 'anthropic 档位来自命名导出');
      assert.doesNotMatch(html, /<option value="poisoned"/, '不得取自被毒化的 window 入口');
      assert.equal(c.window.__effortCalls, undefined, '思考档位不得再经 window 读取');
      assert.equal(c.window.__clawSelectCalls, undefined, '下拉增强不得再经 window 读取');
    } finally {
      c.window.ClawSelect = realClawSelect;
    }
  });
});

test('container-images：面板生命周期入口已是命名导出，window 面不再有全局键', async () => {
  await withSettingsCase({ document: createDocumentStub(), fetch: defaultFetch }, async (c) => {
    const containerImages = await c.load('public/src/modules/container-images.js');
    assert.equal(typeof containerImages.registerContainerImagesHost, 'function');
    assert.equal(typeof containerImages.loadContainerImagesPanel, 'function');
    assert.equal('registerContainerImagesHost' in c.window, false, '不再挂 window 全局键');
    assert.equal('loadContainerImagesPanel' in c.window, false, '不再挂 window 全局键');
  });
});

test('设置态归 owner 模块：ClawFW 上再无 settingsData / settingsEditing / codexConnectionView / _speechEditing 与目录页四键', async () => {
  const document = createDocumentStub();
  const fetch = async (url) => {
    if (String(url) === '/protoclaw/model_config') {
      return {
        ok: true,
        json: async () => ({
          config: { defaultModel: {}, agent: {} },
          presets: [{ name: '回归用模型', provider: 'anthropic', model: 'claude-test' }],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
  await withSettingsCase({ document, fetch }, async (c) => {
    const modelSettings = await c.load(MODEL_SETTINGS);
    await modelSettings.openSettings();

    for (const key of [
      'settingsData', 'settingsEditing', 'codexConnectionView', '_speechEditing',
      // 目录页状态（目录表 / 多选集合 / 多选开关 / 可添加行索引序列）：本模块私有
      'modelCatalogs', 'modelCatalogSelection', 'modelCatalogMulti', 'modelCatalogAvailable',
    ]) {
      assert.equal(key in c.window.ClawFW, false, `ClawFW.${key} 应已收敛为模块私有/owner 命名面`);
    }
    // settingsOpen / settingsTab 仍是 classic app-ui 的读写面，保留在 ClawFW
    assert.equal(c.window.ClawFW.settingsOpen, true, 'settingsOpen 仍由 ClawFW 承载（classic 消费）');
  });
});

test('语音预设编辑态经 speech-settings 命名导出驱动面板编辑表单（真实动作路径）', async () => {
  const document = createDocumentStub();
  const fetch = async (url) => {
    if (String(url) === '/protoclaw/model_config') {
      return { ok: true, json: async () => ({ config: { defaultModel: {}, agent: {} }, presets: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  await withSettingsCase({ document, fetch }, async (c) => {
    const modelSettings = await c.load(MODEL_SETTINGS);
    await modelSettings.openSettings();

    const overlayHtml = () => document.getElementById('settings-overlay-host').innerHTML;
    const invoke = (name, el = { dataset: {} }, ...rest) => c.window.ClawFW.actions.invoke(name, el, { type: 'click' }, ...rest);

    // 切到语音页 → 列表态：没有编辑表单
    await invoke('modelSettings.switchTab', { dataset: { tab: 'speech' } });
    assert.equal(c.window.ClawFW.settingsTab, 'speech');
    assert.doesNotMatch(overlayHtml(), /id="speech-preset-name"/, '列表态不渲染预设编辑表单');

    // 「配置模型」→ addSpeechPreset：编辑态由 speech-settings 持有，面板重渲染出表单
    await invoke('modelSettings.addSpeechPreset');
    assert.match(overlayHtml(), /id="speech-preset-name"/, '新建态渲染语音预设编辑表单');
    assert.match(overlayHtml(), /data-action="modelSettings\.saveSpeechPreset"/, '编辑态底部出现保存按钮');

    // 「取消」→ 编辑态清空，回到列表态
    await invoke('modelSettings.cancelSpeechEdit');
    assert.doesNotMatch(overlayHtml(), /id="speech-preset-name"/, '取消后回到列表态');
  });
});

test('model-settings：渲染尾部对 data-claw-select 执行真实增强（删掉 enhanceAll 即红）', async () => {
  const document = createDocumentStub();
  const select = createEnhanceableSelect('settings-model-probe');
  document.state.selects = [select];
  const fetch = async (url) => {
    if (String(url) === '/protoclaw/model_config') {
      return { ok: true, json: async () => ({ config: { defaultModel: {}, agent: {} }, presets: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  await withSettingsCase({ document, fetch }, async (c) => {
    const modelSettings = await c.load(MODEL_SETTINGS);
    await modelSettings.openSettings();
    assert.equal(select.dataset.clawEnhanced, 'true', '原生 select 被真实增强（enhanceAll 确实被调用）');
    const wrapper = select.enhancedWrapper();
    assert.ok(wrapper, '增强包裹元素已插入到 select 之前');
    assert.equal(wrapper.className, 'claw-select', '包裹元素是 ClawSelect 的容器');
  });
});

test('feature-config-editor：分区渲染后对 data-claw-select 执行真实增强（删掉 enhanceAll 即红）', async () => {
  const select = createEnhanceableSelect('fce-probe');
  const mainElement = {
    innerHTML: '',
    scrollTop: 0,
    querySelector: () => null,
    querySelectorAll: (selector) => (String(selector).includes('select[data-claw-select]') ? [select] : []),
  };
  const host = {
    innerHTML: '',
    querySelector: (selector) => (String(selector).includes('data-fce-main') ? mainElement : null),
    querySelectorAll: () => [],
    appendChild() {},
    addEventListener() {},
  };
  const fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('/protoclaw/system_feature_manifests')) {
      return {
        ok: true,
        json: async () => ({
          features: [{ featureName: 'shell', manifest: { settings: { properties: { timeout: { type: 'number', title: 'Timeout' } } } } }],
          mountedExtras: [],
        }),
      };
    }
    if (target.startsWith('/protoclaw/feature_config/resolved')) {
      return { ok: true, json: async () => ({ layers: [], accumulatedFields: [] }) };
    }
    // shell_availability 不 ok → 编辑器跳过 shell 可用性徽标（与本用例无关）
    if (target === '/protoclaw/shell_availability') return { ok: false, status: 0, json: async () => ({}) };
    if (target === '/protoclaw/model_config') return { ok: true, json: async () => ({ presets: [] }) };
    return { ok: true, json: async () => ({}) };
  };
  await withSettingsCase({ document: createDocumentStub(), fetch }, async (c) => {
    const { createFeatureConfigEditor } = await c.load('public/src/modules/feature-config-editor.js');
    const editor = createFeatureConfigEditor({ host, scopeId: 'agent' });
    await editor.open();
    assert.equal(select.dataset.clawEnhanced, 'true', '参数配置页的 select 被真实增强（enhanceSelects 确实被调用）');
    assert.ok(select.enhancedWrapper(), '增强包裹元素已插入到 select 之前');
  });
});

test('Codex 连接视图 vs 预设编辑态：OAuth 子面板经宿主 getter 取活状态', async () => {
  const document = createDocumentStub();
  const calls = [];
  const fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push(target + (options.method ? ' ' + options.method : ''));
    if (target === '/protoclaw/model_config' && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ config: body.config, presets: body.presets }) };
    }
    if (target === '/protoclaw/model_config') {
      return {
        ok: true,
        json: async () => ({
          config: { defaultModel: {}, agent: {} },
          // 两个 Codex 账号预设：「列表页默认取第一个」与「编辑态按下标取」必须可区分，
          // 否则 getSettingsEditing 失效（恒 null）时断言仍会绿。
          presets: [
            { name: 'Codex 主账号', provider: 'openai', authType: 'oauth-codex', catalogProvider: 'codex', providerName: 'Codex-Acct', model: 'gpt-5' },
            { name: 'Codex 备用', provider: 'openai', authType: 'oauth-codex', catalogProvider: 'codex', providerName: 'Codex-Backup', model: 'gpt-5-mini' },
          ],
        }),
      };
    }
    if (target.startsWith('/protoclaw/model_catalog/')) {
      return { ok: true, json: async () => ({ models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] }) };
    }
    if (target.startsWith('/protoclaw/oauth/codex/accounts')) {
      return { ok: true, json: async () => ({ accounts: [{ providerName: 'Codex-Acct', displayName: '主账号', hasToken: true, active: true, status: { loggedIn: true } }] }) };
    }
    if (target.startsWith('/protoclaw/oauth/codex/tokens/')) return { ok: true, json: async () => ({ loggedIn: true }) };
    if (target.startsWith('/protoclaw/oauth/codex/defaults')) return { ok: true, json: async () => ({ proxyConfigured: true }) };
    return { ok: true, json: async () => ({}) };
  };
  await withSettingsCase({ document, fetch }, async (c) => {
    const modelSettings = await c.load(MODEL_SETTINGS);
    await modelSettings.openSettings();
    await flush();

    const invoke = (name, el = { dataset: {} }, ...rest) => c.window.ClawFW.actions.invoke(name, el, { type: 'click' }, ...rest);
    const overlayHtml = () => document.getElementById('settings-overlay-host').innerHTML;
    const tokenCalls = () => calls.filter((entry) => entry.includes('/oauth/codex/tokens/'));

    // 目录页（codexConnectionView=false）
    await invoke('modelSettings.switchTab', { dataset: { tab: 'codex' } });
    await flush();
    assert.doesNotMatch(overlayHtml(), /modelSettings\.closeCodexConnections/, '目录页没有账号页返回按钮');

    // 进入账号列表页：codexConnectionView 经宿主 getter 读到 true
    calls.length = 0;
    await invoke('modelSettings.openCodexConnections');
    await flush();
    const authHtml = overlayHtml();
    assert.match(authHtml, /modelSettings\.closeCodexConnections/, '连接视图渲染返回按钮（isCodexConnectionView 读到 true）');
    assert.match(document.getElementById('codex-accounts-list').innerHTML, /主账号/, '账号列表经真实渲染路径回填');
    assert.equal(tokenCalls().length, 0, '连接视图下不查单个预设 token（refreshOAuthStatus 走账号列表分支）');

    // 连接视图内登出：DELETE 之后的状态刷新必须走账号列表分支（isCodexConnectionView getter）
    calls.length = 0;
    await invoke('oauthFlow.logout');
    await flush();
    const tokenReads = calls.filter((entry) => entry.includes('/oauth/codex/tokens/') && !entry.endsWith('DELETE'));
    assert.equal(tokenReads.length, 0, `连接视图下状态刷新不查单预设 token（实际：${calls.join(' | ')}）`);
    assert.ok(
      calls.some((entry) => entry.includes('/oauth/codex/tokens/') && entry.endsWith('DELETE')),
      '登出请求本身仍按预设 providerName 发出',
    );
    assert.ok(
      calls.some((entry) => entry.startsWith('/protoclaw/oauth/codex/accounts')),
      '状态刷新经账号列表分支回填（isCodexConnectionView 读到 true）',
    );

    // 返回目录页后编辑第二个 Codex 预设：settingsEditing / settingsData 经 getter 活读。
    // 编辑索引生效的证据：查的是该下标的 providerName（Codex-Backup），而不是
    // 列表页默认取到的第一个（Codex-Acct）。
    await invoke('modelSettings.closeCodexConnections');
    await flush();
    calls.length = 0;
    await invoke('modelSettings.editPreset', { dataset: {} }, 1);
    await flush();
    assert.ok(
      tokenCalls().some((entry) => entry.startsWith('/protoclaw/oauth/codex/tokens/Codex-Backup')),
      `编辑态应按编辑下标对应预设的 providerName 查询 token（实际请求：${calls.join(' | ')}）`,
    );
    assert.equal(
      tokenCalls().some((entry) => entry.includes('/tokens/Codex-Acct')),
      false,
      '编辑态不得回落到列表页第一个 oauth 预设（即 settingsEditing 被当成 null）',
    );
  });
});

test('目录多选：勾选集合与添加落盘都走模块私有状态 + 真实保存链', async () => {
  const document = createDocumentStub();
  const calls = [];
  const fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push(target + (options.method ? ' ' + options.method : ''));
    if (target === '/protoclaw/model_config' && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ config: body.config, presets: body.presets }) };
    }
    if (target === '/protoclaw/model_config') {
      return {
        ok: true,
        json: async () => ({
          config: { defaultModel: {}, agent: {} },
          presets: [{ name: '既有', provider: 'openai', catalogProvider: 'codex', model: 'gpt-5' }],
        }),
      };
    }
    if (target.startsWith('/protoclaw/model_catalog/')) {
      return { ok: true, json: async () => ({ models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'gpt-5-nano' }] }) };
    }
    if (target.startsWith('/protoclaw/oauth/codex/accounts')) return { ok: true, json: async () => ({ accounts: [] }) };
    return { ok: true, json: async () => ({}) };
  };
  await withSettingsCase({ document, fetch }, async (c) => {
    const modelSettings = await c.load(MODEL_SETTINGS);
    const presetCache = await c.load('public/src/modules/model-preset-cache.js');
    await modelSettings.openSettings();
    await flush();

    const invoke = (name, el = { dataset: {} }, ...rest) => c.window.ClawFW.actions.invoke(name, el, { type: 'click' }, ...rest);
    const overlayHtml = () => document.getElementById('settings-overlay-host').innerHTML;

    await invoke('modelSettings.switchTab', { dataset: { tab: 'codex' } });
    await flush();
    assert.doesNotMatch(overlayHtml(), /type="checkbox"/, '默认单选视图不渲染复选框');

    // 进入多选：modelCatalogMulti 私有状态生效，selection 重置
    await invoke('modelSettings.toggleCatalogMultiSelect');
    await flush();
    assert.match(overlayHtml(), /type="checkbox"/, '多选模式渲染复选框');

    // 勾选一个（真实 change 动作）→ 该 id 进入私有勾选集合
    await invoke('modelSettings.catalogModelSelection', { value: 'gpt-5-mini', checked: true });
    // 重新渲染（真实目录刷新动作）后该行仍呈选中态：勾选集合是模块私有状态、跨渲染存活
    await invoke('modelSettings.refreshCatalog', { dataset: { provider: 'codex' } });
    await flush();
    assert.match(
      overlayHtml(),
      /value="gpt-5-mini"[^>]*checked/,
      '重新渲染后已勾选模型保持选中（modelCatalogSelection 私有状态存活）',
    );

    document.state.checkedInputs = [{ value: 'gpt-5-mini' }];
    calls.length = 0;
    await invoke('modelSettings.addSelectedCatalogModels', { dataset: { provider: 'codex' } });
    await flush();
    const presets = presetCache.getClawModelPresets();
    assert.ok(presets.some((preset) => preset.model === 'gpt-5-mini'), '勾选的模型经真实保存链加入预设');
    assert.ok(calls.includes('/protoclaw/model_config PUT'), '添加后按真实保存链落盘');
  });
});
