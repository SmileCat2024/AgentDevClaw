import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function harness() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/sidebar-layout.js');
  return ctx.window.ClawSidebarLayout;
}
const groups = () => ({ prebuilt: [{ id: 'memo' }, { id: 'qqbot' }], tool: [{ id: 'programming-helper' }, { id: 'coder' }], workGroup: [] });
const plain = value => JSON.parse(JSON.stringify(value));

test('defaults retain default groups and order', () => {
  const api = harness();
  const value = api.project(groups());
  assert.deepEqual(plain(value.folders[0].apps), ['memo', 'qqbot']);
  assert.deepEqual(plain(value.folders[1].apps), ['programming-helper', 'coder']);
});

test('moving within folder, across folders, top level and folders uses stable identities', () => {
  const api = harness();
  let value = api.project(groups());
  value = api.moved(value, 'app:coder', { folderId: 'tool-group', before: 'app:programming-helper' });
  assert.deepEqual(plain(value.folders[1].apps), ['coder', 'programming-helper']);
  value = api.moved(value, 'app:coder', { folderId: 'prebuilt-group', before: 'app:qqbot' });
  assert.deepEqual(plain(value.folders[0].apps), ['memo', 'coder', 'qqbot']);
  value = api.moved(value, 'app:memo', { before: 'folder:prebuilt-group' });
  assert.equal(value.order[0], 'app:memo');
  value = api.moved(value, 'folder:tool-group', { before: 'app:memo' });
  assert.equal(value.order[0], 'folder:tool-group');
  assert.deepEqual(plain(value.folders[1].apps), ['programming-helper']);
});

test('hidden apps keep their slot; new apps append without restoring host adjacency', () => {
  const api = harness();
  let value = api.project(groups());
  value = api.moved(value, 'app:coder', { before: 'folder:prebuilt-group' });
  const hidden = { ...groups(), tool: [{ id: 'programming-helper' }, { id: 'new-app' }] };
  const next = api.project(hidden, value);
  assert.equal(next.order[0], 'app:coder');
  assert.deepEqual(plain(next.folders[1].apps), ['programming-helper', 'new-app']);
  const restored = api.project(groups(), next);
  assert.equal(restored.order[0], 'app:coder');
  assert.deepEqual(plain(restored.folders[1].apps), ['programming-helper', 'new-app']);
});

test('folder nesting and dropping onto self are no-ops and preserve collapse state', () => {
  const api = harness();
  const value = api.project(groups());
  value.folders[0].collapsed = true;
  assert.deepEqual(plain(api.moved(value, 'folder:tool-group', { folderId: 'prebuilt-group' })), plain(value));
  assert.deepEqual(plain(api.moved(value, 'app:memo', { before: 'app:memo' })), plain(value));
  assert.equal(api.project(groups(), value).folders[0].collapsed, true);
});
