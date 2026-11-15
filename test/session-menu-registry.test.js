/**
 * session-menu-registry（ADR-0049 服务端校验归一）的契约：
 *   - 合法声明归一为规范形状（裁剪未知字段、去重谓词）随记录下发
 *   - 非法项丢弃并告警，不抛错——坏声明不得阻塞 APP 发现
 *     （与 permissions 抛错语义的分别见 ADR-0049）
 *   - 无有效项时不保留空壳（sessionMenu === null）
 *
 * discoverAgents 集成段复用 agent-discovery-permissions.test.js 的临时根
 * 扫描模式（discoverAgents 递归解析所有 metadata.json）。
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normalizeSessionMenu, SESSION_MENU_PREDICATES } from '../server/shared/session-menu-registry.js';
import { createAgentDiscoveryModule } from '../server/routes/agent-discovery.js';

function captureWarns(fn) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = origWarn;
  }
}

describe('normalizeSessionMenu: 归一与丢弃', () => {
  it('合法项归一为规范形状：未知字段裁剪、谓词去重、danger 缺省省略', () => {
    const { result } = captureWarns(() => normalizeSessionMenu({
      items: [{
        id: 'ph.move',
        label: { zh: '移动到…', en: 'Move to…', fr: 'ignoré' },
        action: 'claw:move-session',
        when: ['not-archived', 'not-archived'],
        icon: 'should-be-pruned',
      }],
    }, 'app-x'));
    assert.deepEqual(result, {
      items: [{
        id: 'ph.move',
        label: { zh: '移动到…', en: 'Move to…' },
        action: 'claw:move-session',
        when: ['not-archived'],
      }],
    });
  });

  it('plugin: 前缀动作合法（claw: 与 plugin: 两类绑定）', () => {
    const { result } = captureWarns(() => normalizeSessionMenu({
      items: [{ id: 'm.note', label: { zh: '便签' }, action: 'plugin:memo.openNote', danger: true }],
    }, 'memo'));
    assert.deepEqual(result.items[0].action, 'plugin:memo.openNote');
    assert.equal(result.items[0].danger, true);
  });

  it('undefined / null / 无 items → null（不告警）', () => {
    for (const value of [undefined, null, {}, { items: undefined }, { items: null }]) {
      const { result, warnings } = captureWarns(() => normalizeSessionMenu(value, 'app-x'));
      assert.equal(result, null);
      assert.equal(warnings.length, 0);
    }
  });

  it('非法容器形状 → null 加告警', () => {
    for (const value of ['x', [], { items: 'x' }]) {
      const { result, warnings } = captureWarns(() => normalizeSessionMenu(value, 'app-x'));
      assert.equal(result, null);
      assert.equal(warnings.length, 1);
    }
  });

  it('非法项逐条丢弃加告警：id 形状、重复 id、action 前缀、label 缺失、未知谓词、danger 类型', () => {
    const { result, warnings } = captureWarns(() => normalizeSessionMenu({
      items: [
        { id: 'Bad_ID', label: { zh: '大写' }, action: 'claw:x' },
        { id: 'dup', label: { zh: '一' }, action: 'claw:x' },
        { id: 'dup', label: { zh: '二' }, action: 'claw:x' },
        { id: 'no-prefix', label: { zh: '无前缀' }, action: 'move-session' },
        { id: 'weird:prefix', label: { zh: '怪前缀' }, action: 'shell:rm-rf' },
        { id: 'no-label', action: 'claw:x' },
        { id: 'bad-when', label: { zh: '坏谓词' }, action: 'claw:x', when: ['is-cool'] },
        { id: 'bad-danger', label: { zh: '坏危险' }, action: 'claw:x', danger: 'yes' },
        { id: 'ok', label: { zh: '好' }, action: 'claw:x', when: ['has-thread', 'thread-busy'] },
      ],
    }, 'app-x'));
    // 首 dup 合法保留（后值丢弃），ok 保留：共 2 项；其余 7 项各丢弃一条告警。
    assert.deepEqual(result, {
      items: [
        { id: 'dup', label: { zh: '一' }, action: 'claw:x' },
        { id: 'ok', label: { zh: '好' }, action: 'claw:x', when: ['has-thread', 'thread-busy'] },
      ],
    });
    assert.equal(warnings.length, 7, '每个被丢弃的项恰好一条告警');
  });

  it('全部项非法 → null（记录上不保留空壳）', () => {
    const { result, warnings } = captureWarns(() => normalizeSessionMenu({
      items: [{ id: 'x', label: { zh: '无动作' } }],
    }, 'app-x'));
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
  });

  it('谓词词表是公开契约：当前为三个宿主谓词', () => {
    assert.deepEqual([...SESSION_MENU_PREDICATES], ['not-archived', 'has-thread', 'thread-busy']);
  });
});

const ROOT = mkdtempSync(path.join(tmpdir(), 'claw-discovery-menu-test-'));
const mod = createAgentDiscoveryModule({ sessionApi: {} });

async function writeAgent(caseName, agentName, metadata) {
  const dir = path.join(ROOT, caseName, agentName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata), 'utf8');
  return path.join(ROOT, caseName);
}

after(async () => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('discoverAgents: sessionMenu 声明随记录下发', () => {
  it('合法声明归一后挂在 agent 记录 ui.sessionMenu', async () => {
    const root = await writeAgent('ok', 'menu-agent', {
      id: 'menu-agent',
      sessionOps: true,
      ui: {
        sessionMenu: { items: [{ id: 'a.move', label: { zh: '移动到…', en: 'Move to…' }, action: 'claw:move-session' }] },
      },
    });
    const agents = await mod.discoverAgents(root);
    const agent = agents.find((a) => a.id === 'menu-agent');
    assert.ok(agent);
    assert.equal(agent.sessionOps, true, 'sessionOps 事实随 metadata 展开下发');
    assert.deepEqual(agent.ui.sessionMenu, {
      items: [{ id: 'a.move', label: { zh: '移动到…', en: 'Move to…' }, action: 'claw:move-session' }],
    });
  });

  it('非法声明不阻塞发现：项被丢弃，sessionMenu 覆写为 null（坏声明不得原样下发）', async () => {
    const root = await writeAgent('bad', 'bad-menu-agent', {
      id: 'bad-menu-agent',
      ui: { sessionMenu: { items: [{ id: 'bad', label: { zh: '坏' }, action: 'nope' }] } },
    });
    // discoverAgents 异步扫描：告警在 promise 内发生，捕获窗口必须覆盖 await。
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    let agents;
    try {
      agents = await mod.discoverAgents(root);
    } finally {
      console.warn = origWarn;
    }
    const agent = agents.find((a) => a.id === 'bad-menu-agent');
    assert.ok(agent, '坏声明不得阻塞 APP 发现');
    assert.equal(agent.ui.sessionMenu, null);
    assert.ok(warnings.some((w) => w.includes('bad-menu-agent') && w.includes('action')), '扫描必须告警定位到 APP 与项');
  });

  it('无 sessionMenu 声明的 APP：ui 原样，无 sessionMenu 键污染', async () => {
    const root = await writeAgent('bare', 'bare-agent', { id: 'bare-agent', ui: { entry: 'home' } });
    const agents = await mod.discoverAgents(root);
    const agent = agents.find((a) => a.id === 'bare-agent');
    assert.deepEqual(agent.ui, { entry: 'home' });
  });
});
