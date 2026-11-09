/**
 * feature-ui-prefs 测试 — 呈现配置与面板偏好的服务端持久化（ADR-0046 决策 3）
 *
 * 覆盖：
 * 1. sanitize* — sparse 形态校验（非法 panelId / 非法字段剔除，值原样保留）
 * 2. readUiPrefs — 文件缺失 / 损坏降级、正常读取（root 注入隔离）
 * 3. 路由 — GET / PUT presentation / PUT panel-prefs 的行为与错误码
 *    （makeHttpApp + 内存 Map IO 注入，不触碰真实用户数据目录）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import {
  sanitizePresentation,
  sanitizePanelPrefs,
  readUiPrefs,
  setupFeatureUiPrefsRoutes,
} from '../server/routes/feature-ui-prefs.js';

// ── 路由测试设施（真实 Express + 随机端口；IO 注入内存 Map） ────────

function makeHttpApp() {
  const app = express();
  const store = new Map(); // agentId -> prefs 对象（测试隔离的"文件系统"）
  setupFeatureUiPrefsRoutes(app, express, {
    readFile: (agentId) => store.get(agentId) || { presentation: {}, panelPrefs: {} },
    writeFile: (agentId, prefs) => { store.set(agentId, JSON.parse(JSON.stringify(prefs))); },
  });
  const server = http.createServer(app);
  return {
    app,
    store,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// （身份校验为路径安全语义，无注册表依赖，无需身份预注册）

// ── sanitize ──────────────────────────────────────────────────────

describe('sanitizePresentation', () => {
  it('保留合法形态（visible 布尔 + order 有限数），剔除未知字段', () => {
    const clean = sanitizePresentation({
      'panel-a': { visible: false, order: 2, rogue: 'x' },
      'panel-b': { visible: true },
      'panel-c': { order: 0 },
    });
    assert.deepEqual(clean, {
      'panel-a': { visible: false, order: 2 },
      'panel-b': { visible: true },
      'panel-c': { order: 0 },
    });
  });

  it('剔除非法条目：空/含分隔符 panelId、非对象项、全空字段', () => {
    const clean = sanitizePresentation({
      '': { visible: false },
      'a/b': { visible: false },
      'ok-panel': 'not-an-object',
      'hollow': { visible: 'yes', order: '3' },
    });
    assert.deepEqual(clean, {});
  });

  it('非对象输入返回空对象', () => {
    assert.deepEqual(sanitizePresentation(null), {});
    assert.deepEqual(sanitizePresentation([]), {});
    assert.deepEqual(sanitizePresentation('x'), {});
  });
});

describe('sanitizePanelPrefs', () => {
  it('键原样保留任意 JSON 值（含嵌套对象与 null）', () => {
    const clean = sanitizePanelPrefs({
      'panel-a': { pageSize: 20, view: { mode: 'grid' }, note: null },
    });
    assert.deepEqual(clean, { 'panel-a': { pageSize: 20, view: { mode: 'grid' }, note: null } });
  });

  it('剔除非法 panelId 与非法键', () => {
    const clean = sanitizePanelPrefs({
      '': { a: 1 },
      'p/q': { a: 1 },
      'panel-a': { '': 1, 'k/l': 2, ok: 3 },
    });
    assert.deepEqual(clean, { 'panel-a': { ok: 3 } });
  });
});

// ── readUiPrefs（真实文件路径经 root 注入隔离） ────────────────────

describe('readUiPrefs', () => {
  it('文件缺失返回空形态；正常文件读取后 sanitize', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const root = mkdtempSync(join(tmpdir(), 'ui-prefs-test-'));
    try {
      assert.deepEqual(readUiPrefs('nobody', { root }), { presentation: {}, panelPrefs: {} });
      const dir = join(root, 'workspaces', 'nobody', 'feature-config');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ui-prefs.json'), JSON.stringify({
        presentation: { p: { visible: false, order: 1 } },
        panelPrefs: { p: { pageSize: 10 } },
      }));
      assert.deepEqual(readUiPrefs('nobody', { root }), {
        presentation: { p: { visible: false, order: 1 } },
        panelPrefs: { p: { pageSize: 10 } },
      });
    } finally {
      const { rmSync } = await import('fs');
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('损坏 JSON 降级为空形态（偏好数据不阻塞渲染）', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const root = mkdtempSync(join(tmpdir(), 'ui-prefs-test-'));
    try {
      const dir = join(root, 'workspaces', 'broken', 'feature-config');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ui-prefs.json'), '{not-json');
      assert.deepEqual(readUiPrefs('broken', { root }), { presentation: {}, panelPrefs: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── 路由（真实 HTTP） ─────────────────────────────────────────────

describe('feature-ui-prefs routes', () => {
  it('GET 返回该空间的 prefs；任意可聚焦工作空间身份可用，危险字符 400', async () => {
    const httpApp = makeHttpApp();
    try {
      const port = await httpApp.listen();

      const okRes = await fetch(`http://127.0.0.1:${port}/api/feature-ui/ui-prefs?agentId=home`);
      assert.equal(okRes.status, 200);
      assert.deepEqual((await okRes.json()).prefs, { presentation: {}, panelPrefs: {} });

      const badRes = await fetch(`http://127.0.0.1:${port}/api/feature-ui/ui-prefs?agentId=../evil`);
      assert.equal(badRes.status, 400);
      const badRes2 = await fetch(`http://127.0.0.1:${port}/api/feature-ui/ui-prefs?agentId=a%2Fb`);
      assert.equal(badRes2.status, 400);
    } finally {
      await httpApp.close();
    }
  });

  it('PUT presentation 整块覆写且 sanitize 生效；GET 读回同值', async () => {
    const httpApp = makeHttpApp();
    try {
      const port = await httpApp.listen();
      const putRes = await fetch(`http://127.0.0.1:${port}/api/feature-ui/ui-prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'ui-prefs-test',
          presentation: { 'panel-a': { visible: false, order: 1, junk: 1 }, 'bad/id': { visible: false } },
        }),
      });
      assert.equal(putRes.status, 200);
      assert.deepEqual((await putRes.json()).presentation, { 'panel-a': { visible: false, order: 1 } });

      const getRes = await fetch(`http://127.0.0.1:${port}/api/feature-ui/ui-prefs?agentId=ui-prefs-test`);
      assert.deepEqual((await getRes.json()).prefs.presentation, { 'panel-a': { visible: false, order: 1 } });
    } finally {
      await httpApp.close();
    }
  });

  it('PUT presentation 覆写保留同文件的面板偏好（两份数据互不覆盖）', async () => {
    const httpApp = makeHttpApp();
    try {
      const port = await httpApp.listen();
      await fetch(`http://127.0.0.1:${port}/api/feature-ui/panel-prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'ui-prefs-test', panelId: 'panel-a', prefs: { pageSize: 30 } }),
      });
      await fetch(`http://127.0.0.1:${port}/api/feature-ui/ui-prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'ui-prefs-test', presentation: { 'panel-a': { visible: false } } }),
      });
      const prefs = (await (await fetch(`http://127.0.0.1:${port}/api/feature-ui/ui-prefs?agentId=ui-prefs-test`)).json()).prefs;
      assert.deepEqual(prefs, {
        presentation: { 'panel-a': { visible: false } },
        panelPrefs: { 'panel-a': { pageSize: 30 } },
      });
    } finally {
      await httpApp.close();
    }
  });

  it('PUT panel-prefs 按 panelId 覆写；空 prefs 删除该条目；非法 panelId 400', async () => {
    const httpApp = makeHttpApp();
    try {
      const port = await httpApp.listen();
      await fetch(`http://127.0.0.1:${port}/api/feature-ui/panel-prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'ui-prefs-test', panelId: 'panel-a', prefs: { pageSize: 30, junk: undefined } }),
      });

      const badRes = await fetch(`http://127.0.0.1:${port}/api/feature-ui/panel-prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'ui-prefs-test', panelId: 'a/b', prefs: { x: 1 } }),
      });
      assert.equal(badRes.status, 400);

      // 空对象 = 清空该面板偏好
      await fetch(`http://127.0.0.1:${port}/api/feature-ui/panel-prefs`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'ui-prefs-test', panelId: 'panel-a', prefs: {} }),
      });
      const prefs = (await (await fetch(`http://127.0.0.1:${port}/api/feature-ui/ui-prefs?agentId=ui-prefs-test`)).json()).prefs;
      assert.deepEqual(prefs.panelPrefs, {});
    } finally {
      await httpApp.close();
    }
  });
});
