import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  readSidebarLayout, writeSidebarLayout, writeWorkspaceVisibilityOverride,
  writeWorkspacePermissionValue, setupWorkspaceSettingsRoutes,
} from '../server/routes/workspace-settings.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-sidebar-layout-'));
after(() => fs.rm(root, { recursive: true, force: true }));
const layout = () => ({
  version: 1,
  order: ['app:memo', 'folder:tool-group', 'folder:prebuilt-group'],
  folders: [
    { id: 'prebuilt-group', apps: ['qqbot', 'hidden-app'], collapsed: true },
    { id: 'tool-group', apps: ['coder', 'programming-helper'], collapsed: false },
  ],
  externalCollapsed: true,
});

test('sidebar layout persists top-level order, hidden positions and collapse across module reload', async () => {
  const settingsPath = path.join(root, 'persist.json');
  assert.equal(await readSidebarLayout({ settingsPath }), null);
  await writeSidebarLayout(layout(), { settingsPath });
  const fresh = await import('../server/routes/workspace-settings.js?sidebar-restart');
  assert.deepEqual(await fresh.readSidebarLayout({ settingsPath }), layout());
});

test('upgrade without a settings file or sidebarLayout loads defaults and creates layout on first save', async () => {
  for (const existing of [null, { version: 1, workspaceVisibility: { coder: 'always' }, resourcePolicy: { coder: { maxLiveThreads: 3 } } }]) {
    const settingsPath = path.join(root, existing ? 'upgrade-existing.json' : 'upgrade-new', 'workspace-settings.json');
    if (existing) {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, JSON.stringify(existing));
    }
    assert.equal(await readSidebarLayout({ settingsPath }), null);
    if (existing) assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), existing);
    else await assert.rejects(fs.access(settingsPath), { code: 'ENOENT' });
    await writeSidebarLayout(layout(), { settingsPath });
    assert.deepEqual(await readSidebarLayout({ settingsPath }), layout());
    assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), {
      ...(existing || {}), version: 1, sidebarLayout: layout(),
    });
  }
});

test('stored retired folder unwraps apps in place and subsequent saves contain only active folders', async () => {
  const settingsPath = path.join(root, 'retired-folder.json');
  const old = layout();
  old.order.splice(1, 0, 'folder:work-group-group');
  old.folders.push({ id: 'work-group-group', apps: ['moved-app', 'hidden-moved-app'], collapsed: true });
  await fs.writeFile(settingsPath, JSON.stringify({ sidebarLayout: old, unrelated: true }));
  const expected = layout();
  expected.order.splice(1, 0, 'app:moved-app', 'app:hidden-moved-app');
  assert.deepEqual(await readSidebarLayout({ settingsPath }), expected);
  await assert.rejects(writeSidebarLayout(old, { settingsPath }), error => error.status === 400);
  await writeSidebarLayout(expected, { settingsPath });
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, 'utf8')), { sidebarLayout: expected, unrelated: true, version: 1 });
});

test('concurrent layout, visibility and permission writes preserve all sibling settings', async () => {
  const settingsPath = path.join(root, 'concurrent.json');
  await fs.writeFile(settingsPath, JSON.stringify({ unrelated: { keep: true } }));
  await Promise.all([
    writeSidebarLayout(layout(), { settingsPath }),
    writeWorkspaceVisibilityOverride('coder', 'always', { settingsPath }),
    writeWorkspacePermissionValue('coder', 'maxLiveThreads', 4, { settingsPath }),
  ]);
  const data = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
  assert.deepEqual(data.sidebarLayout, layout());
  assert.deepEqual(data.workspaceVisibility, { coder: 'always' });
  assert.deepEqual(data.resourcePolicy, { coder: { maxLiveThreads: 4 } });
  assert.deepEqual(data.unrelated, { keep: true });
});

test('invalid layouts are rejected without replacing the saved layout', async () => {
  const settingsPath = path.join(root, 'invalid.json');
  await writeSidebarLayout(layout(), { settingsPath });
  const mutations = [
    value => { value.version = 2; },
    value => { value.order.push('folder:tool-group'); },
    value => { value.order.pop(); },
    value => { value.order.push('folder:unknown'); },
    value => { value.folders[0].apps.push('memo'); },
    value => { value.folders[0].apps.push('bad id'); },
    value => { value.folders[0].collapsed = 'yes'; },
    value => { value.folders[1].id = 'prebuilt-group'; },
    value => { delete value.externalCollapsed; },
  ];
  for (const mutate of mutations) {
    const candidate = layout();
    mutate(candidate);
    await assert.rejects(writeSidebarLayout(candidate, { settingsPath }), error => error.status === 400);
  }
  assert.deepEqual(await readSidebarLayout({ settingsPath }), layout());
});

test('HTTP route round trip uses injected data root and validates request body', async () => {
  const settingsPath = path.join(root, 'http.json');
  const app = express();
  setupWorkspaceSettingsRoutes(app, express, { settingsPath });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/protoclaw/workspace_settings/sidebar_layout`;
  try {
    const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sidebarLayout: layout() }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, sidebarLayout: layout() });
    assert.deepEqual(await (await fetch(url)).json(), { ok: true, sidebarLayout: layout() });
    const bad = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
