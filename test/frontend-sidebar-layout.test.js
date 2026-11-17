/**
 * 侧栏布局投影（P4 T2 批次：sidebar-layout 已迁 ESM）。
 *
 * 断言对象是模块的命名导出 `project` / `moved`——布局投影与移动算法的真实入口。
 * classic 相的 `window.ClawSidebarLayout` 桥键仍服务未迁移消费方，由
 * test/frontend-sidebar-layout-bridge.test.js 单独钉住（桥语义不属于本文件）。
 *
 * 装载走 withP2EsmCase：模块求值期要查询 `#agent-list` 并注册桥键，沙箱提供
 * 真实 kernel 与 DOM 桩，与生产装载时相（DOMContentLoaded 前）一致。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const groups = () => ({
  prebuilt: [{ id: 'memo' }, { id: 'qqbot' }],
  tool: [{ id: 'programming-helper' }, { id: 'coder' }],
  workGroup: [],
});
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 每个用例一份独立模块实例：布局状态不跨用例泄漏。 */
async function withLayout(run) {
  await withP2EsmCase({ globals: {} }, async (c) => {
    const layout = await c.load('public/src/modules/sidebar-layout.js');
    await run(layout, c);
  });
}

test('defaults retain default groups and order', async () => {
  await withLayout(({ project }) => {
    const value = project(groups());
    assert.deepEqual(plain(value.folders[0].apps), ['memo', 'qqbot']);
    assert.deepEqual(plain(value.folders[1].apps), ['programming-helper', 'coder']);
  });
});

test('moving within folder, across folders, top level and folders uses stable identities', async () => {
  await withLayout(({ project, moved }) => {
    let value = project(groups());
    value = moved(value, 'app:coder', { folderId: 'tool-group', before: 'app:programming-helper' });
    assert.deepEqual(plain(value.folders[1].apps), ['coder', 'programming-helper']);
    value = moved(value, 'app:coder', { folderId: 'prebuilt-group', before: 'app:qqbot' });
    assert.deepEqual(plain(value.folders[0].apps), ['memo', 'coder', 'qqbot']);
    value = moved(value, 'app:memo', { before: 'folder:prebuilt-group' });
    assert.equal(value.order[0], 'app:memo');
    value = moved(value, 'folder:tool-group', { before: 'app:memo' });
    assert.equal(value.order[0], 'folder:tool-group');
    assert.deepEqual(plain(value.folders[1].apps), ['programming-helper']);
  });
});

test('hidden apps keep their slot; new apps append without restoring host adjacency', async () => {
  await withLayout(({ project, moved }) => {
    let value = project(groups());
    value = moved(value, 'app:coder', { before: 'folder:prebuilt-group' });
    const hidden = { ...groups(), tool: [{ id: 'programming-helper' }, { id: 'new-app' }] };
    const next = project(hidden, value);
    assert.equal(next.order[0], 'app:coder');
    assert.deepEqual(plain(next.folders[1].apps), ['programming-helper', 'new-app']);
    const restored = project(groups(), next);
    assert.equal(restored.order[0], 'app:coder');
    assert.deepEqual(plain(restored.folders[1].apps), ['programming-helper', 'new-app']);
  });
});

test('folder nesting and dropping onto self are no-ops and preserve collapse state', async () => {
  await withLayout(({ project, moved }) => {
    const value = project(groups());
    value.folders[0].collapsed = true;
    assert.deepEqual(plain(moved(value, 'folder:tool-group', { folderId: 'prebuilt-group' })), plain(value));
    assert.deepEqual(plain(moved(value, 'app:memo', { before: 'app:memo' })), plain(value));
    assert.equal(project(groups(), value).folders[0].collapsed, true);
  });
});

test('桥键 ClawSidebarLayout 与命名导出同源（classic 消费方语义不变）', async () => {
  await withLayout((layout, c) => {
    const bridged = c.window.ClawSidebarLayout;
    assert.equal(typeof bridged?.project, 'function', 'classic 侧仍能取到 window.ClawSidebarLayout');
    assert.deepEqual(
      plain(bridged.project(groups())),
      plain(layout.project(groups())),
      '桥键 API 与模块导出必须指向同一实现',
    );
  });
});
