// 侧栏分组：hosted APP（ADR-0025）跟随宿主分组——coder 紧随智能编码空间，
// 同在「工具与效率」组；「紧随宿主」的相邻排序必须落在同一分组内。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const source = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

function loadGrouping(ctx) {
  ctx.run(sourceBetween(source, 'function isPrebuiltAppVisible(agent)', 'function isRuntimeItemActive'));
  // VM 跨 context 数组原型不等，经 JSON 过界比较
  return (agents) => JSON.parse(ctx.run(
    `JSON.stringify(groupConnectedAgents(${JSON.stringify(agents)}), (k, v) => k === '' ? { tool: v.tool.map(a=>a.id), workGroup: v.workGroup.map(a=>a.id), prebuilt: v.prebuilt.map(a=>a.id) } : v)`,
  ));
}

const ph = { id: 'programming-helper', name: '智能编码空间', source: 'prebuilt' };
const coder = { id: 'coder', name: 'Coder', source: 'prebuilt', host: 'programming-helper', visibility: 'on-demand', sidebarVisible: true };
const studio = { id: 'agent-studio', name: 'Agent Studio', source: 'prebuilt' };

test('coder 跟随宿主进工具与效率组，且紧随智能编码空间之后', () => {
  const ctx = createFrontendSandbox();
  const group = loadGrouping(ctx);
  const result = group([coder, studio, ph]);
  assert.deepEqual(result.tool, ['programming-helper', 'coder'],
    'coder 在 tool 组内紧随宿主（平行下方）');
  assert.ok(!result.prebuilt.includes('coder'), 'coder 不再落回默认组');
});

test('宿主缺席（不可见）时 hosted APP 保持原组序，不猜测宿主分组', () => {
  const ctx = createFrontendSandbox();
  const group = loadGrouping(ctx);
  // ph 缺席（例如被隐藏）：coder 的 host 解析失败 → 默认组
  const result = group([coder, studio]);
  assert.deepEqual(result.tool, []);
  assert.deepEqual(result.prebuilt, ['coder', 'agent-studio']);
});

test('host 链成环不得死循环（防御）', () => {
  const ctx = createFrontendSandbox();
  const group = loadGrouping(ctx);
  const a = { id: 'app-a', source: 'prebuilt', host: 'app-b' };
  const b = { id: 'app-b', source: 'prebuilt', host: 'app-a' };
  const result = group([a, b]);
  assert.deepEqual([...result.prebuilt].sort(), ['app-a', 'app-b']);
});
