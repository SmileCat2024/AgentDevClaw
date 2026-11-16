/**
 * 通用 ESM 模块装载器契约（helpers/esm-module-loader.js，前端 ESM 迁移 P0.4）。
 *
 * 用真实仓库 ESM 模块（public/src/plugins/memo/*.js）驱动真实动态 import：
 *   - 装载成功并拿到 default 与命名导出；
 *   - 唯一 query：两次装载是独立实例，模块级状态（reminders 的 pluginHost）
 *     不共享；
 *   - cleanup 恢复调用前的全局（含「原本无 window / document」与「已有」）；
 *   - window / document 桩可覆盖 / 新增 / 删除，装载后的模块读到定制后的桩。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const NOTES = 'public/src/plugins/memo/notes.js';
const REMINDERS = 'public/src/plugins/memo/reminders.js';
const SETTINGS = 'public/src/plugins/memo/settings.js';

test('loadModuleOnce: 真实 import 拿到 default 与命名导出', async () => {
  const { module, cleanup } = await loadModuleOnce(NOTES);
  try {
    assert.equal(module.default.id, 'memo');
    assert.equal(typeof module.default.mount, 'function');
    assert.equal(typeof module.MemoNotesUI.render, 'function');
  } finally { cleanup(); }
});

test('loadModuleOnce: 两次装载是独立实例，模块级状态不共享', async () => {
  // reminders.fmtRelativeBadge 经模块级 pluginHost 读语言：两实例各 mount
  // 不同语言的注入面，后 mount 不得覆盖前者的 pluginHost——若唯一 query
  // 失效（两 load 拿到同一模块实例），en 侧会开始产出中文文案。
  const en = await loadModuleOnce(REMINDERS);
  const zh = await loadModuleOnce(REMINDERS);
  try {
    assert.notEqual(en.module, zh.module, '唯一 query 必须绕开模块缓存');
    en.module.default.mount({ getLanguage: () => 'en' });
    zh.module.default.mount({ getLanguage: () => 'zh' });
    const fireAt = '2020-01-01T00:00:00Z';
    const now = new Date('2026-06-15T12:00:00Z').getTime();
    const enText = en.module.MemoRemindersUI.fmtRelativeBadge({ fire_at: fireAt }, now).text;
    const zhText = zh.module.MemoRemindersUI.fmtRelativeBadge({ fire_at: fireAt }, now).text;
    assert.match(enText, /overdue/);
    assert.doesNotMatch(enText, /已过期/);
    assert.match(zhText, /已过期/);
  } finally {
    // cleanup 按「后装先拆」（LIFO）调用：每个 cleanup 恢复它安装时捕获的前值
    zh.cleanup();
    en.cleanup();
  }
});

test('installBrowserStubs: cleanup 恢复「原本无 window / document」', () => {
  // 前置：本文件各用例都在 finally 里清理桩，此时全局应无 window
  assert.equal(globalThis.window, undefined);
  assert.equal(globalThis.document, undefined);
  const cleanup = installBrowserStubs();
  try {
    assert.notEqual(globalThis.window, undefined);
    assert.notEqual(globalThis.document, undefined);
  } finally { cleanup(); }
  assert.equal(globalThis.window, undefined);
  assert.equal(globalThis.document, undefined);
});

test('installBrowserStubs: cleanup 恢复调用前已有的全局', () => {
  const sentinelWindow = { mark: 'sentinel-window' };
  const sentinelDocument = { mark: 'sentinel-document' };
  globalThis.window = sentinelWindow;
  globalThis.document = sentinelDocument;
  const cleanup = installBrowserStubs();
  try {
    assert.notEqual(globalThis.window, sentinelWindow);
    assert.notEqual(globalThis.document, sentinelDocument);
  } finally { cleanup(); }
  assert.equal(globalThis.window, sentinelWindow);
  assert.equal(globalThis.document, sentinelDocument);
  // 摘掉本用例自设的哨兵，恢复文件级约定（用例结束时全局无 window / document）
  delete globalThis.window;
  delete globalThis.document;
});

test('桩定制：覆盖 / 新增 / 删除 window 与 document 属性，模块读到定制后的桩', async () => {
  const customToast = { show() {} };
  const bodySentinel = { mark: 'custom-body' };
  const { module, cleanup } = await loadModuleOnce(SETTINGS, {
    window: {
      ClawToast: customToast,           // 覆盖基础桩同名键
      __testMarker: 'added',            // 新增
      requestAnimationFrame: undefined, // 删除基础桩键（模拟能力缺席）
    },
    document: { body: bodySentinel },
  });
  try {
    assert.equal(globalThis.window.ClawToast, customToast);
    assert.equal(globalThis.window.__testMarker, 'added');
    assert.ok(!('requestAnimationFrame' in globalThis.window));
    assert.equal(globalThis.document.body, bodySentinel);
    // 装载后的模块对定制桩做真实读写：settings.mount 写 window.ClawFW 注册表，
    // unmount 摘除
    module.default.mount({ getLanguage: () => 'zh' });
    assert.equal(typeof globalThis.window.ClawFW.appSettingsPanels.memo.open, 'function');
    module.default.unmount();
    assert.ok(!globalThis.window.ClawFW?.appSettingsPanels?.memo);
  } finally { cleanup(); }
});

test('loadModuleOnce installGlobals:false：调用方自装桩不被覆盖，cleanup 不动全局', async () => {
  const marker = { caller: true };
  const cleanupGlobals = installBrowserStubs({ window: { __callerInstalled: marker } });
  const { module, cleanup } = await loadModuleOnce(REMINDERS, { installGlobals: false });
  try {
    assert.equal(globalThis.window.__callerInstalled, marker);
    cleanup(); // 无操作，不得摘掉调用方的桩
    assert.equal(globalThis.window.__callerInstalled, marker);
    assert.equal(typeof module.MemoRemindersUI.render, 'function');
  } finally {
    cleanup();
    cleanupGlobals();
    // 摘掉本用例经 cleanupGlobals 恢复出来的哨兵，恢复文件级约定
    delete globalThis.window;
    delete globalThis.document;
  }
});

test('loadModuleOnce: 拒绝解析后越出仓库根的路径，且不泄漏桩', async () => {
  await assert.rejects(() => loadModuleOnce('../../outside-repo/evil.js'), /越出仓库根/);
  assert.equal(globalThis.window, undefined);
  assert.equal(globalThis.document, undefined);
});

test('loadModuleOnce: import 失败时自动恢复全局再抛出', async () => {
  await assert.rejects(() => loadModuleOnce('public/src/does-not-exist.js'));
  assert.equal(globalThis.window, undefined);
  assert.equal(globalThis.document, undefined);
});
