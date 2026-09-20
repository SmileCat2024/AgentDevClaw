/**
 * 前端加载链模拟：按 index.html 真实顺序在 vm 沙箱加载 app-core → sse-client，
 * 验证 P2 顶层执行在真实脚本序列下无未定义引用（EventSource mock 驱动到 hello）。
 * app-main.js 顶层 DOM 依赖过重，不在本层模拟（由静态脚本序 + 单模块测试覆盖）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SCRIPT_SRCS = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

class MockEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.onerror = null;
    MockEventSource.instances.push(this);
  }
  addEventListener(kind, fn) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, []);
    this.listeners.get(kind).push(fn);
  }
  close() { this.readyState = 2; }
  emit(kind, data) {
    this.readyState = 1;
    for (const fn of this.listeners.get(kind) || []) fn({ data: JSON.stringify(data) });
  }
}

describe('前端加载链（index.html 真实脚本序，P2 子集）', () => {
  it('app-core 先于 sse-client；sse-client 顶层执行不依赖 app-main 全局', () => {
    const coreIdx = SCRIPT_SRCS.indexOf('./src/app-core.js');
    const sseIdx = SCRIPT_SRCS.indexOf('./src/modules/sse-client.js');
    const mainIdx = SCRIPT_SRCS.indexOf('./src/app-main.js');
    assert.ok(coreIdx !== -1 && coreIdx < sseIdx && sseIdx < mainIdx,
      `脚本序: core=${coreIdx} sse=${sseIdx} main=${mainIdx}`);
  });

  it('app-core → sse-client 沙箱加载 + boot + hello 激活（顶层无未定义引用）', () => {
    const ctx = createFrontendSandbox({
      EventSource: MockEventSource,
      URLSearchParams,
      ClawToast: { show() {} },
      _seenChoiceAlertIds: new Set(),
      _syncForegroundState() {},
    });
    // app-core.js 是 sse-client 注释所列全局（currentLanguage/ClawFW 约定等）的真实来源之一
    ctx.loadSource('public/src/app-core.js');
    ctx.loadSource('public/src/modules/sse-client.js');
    // 模块顶层已自动 boot（沙箱无 __clawAuthReady → 立即连接）
    const src = MockEventSource.instances[MockEventSource.instances.length - 1];
    assert.ok(src, 'boot 已建连');
    assert.equal(src.url, '/protoclaw/events');
    src.emit('hello', { hello: true });
    assert.equal(ctx.run('isSseActive()'), true);
    src.emit('connection', { kind: 'connection', agentId: 'a-1', data: { connected: true } });
    // connection 事件的 loadAgents 分支：app-core 未定义时可选链安全跳过（无炸即过）
  });
});
