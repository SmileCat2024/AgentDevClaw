// isPrebuiltAppVisible（ADR-0025 收尾后语义）：前端纯消费服务端合流的
// sidebarVisible，本地无任何判定/粘性记忆。persistent 恒显示。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createFrontendSandbox, sourceBetween } from './helpers/frontend-vm.js';

const source = fs.readFileSync(new URL('../public/src/app-main.js', import.meta.url), 'utf8');

function loadVisibilityFn(ctx) {
  ctx.run(sourceBetween(source, 'function isPrebuiltAppVisible(agent)', 'function orderPrebuiltByHost'));
  return (agent) => ctx.run(`isPrebuiltAppVisible(${JSON.stringify(agent)})`);
}

test('on-demand：只认服务端合流的 sidebarVisible，本地无粘性记忆', () => {
  const ctx = createFrontendSandbox();
  const visible = loadVisibilityFn(ctx);
  assert.equal(visible({ id: 'coder', visibility: 'on-demand', sidebarVisible: true }), true);
  assert.equal(visible({ id: 'coder', visibility: 'on-demand', sidebarVisible: false }), false);
  // wire 字段缺席（旧服务端/异常帧）不得误显
  assert.equal(visible({ id: 'coder', visibility: 'on-demand' }), false);
  // 不落 localStorage：重复查询同一 agent 不产生记忆副作用
  assert.equal(ctx.localStorage.getItem('claw:onDemandAppsSeen'), null);
});

test('persistent 工作空间恒显示（不依赖 sidebarVisible）', () => {
  const ctx = createFrontendSandbox();
  const visible = loadVisibilityFn(ctx);
  assert.equal(visible({ id: 'programming-helper' }), true);
  assert.equal(visible({ id: 'programming-helper', visibility: 'persistent' }), true);
});
