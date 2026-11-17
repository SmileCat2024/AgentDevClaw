/**
 * fw-config-panel（装配工作台 FW 面板）契约。
 *
 * 装载路线（ESM 迁移配方第三节）：模块已迁 ESM，用例一律真实 `import`
 * （withP2EsmCase 的 c.load，每个用例整图隔离），不再把源码喂给 classic
 * 沙箱。断言面仍是原公开契约：
 *   - fw 的 UI 状态键是模块局部，不再借宿 window.ClawFW；
 *   - 仍有 classic 消费方的入口经 kernel-state 桥键（window 访问器）暴露，
 *     且与命名导出同址；
 *   - 动作经 action-dispatcher 注册表分发（唯一 classic 实现：本模块顶层
 *     registerMany）；
 *   - 搜索态跨模块读经显式接口 fwGetFeatureQuery / fwSetFeatureQuery。
 *
 * classic 相走真实装载链（p2-classic-hosts 的 prepareClassicSandbox，顺序同
 * index.html）：bootstrap 状态宿主（含 createP2BootstrapDomHost /
 * createPollCoordinatorHost 等）由真实 app-core / app-main 提供，测试不再手写
 * 宿主契约桩——手写面缺口会让用例在依赖链新增 import 时整片失效。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const FW_PANEL = 'public/src/modules/fw-config-panel.js';

const FW_STATE_KEYS = [
  'mode', 'section', '_projectId', 'projectPickerOpen', 'createDialogOpen',
  'promptEditorOpen', 'confirmDialog', 'featureImport', 'featureQuery',
  'driftDialog', 'fwSlashPicker',
];

const FW_EXPORTS = [
  'fwSwitchSection', 'fwOpenPromptEditor', 'fwOpenProjectPicker', 'fwBackToList',
  'fwCreateNewAgent', 'fwToggleFeature', 'fwSetFeatureFilter', 'fwOpenFeatureImport',
  'fwOpenProjectDetail', 'fwSetFeatureQuery', 'fwCommitFeatureQuery',
  'fwGetFeatureQuery', 'fwRerender', 'renderProjectListBlock',
];

/** 最小 document / fetch：本文件只断言导出面、桥键与动作注册，不驱动渲染。 */
function createDocumentStub() {
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, insertAdjacentHTML() {},
    addEventListener() {}, removeEventListener() {},
    setAttribute() {}, removeAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
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
    querySelectorAll: () => [],
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
  return doc;
}

/**
 * classic 相：整条真实先行脚本链（app-core / app-main / app-ui / sidebar-render
 * 等）——bootstrap 状态宿主（含 createP2BootstrapDomHost / createPollCoordinatorHost）
 * 全部是生产实现，测试不手写宿主契约桩。
 *
 * 仅一处用例侧补面，不属于宿主契约：renderCurrentMainView 计数替身——app-ui 的
 * 首屏全量渲染要装载 index.html 后半程全部 classic 脚本（chat-viewport / 输入区 /
 * 消息渲染…），不在本文件的契约范围（同 p2-w2-10-batch10 的先例）。fw 动作经
 * fwRerender 触达它，用例只需证明显式调用发生、不驱动 DOM 渲染。
 * escapeHtml 不再需要用例补面：它是 markdown-utils 自己的实现与桥键，ESM 图装载
 * 即注册（沙箱在模块相之前由 frontend-vm 的同名桩兜住 classic 相调用）。
 */
function loadClassicBootstrap(sandbox) {
  prepareClassicSandbox(sandbox);
  sandbox.__renderCalls = 0;
  sandbox.renderCurrentMainView = () => { sandbox.__renderCalls += 1; };
}

/** 一个用例 = 一份沙箱 + 一张真实 ESM 图；回调收到沙箱上下文与模块命名空间。 */
function withFwPanel(fn) {
  return withP2EsmCase({
    globals: { document: createDocumentStub(), fetch: async () => ({ ok: true, json: async () => ({}) }) },
    classic: loadClassicBootstrap,
  }, async (c) => fn(c, await c.load(FW_PANEL)));
}

test('fw 借宿状态键从 ClawFW 袋上消失，settingsOpen 保留 / settingsData·settingsEditing 已撤', async () => {
  await withFwPanel((c) => {
    const clawFW = c.window.ClawFW;
    for (const key of FW_STATE_KEYS) {
      assert.equal(clawFW[key], undefined, `ClawFW.${key} 应已收敛为模块局部`);
    }
    // model-settings 域：settingsOpen 仍由 ClawFW 承载（classic app-ui 读写），
    // 初值在此合并初始化；settingsData / settingsEditing 已归模块私有，袋上不再有镜像
    assert.equal(clawFW.settingsOpen, false, 'settingsOpen 仍留 ClawFW（classic 消费）');
    assert.equal('settingsData' in clawFW, false, 'settingsData 已归 model-settings 模块私有，不再镜像');
    assert.equal('settingsEditing' in clawFW, false, 'settingsEditing 已归 model-settings 模块私有，不再镜像');
    // model-preset-cache 的物理状态已模块私有：袋上不再有占位键（无镜像）
    assert.equal('_modelPresets' in clawFW, false, 'ClawFW 袋上不应有 _modelPresets 占位键');
    assert.equal('_modelPresetsRuntimeId' in clawFW, false, 'ClawFW 袋上不应有会话标记键');
  });
});

test('显式导出面可用（app-ui 注册块经 window 转调）', async () => {
  await withFwPanel((c, fw) => {
    for (const name of FW_EXPORTS) {
      assert.equal(typeof c.window[name], 'function', `window.${name} 应为函数导出`);
      // 桥键与命名导出同址：classic 消费方经 window 拿到的就是模块导出本身
      assert.equal(c.window[name], fw[name], `window.${name} 应与命名导出是同一函数`);
    }
  });
});

test('弹窗动作经分发器注册且可调用', async () => {
  await withFwPanel((c) => {
    const actions = c.window.ClawFW.actions;
    // 模块顶层 registerMany 已执行：注册表含 fw.* 动作，重复注册会 throw（装载即验证）
    assert.ok(actions.has('fw.closeProjectPicker'), '弹窗关闭动作应已注册');
    assert.ok(actions.has('fw.confirmFeatureImport'), '导入确认动作应已注册');
    // 内部状态翻转 + fwRerender → 渲染入口（计数替身，见 loadClassicBootstrap 注释）
    assert.equal(c.window.__renderCalls, 0, '未触发动作前无渲染调用');
    actions.invoke('fw.closeProjectPicker');
    assert.equal(c.window.__renderCalls, 1, '关闭动作经 fwRerender 触达渲染入口');
  });
});

test('搜索态跨模块读经显式接口（fwGetFeatureQuery 契约）', async () => {
  await withFwPanel((c) => {
    assert.equal(c.window.fwGetFeatureQuery(), null, '初始搜索态为 null（用户未输入，调用方回退草稿值）');
    // app-ui 注册块的 fw 搜索框动作转调本导出（formId 参数当前实现忽略，值生效即可）
    c.window.fwSetFeatureQuery('assembly-form', 'shell');
    assert.equal(c.window.fwGetFeatureQuery(), 'shell', '写入后显式接口应返回新值');
  });
});
