/**
 * KernelState 桥契约测试（P0.2）。
 *
 * public/src/modules/kernel-state.js 是 ESM 绞杀者迁移的兼容桥：哑存储 +
 * window 访问器 + 认领协议。本文件钉住桥的全部语义边角（机制规格见
 * docs/plans/2026-11-16-frontend-esm-strangler-migration.md「桥机制规格」）：
 * 裸标识符读写、认领前后语义、strict 写、delete 撤桥、枚举不可见、
 * early-boot 可用、认领后双向转发、桥债计数、唯一注册制。
 *
 * kernel-state.js 无 DOM 依赖，用比 frontend-vm.js 更薄的沙箱：
 * `sandbox.window = sandbox` 使 window 与 globalThis 同一（与浏览器一致），
 * 裸标识符读写沿作用域链落到 window 访问器上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'public/src/modules/kernel-state.js'),
  'utf8',
);

function createBridgeSandbox() {
  const sandbox = { console };
  sandbox.window = sandbox; // 浏览器中 window 即全局对象
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'kernel-state.js' });
  return sandbox;
}

const run = (sandbox, code) => vm.runInContext(code, sandbox);

test('defineKey 后裸标识符读写经访问器落哑存储；setter 赋值 getter 可读回', () => {
  const sandbox = createBridgeSandbox();
  sandbox.KernelState.defineKey('lang', 'currentLanguage', 'zh');
  assert.equal(run(sandbox, 'currentLanguage'), 'zh');
  run(sandbox, 'currentLanguage = "en"');
  assert.equal(run(sandbox, 'currentLanguage'), 'en');
  // 经 window 属性读写与裸标识符同路（同一访问器）
  assert.equal(sandbox.currentLanguage, 'en');
  sandbox.currentLanguage = 'fr';
  assert.equal(run(sandbox, 'currentLanguage'), 'fr');
});

test('early-boot：无任何 claim 时，classic 顶层代码直接裸读写桥键拿到哑存储值', () => {
  const sandbox = createBridgeSandbox();
  // 模拟 app-core 注册（桥先于一切域模块装载）
  sandbox.KernelState.defineKey('session', 'currentRuntimeAgentId', null);
  // 模拟另一 classic 文件顶层代码（早于 deferred ESM 执行）直接读写
  const value = run(sandbox, `
    currentRuntimeAgentId = 'agent-1';
    const probe = currentRuntimeAgentId;
    probe;
  `);
  assert.equal(value, 'agent-1');
});

test('claim 初值语义（吸收式）：认领前写入的值经 impl.set 一次性推给域模块，认领后仍可读', () => {
  const sandbox = createBridgeSandbox();
  sandbox.KernelState.defineKey('theme', 'currentTheme', 'light');
  run(sandbox, 'currentTheme = "dark"'); // claim 前写入哑存储

  const received = [];
  const implState = {};
  sandbox.KernelState.claim('theme', {
    get: (key) => implState[key],
    set: (key, value) => {
      received.push([key, value]);
      implState[key] = value;
    },
  });

  // 哑存储现值经 impl.set 吸收进域模块状态
  assert.deepEqual(received, [['currentTheme', 'dark']]);
  // 认领后裸读经 impl.get 拿到的是吸收后的现值
  assert.equal(run(sandbox, 'currentTheme'), 'dark');
});

test('认领后双向：classic 裸赋值转发 impl.set；ESM 侧改状态经 impl.get 到裸读', () => {
  const sandbox = createBridgeSandbox();
  sandbox.KernelState.defineKey('theme', 'currentTheme', 'light');
  const received = [];
  const implState = { currentTheme: 'light' };
  sandbox.KernelState.claim('theme', {
    get: (key) => implState[key],
    set: (key, value) => {
      received.push([key, value]);
      implState[key] = value;
    },
  });

  // classic 侧裸赋值 → impl.set 收到（首条是 claim 时的现值吸收，吸收式语义的直接体现）
  run(sandbox, 'currentTheme = "navy"');
  assert.deepEqual(received, [['currentTheme', 'light'], ['currentTheme', 'navy']]);
  assert.equal(implState.currentTheme, 'navy');
  // ESM 侧模拟状态变化 → impl.get → classic 裸读到新值
  implState.currentTheme = 'midnight';
  assert.equal(run(sandbox, 'currentTheme'), 'midnight');
});

test('strict 模式上下文对桥键赋值不抛错（get/set 成对提供）', () => {
  const sandbox = createBridgeSandbox();
  sandbox.KernelState.defineKey('probe', 'strictTarget', null);
  // ESM 模块与 'use strict' classic 文件都是 strict 上下文；只 getter 属性
  // 赋值会抛 TypeError，set 成对提供则不抛且生效。
  assert.equal(run(sandbox, '"use strict"; strictTarget = 1; strictTarget'), 1);
});

test('delete window.<key> 成功（configurable: true，终局撤桥需要）', () => {
  const sandbox = createBridgeSandbox();
  sandbox.KernelState.defineKey('lang', 'currentLanguage', 'zh');
  assert.equal(run(sandbox, 'delete window.currentLanguage'), true);
  assert.equal(run(sandbox, 'typeof currentLanguage'), 'undefined');
  assert.equal('currentLanguage' in sandbox, false);
});

test('桥键不进 Object.keys / for-in（enumerable: false，与顶层 let 一致）', () => {
  const sandbox = createBridgeSandbox();
  sandbox.KernelState.defineKey('lang', 'currentLanguage', 'zh');
  assert.equal(run(sandbox, 'Object.keys(window).includes("currentLanguage")'), false);
  assert.equal(
    run(sandbox, `
      let seen = false;
      for (const k in window) { if (k === 'currentLanguage') seen = true; }
      seen;
    `),
    false,
  );
});

test('stats()：多域多键、部分认领时计数正确', () => {
  const sandbox = createBridgeSandbox();
  sandbox.KernelState.defineKey('a', 'ka1', 1);
  sandbox.KernelState.defineKey('a', 'ka2', 2);
  sandbox.KernelState.defineKey('b', 'kb1', 3);
  // stats() 对象产自 vm realm，原型与宿主不同，展开成宿主对象再比较
  assert.deepEqual({ ...sandbox.KernelState.stats() }, { registeredKeys: 3, claimedKeys: 0 });

  const noop = { get: (key) => null, set: () => {} };
  sandbox.KernelState.claim('a', noop);
  assert.deepEqual({ ...sandbox.KernelState.stats() }, { registeredKeys: 3, claimedKeys: 2 });

  sandbox.KernelState.claim('b', noop);
  assert.deepEqual({ ...sandbox.KernelState.stats() }, { registeredKeys: 3, claimedKeys: 3 });
});

test('同键重复 defineKey 抛错（桥键唯一注册制）', () => {
  const sandbox = createBridgeSandbox();
  sandbox.KernelState.defineKey('lang', 'currentLanguage', 'zh');
  // vm realm 的 Error 与宿主 Error 原型不同，用函数验证器断 message
  assert.throws(
    () => sandbox.KernelState.defineKey('lang', 'currentLanguage', 'en'),
    (err) => err.message.includes('桥键重复注册'),
  );
  // 跨域同名同样拒绝：全名 domain:key 唯一
  assert.throws(
    () => sandbox.KernelState.defineKey('other', 'currentLanguage', 'en'),
    (err) => err.message.includes('桥键重复注册'),
  );
  // 抛错后原访问器未被破坏
  assert.equal(run(sandbox, 'currentLanguage'), 'zh');
});
