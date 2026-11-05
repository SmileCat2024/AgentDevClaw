import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * 设置面板 tab 切换的回归测试。
 *
 * 历史事故：05ebc2b（auth 功能）删除了 window.switchSettingsTab 的定义，
 * 但渲染出的 tab 按钮 onclick="switchSettingsTab(...)" 未删，导致
 * 「文本模型 / 语音模型」tab 点击即 ReferenceError，切换不过去。
 * 迁移分发器后，按钮经 data-action="modelSettings.switchTab" + data-tab
 * 寻址。本测试锁定：该动作在分发器注册表存在，且经真实点击同款调用
 * 路径（invoke + 元素 dataset）切换生效。
 */
function createSettingsSandbox() {
  const ctx = createFrontendSandbox({
    renderSettingsOverlay: () => {},
    refreshOAuthStatus: () => {},
  });
  ctx.loadSource('public/src/modules/action-dispatcher.js');
  ctx.loadSource('public/src/modules/model-settings.js');
  return ctx;
}

/** 模拟真实 tab 按钮元素（分发器点击时传给 handler 的元素形态） */
function tabButton(tab) {
  return { dataset: { tab } };
}

function invokeTab(ctx, tab) {
  return ctx.run(
    `window.ClawFW.actions.invoke('modelSettings.switchTab', ${JSON.stringify(tabButton(tab))})`,
  );
}

describe('settings tab 切换', () => {
  it('modelSettings.switchTab 动作已注册（tab 按钮的点击路径依赖它存在）', () => {
    const ctx = createSettingsSandbox();
    assert.equal(invokeTab(ctx, 'overview'), true);
  });

  it('切换 tab 更新 ClawFW.settingsTab（renderSettingsOverlay 本地绑定不受注入影响）', () => {
    const ctx = createSettingsSandbox();
    ctx.run('window.ClawFW = window.ClawFW || {}');
    // settingsOpen 未开时 renderSettingsOverlay 只清空 host（沙箱 DOM stub
    // 可安全执行），此处锁定状态切换语义。
    invokeTab(ctx, 'speech');
    assert.equal(ctx.run('window.ClawFW.settingsTab'), 'speech');
    invokeTab(ctx, 'codex');
    assert.equal(ctx.run('window.ClawFW.settingsTab'), 'codex');
  });

  it('非法 tab 回落到 overview', () => {
    const ctx = createSettingsSandbox();
    ctx.run('window.ClawFW = window.ClawFW || {}');
    invokeTab(ctx, 'text');
    assert.equal(ctx.run('window.ClawFW.settingsTab'), 'overview');
  });
});
