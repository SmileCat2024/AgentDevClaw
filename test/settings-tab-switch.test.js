import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * 设置面板 tab 切换的回归测试。
 *
 * 历史事故：05ebc2b（auth 功能）删除了 window.switchSettingsTab 的定义，
 * 但渲染出的 tab 按钮 onclick="switchSettingsTab(...)" 未删，导致
 * 「文本模型 / 语音模型」tab 点击即 ReferenceError，切换不过去。
 * 本测试锁定：设置面板渲染的 onclick 全局函数必须存在且切换生效。
 */
function createSettingsSandbox() {
  const ctx = createFrontendSandbox({
    renderSettingsOverlay: () => {},
  });
  ctx.loadSource('public/src/modules/model-settings.js');
  return ctx;
}

describe('settings tab 切换', () => {
  it('switchSettingsTab 是全局函数（面板 onclick 依赖它存在）', () => {
    const ctx = createSettingsSandbox();
    assert.equal(typeof ctx.run('window.switchSettingsTab'), 'function');
  });

  it('切换 tab 更新 ClawFW.settingsTab（renderSettingsOverlay 本地绑定不受注入影响）', () => {
    const ctx = createSettingsSandbox();
    ctx.run('window.ClawFW = window.ClawFW || {}');
    // settingsOpen 未开时 renderSettingsOverlay 只清空 host（沙箱 DOM stub
    // 可安全执行），此处锁定状态切换语义。
    ctx.run('window.switchSettingsTab("speech")');
    assert.equal(ctx.run('window.ClawFW.settingsTab'), 'speech');
    ctx.run('window.switchSettingsTab("text")');
    assert.equal(ctx.run('window.ClawFW.settingsTab'), 'text');
  });
});
