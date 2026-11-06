import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

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

function loadModule() {
  const ctx = createFrontendSandbox({
    // fwRerender 裸读写 app-ui.js 的顶层 let（生产全局词法环境可见，沙箱需注入）
    currentWorkspaceTab: 'chat',
  });
  // 生产加载顺序：action-dispatcher（index.html 第 81 位）先于全部模块
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  ctx.loadSource('public/src/modules/fw-config-panel.js');
  return ctx;
}

test('fw 借宿状态键从 ClawFW 袋上消失，其他模块借宿键保留', () => {
  const ctx = loadModule();
  const clawFW = ctx.window.ClawFW;
  for (const key of FW_STATE_KEYS) {
    assert.equal(clawFW[key], undefined, `ClawFW.${key} 应已收敛为模块局部`);
  }
  // model-settings / model-preset-cache 域的借宿键仍在（初始化保留在此维持加载顺序兼容）
  assert.equal(clawFW.settingsOpen, false, 'settingsOpen 是 model-settings 域借宿键，应保留');
  assert.equal(clawFW._modelPresets, null, '_modelPresets 是 model-preset-cache 域借宿键，应保留');
});

test('显式导出面可用（app-ui 注册块经 window 转调）', () => {
  const ctx = loadModule();
  for (const name of FW_EXPORTS) {
    assert.equal(typeof ctx.window[name], 'function', `window.${name} 应为函数导出`);
  }
});

test('弹窗动作经分发器注册且可调用', () => {
  const ctx = loadModule();
  const actions = ctx.window.ClawFW.actions;
  // 模块顶层 registerMany 已执行：注册表含 fw.* 动作，重复注册会 throw（装载即验证）
  assert.ok(actions.has('fw.closeProjectPicker'), '弹窗关闭动作应已注册');
  assert.ok(actions.has('fw.confirmFeatureImport'), '导入确认动作应已注册');
  actions.invoke('fw.closeProjectPicker'); // 内部状态翻转 + fwRerender（typeof 守卫下安全）
  assert.ok(true, '关闭动作调用无异常');
});

test('搜索态跨模块读经显式接口（fwGetFeatureQuery 契约）', () => {
  const ctx = loadModule();
  assert.equal(ctx.window.fwGetFeatureQuery(), null, '初始搜索态为 null（用户未输入，调用方回退草稿值）');
  // app-ui 注册块的 fw 搜索框动作转调本导出（formId 参数当前实现忽略，值生效即可）
  ctx.window.fwSetFeatureQuery('assembly-form', 'shell');
  assert.equal(ctx.window.fwGetFeatureQuery(), 'shell', '写入后显式接口应返回新值');
});
