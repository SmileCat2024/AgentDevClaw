/**
 * p2-esm-case 契约测试：classic 沙箱 + 真实 ESM 图的用例级隔离。
 *
 * 钉住的语义（helper 头注释是权威）：
 *   1. 同一 case 内所有 ESM 模块（含静态依赖与静态循环）是同一代实例，
 *      库级状态跨模块共享；命名导出可注入 classic ctx；
 *   2. 下一 case 整图重新实例化，模块级状态与 window 都不残留；
 *   3. window/document/fetch/计时器等全局按 case 安装、按原描述符恢复，
 *      计时器在 dispose 时全部取消（上一个 case 的回调不会跑进下一个）；
 *   4. 并发 withP2EsmCase 串行排队，嵌套直接报错；
 *   5. 入参校验：越出仓库根、case 结束后继续使用都会显式失败；
 *   6. esm-module-loader 的既有 API 与「只刷新入口」语义保持不变（回归）——
 *      静态依赖与静态循环跨 loadModuleOnce 调用复用，这正是本 helper 存在的
 *      原因，不能在改 helper 时悄悄改变旧路线行为。
 *
 * 本文件只用 test/helpers/p2-esm-fixture-cycle-*.js fixture，不触碰业务源码。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { activeCaseGraph } from './helpers/p2-esm-graph.js';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

const CYCLE_A = 'test/helpers/p2-esm-fixture-cycle-a.js';
const CYCLE_B = 'test/helpers/p2-esm-fixture-cycle-b.js';
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('p2-esm-case：图身份与 classic 注入', () => {
  test('同一 case 内依赖/循环共享一代实例；命名导出可注入 classic ctx', async () => {
    const seen = await withP2EsmCase(async (c) => {
      assert.equal(activeCaseGraph(), c.id);
      const a = await c.load(CYCLE_A);
      const aAgain = await c.load(CYCLE_A);
      const b = await c.load(CYCLE_B);

      // 同一 case 内同一路径是同一实例（模块缓存身份）
      assert.equal(aAgain, a);
      // 静态循环闭合：B 的 readA 就是本代 A 的 readA
      assert.equal(a.bSeesThisInstance(), true);
      assert.equal(b.linksTo(a.readA), true);

      // 模块级状态跨模块可见（B 读 A 的本代状态）
      a.bumpA();
      assert.equal(a.viaB(), 'b:1:0');
      assert.equal(a.bumpViaB(), 1);
      assert.equal(a.viaB(), 'b:1:1');

      // ESM 导出面注入 classic 沙箱：classic 侧裸标识符直接调用
      c.expose('CycleA', a);
      assert.equal(c.read('typeof CycleA.readA'), 'function');
      assert.equal(c.read('CycleA.readA()'), 1);
      assert.equal(c.read('CycleA.bSeesThisInstance()'), true);
      assert.equal(c.read('window.CycleA === CycleA'), true);
      return { a, b, window: c.window };
    });
    // case 结束后不再有激活的图命名空间
    assert.equal(activeCaseGraph(), null);
    assert.equal(typeof seen.a.readA, 'function');
    assert.equal(seen.a.readA(), 1); // 已完成的 case 图仍持有自身状态
    assert.ok(seen.window);
  });

  test('下一 case 整图重新实例化：模块状态、window、依赖实例都不复用', async () => {
    let firstA;
    let firstWindow;
    await withP2EsmCase(async (c) => {
      firstA = await c.load(CYCLE_A);
      firstWindow = c.window;
      firstA.bumpA();
      firstA.bumpA();
      assert.equal(firstA.readA(), 2);
      assert.equal(firstA.bumpViaB(), 1);
    });

    await withP2EsmCase(async (c) => {
      const secondA = await c.load(CYCLE_A);
      const secondB = await c.load(CYCLE_B);
      assert.notEqual(secondA, firstA, '入口必须是新一代实例');
      assert.notEqual(c.window, firstWindow, 'window 必须按 case 重建');
      assert.equal(secondA.readA(), 0, '模块级状态不继承上一 case');
      assert.equal(secondA.bSeesThisInstance(), true, '新一代循环仍闭合');
      assert.equal(secondA.viaB(), 'b:0:0');
      assert.equal(secondA.bumpViaB(), 1, '依赖模块状态同样从零开始');
      assert.equal(secondB.linksTo(secondA.readA), true);
      // 上一代实例仍按自己的状态存活（两代互不可见）
      assert.equal(firstA.readA(), 2);
    });
    assert.equal(activeCaseGraph(), null);
  });
});

describe('p2-esm-case：全局注入、计时器与清理', () => {
  test('window/document/fetch 按 case 安装，用例结束后按原描述符恢复', async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const fetchStub = async () => ({ ok: true, status: 200, json: async () => ({}) });
    globalThis.p2EsmProbeGlobal = 'before-case';

    await withP2EsmCase({
      globals: { fetch: fetchStub, p2EsmProbeGlobal: 'inside-case' },
    }, async (c) => {
      assert.equal(globalThis.window, c.window);
      assert.equal(globalThis.document, c.document);
      assert.equal(globalThis.fetch, fetchStub);
      assert.equal(globalThis.p2EsmProbeGlobal, 'inside-case');
      // 沙箱内部看到的 window / fetch 与主 realm 同源
      assert.equal(c.read('window === globalThis'), true);
      assert.equal(c.read('fetch === window.fetch'), true);
      assert.equal(c.read('p2EsmProbeGlobal'), 'inside-case');
      assert.equal(globalThis.setTimeout, c.sandbox.setTimeout, '计时器经 case 记账包装');
    });

    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(globalThis.setTimeout, originalSetTimeout);
    assert.equal(globalThis.window, undefined);
    assert.equal(globalThis.document, undefined);
    assert.equal(globalThis.p2EsmProbeGlobal, 'before-case');
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, 'window'), originalWindow);
    assert.equal(Object.getOwnPropertyDescriptor(globalThis, 'document'), originalDocument);
    delete globalThis.p2EsmProbeGlobal;
  });

  test('用例抛错也恢复全局；计时器全部取消，不跨 case 触发', async () => {
    const originalFetch = globalThis.fetch;
    let fired = 0;

    await assert.rejects(() => withP2EsmCase(async (c) => {
      c.sandbox.setTimeout(() => { fired += 1; }, 10);
      c.sandbox.setInterval(() => { fired += 1; }, 10);
      assert.equal(c.timerCount(), 2);
      throw new Error('case boom');
    }), /case boom/);

    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(globalThis.window, undefined);

    await withP2EsmCase(async () => { await tick(40); });
    assert.equal(fired, 0, '上一个 case 的计时器不得在下一个 case 期间触发');
  });

  test('并发 withP2EsmCase 串行排队；嵌套调用显式报错', async () => {
    const order = [];
    const first = withP2EsmCase(async (c) => {
      order.push('a-start');
      c.window.marker = 'a';
      await tick(20);
      assert.equal(globalThis.window, c.window, 'a 的用例体期间全局属于 a');
      assert.equal(c.read('marker'), 'a');
      order.push('a-end');
    });
    const second = withP2EsmCase(async (c) => {
      order.push('b-start');
      assert.equal(c.window.marker, undefined, 'b 不得看到 a 的 window');
      c.window.marker = 'b';
      assert.equal(c.read('marker'), 'b');
      order.push('b-end');
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);

    await assert.rejects(
      () => withP2EsmCase(async () => { await withP2EsmCase(async () => {}); }),
      /不支持嵌套/,
    );
  });
});

describe('p2-esm-case：入参与生命周期校验', () => {
  test('越出仓库根的路径拒绝；case 结束后 load/read/expose 全部拒绝', async () => {
    let captured;
    await withP2EsmCase(async (c) => {
      captured = c;
      await assert.rejects(() => c.load('../../outside-repo/evil.js'), /越出仓库根/);
      await assert.rejects(() => c.load(undefined), /需要仓库相对路径/);
    });
    assert.throws(() => captured.read('1 + 1'), /已结束/);
    assert.throws(() => captured.expose('X', 1), /已结束/);
    await assert.rejects(() => captured.load(CYCLE_A), /已结束/);
  });

  test('globals.window 不可覆盖（window 就是 case 沙箱）', async () => {
    await assert.rejects(
      () => withP2EsmCase({ globals: { window: {} } }, async () => {}),
      /globals\.window/,
    );
  });
});

describe('esm-module-loader 回归：API 与「只刷新入口」语义不变', () => {
  test('loadModuleOnce 仍是 { module, cleanup }，且静态依赖/循环跨调用复用', async () => {
    const first = await loadModuleOnce(CYCLE_A, { installGlobals: false });
    assert.equal(typeof first.module, 'object');
    assert.equal(typeof first.cleanup, 'function');
    first.cleanup(); // installGlobals:false 时为无操作

    const a1 = first.module;
    a1.bumpA();
    a1.bumpA();
    assert.equal(a1.readA(), 2);
    // 旧路线：入口 query 让 B 的 './p2-esm-fixture-cycle-a.js' 解析到规范 URL，
    // 循环被拆成两代（B 绑定的是规范 A，不是这次入口实例）。
    assert.equal(a1.bSeesThisInstance(), false);
    assert.equal(a1.bumpViaB(), 1);
    assert.equal(a1.viaB(), 'b:0:1');

    const second = await loadModuleOnce(CYCLE_A, { installGlobals: false });
    second.cleanup();
    const a2 = second.module;
    assert.notEqual(a2, a1, '入口每次都是新实例（既有契约）');
    assert.equal(a2.readA(), 0);
    assert.equal(a2.bSeesThisInstance(), false);
    // B 模块实例跨入口重载复用：模块级计数延续
    assert.equal(a2.bumpViaB(), 2);
    // B 读的仍是第一次装载的 A（规范 URL 实例），不是 a2
    assert.equal(a2.viaB(), 'b:0:2');
    assert.equal(a1.readA(), 2);
  });

  test('installBrowserStubs 契约不变：cleanup 恢复原全局', () => {
    const cleanup = installBrowserStubs();
    assert.equal(typeof globalThis.window, 'object');
    assert.equal(typeof globalThis.document, 'object');
    cleanup();
    assert.equal(globalThis.window, undefined);
    assert.equal(globalThis.document, undefined);
  });
});
