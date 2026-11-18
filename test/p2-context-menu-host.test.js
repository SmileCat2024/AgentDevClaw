/**
 * P2 bootstrap 消费接口：上下文菜单待执行目标（6 个 classic let）的 host 契约。
 *
 * 钉住的语义（与 p2-bootstrap-hosts.test.js 同口径，但走 withP2EsmCase 的真实
 * classic → ESM 整图）：
 * 1. classic 时点可用：app-core.js 解析完成后即可调用工厂，6 键初值与原声明一致；
 * 2. freeze + 访问器语义：对象冻结（不可新增/删除属性），每键是 get/set 成对的
 *    访问器而非快照数据属性，ESM 写入转发到原经典 let；
 * 3. 装载前的 classic 写入不丢失（适配模块不重跑初始化），classic ↔ ESM 双向
 *    读写同一份状态、同一对象引用；
 * 4. 无新增启动等待（不导出 ready/promise），也不发布 window 全局。
 *
 * app-core 自 P4 T5 起是 ESM：由 APP_CORE_DOMAIN 在模块相最先装载（原 classic 标签
 * 已改 module 入口），ESM 侧用 withP2EsmCase 的真实 import（每 case 一张独立模块图）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { APP_CORE_DOMAIN, prepareEsmModules } from './p2-classic-hosts.js';

const ADAPTER = 'public/src/modules/p2-bootstrap-context-menu.js';
const KEYS = [
  'contextMenuAgentId',
  'contextMenuAgentMode',
  'contextMenuCompactAction',
  'contextMenuProjectAgentId',
  'contextMenuProjectId',
  'contextMenuFeatureRepoPackageId',
];

const caseOptions = () => ({
  classic: (sandbox) => prepareEsmModules(sandbox, APP_CORE_DOMAIN),
});

test('classic 时点可用：初值、freeze 与 get/set 访问器语义', async () => {
  await withP2EsmCase(caseOptions(), async (c) => {
    // app-core 自 P4 T5 起是 ESM：6 个键经 domain `app-core` 的桥键（非枚举访问器）
    // 与工厂同源可达，模块装载前、后都是同一份状态。
    assert.equal(c.read('typeof createP2BootstrapContextMenuHost'), 'function');
    assert.equal(c.read('window.hasOwnProperty("contextMenuAgentId")'), true);
    assert.equal(c.read('Object.getOwnPropertyDescriptor(window, "contextMenuAgentId").enumerable'), false);

    const host = c.read('createP2BootstrapContextMenuHost()');
    assert.equal(Object.isFrozen(host), true, 'host 必须冻结，不能作为第二份状态容器');

    for (const key of KEYS) {
      assert.equal(host[key], null, `${key} 初值是 name 声明处的 null`);
      assert.equal(host[key], c.read(key), `${key} 读取转发到原声明`);

      const descriptor = Object.getOwnPropertyDescriptor(host, key);
      assert.equal(typeof descriptor.get, 'function', `${key} 需要 getter`);
      assert.equal(typeof descriptor.set, 'function', `${key} 需要 setter（6 键都可写）`);
      assert.equal('value' in descriptor, false, `${key} 不得是快照数据属性`);
      assert.equal(descriptor.enumerable, true);
      assert.equal(descriptor.configurable, false, `${key} 冻结后不可重定义`);
    }

    // ESM strict：冻结对象不可新增/删除属性，但 6 键赋值合法。
    assert.throws(() => { host.extra = 1; }, TypeError);
    assert.throws(() => { delete host.contextMenuAgentId; }, TypeError);
    host.contextMenuAgentId = 'agent-strict';
    assert.equal(c.read('contextMenuAgentId'), 'agent-strict');
  });
});

test('装载前的 classic 写入保留；classic ↔ ESM 双向读写同一状态与同一引用', async () => {
  await withP2EsmCase(caseOptions(), async (c) => {
    // 模拟装载前（打开菜单的 classic 路径）写入全部 6 键。
    c.read('contextMenuAgentId = "agent-boot"');
    c.read('contextMenuAgentMode = "child-runtime"');
    c.read('contextMenuCompactAction = { sessionId: "sess-boot", compactType: "summary" }');
    c.read('contextMenuProjectAgentId = "agent-proj"');
    c.read('contextMenuProjectId = "proj-boot"');
    c.read('contextMenuFeatureRepoPackageId = "pkg-boot"');
    const actionRef = c.read('contextMenuCompactAction');

    const { contextMenuUi } = await c.load(ADAPTER);

    // 装载适配模块不得重跑初始化：装载前写入的值仍可见。
    assert.equal(contextMenuUi.contextMenuAgentId, 'agent-boot');
    assert.equal(contextMenuUi.contextMenuAgentMode, 'child-runtime');
    assert.equal(contextMenuUi.contextMenuCompactAction, actionRef, '对象按引用往返，不复制');
    assert.equal(contextMenuUi.contextMenuProjectAgentId, 'agent-proj');
    assert.equal(contextMenuUi.contextMenuProjectId, 'proj-boot');
    assert.equal(contextMenuUi.contextMenuFeatureRepoPackageId, 'pkg-boot');

    // ESM 写 → classic 读（关闭菜单的清空路径）。
    contextMenuUi.contextMenuAgentId = 'agent-esm';
    assert.equal(c.read('contextMenuAgentId'), 'agent-esm');
    contextMenuUi.contextMenuAgentMode = 'prebuilt-runtime';
    assert.equal(c.read('contextMenuAgentMode'), 'prebuilt-runtime');
    contextMenuUi.contextMenuProjectId = null;
    assert.equal(c.read('contextMenuProjectId'), null);
    const nextAction = { sessionId: 'sess-esm' };
    contextMenuUi.contextMenuCompactAction = nextAction;
    assert.equal(c.read('contextMenuCompactAction'), nextAction, 'ESM 写入的对象被原声明原样持有');

    // classic 写 → ESM 读。
    c.read('contextMenuFeatureRepoPackageId = "pkg-classic"');
    assert.equal(contextMenuUi.contextMenuFeatureRepoPackageId, 'pkg-classic');
    c.read('contextMenuProjectAgentId = null');
    assert.equal(contextMenuUi.contextMenuProjectAgentId, null);
  });
});

test('导出面唯一且无等待面；新 case 是独立实例、初值复原', async () => {
  await withP2EsmCase(caseOptions(), async (c) => {
    const module = await c.load(ADAPTER);
    assert.deepEqual(Object.keys(module), ['contextMenuUi'], '导出面漂移');
    const { contextMenuUi } = module;
    assert.equal(Object.isFrozen(contextMenuUi), true);
    assert.equal(contextMenuUi instanceof Promise, false);
    for (const key of Object.keys(module)) {
      assert.equal(/ready|wait/i.test(key), false, `不应导出等待面：${key}`);
    }
    // 不发布 window 全局：classic 词法绑定与模块导出都不是 window 属性。
    assert.equal(c.read('window.hasOwnProperty("contextMenuUi")'), false);

    // 同 case 内重复装载拿到同一实例（模块图身份）。
    const again = await c.load(ADAPTER);
    assert.equal(again.contextMenuUi, contextMenuUi);

    contextMenuUi.contextMenuAgentId = 'leak-check';
  });

  await withP2EsmCase(caseOptions(), async (c) => {
    assert.equal(c.read('contextMenuAgentId'), null, '上一 case 的写入不得残留到新沙箱');
    const { contextMenuUi } = await c.load(ADAPTER);
    for (const key of KEYS) assert.equal(contextMenuUi[key], null, `${key} 新 case 回到声明初值`);
  });
});
