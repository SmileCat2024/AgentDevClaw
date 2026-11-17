/**
 * P2 第二波 3b「部分压缩 / 回退对话框域」——状态 owner 的兼容面与真实行为。
 *
 * 装载路线：test/helpers/p2-esm-case.js 的 `withP2EsmCase`（整图隔离真实
 * import + 真实 classic 沙箱）。classic 相按生产时点跑真实 rollback-dialog.js
 * （它只做 classic 相 defineKey 注册与函数声明），ESM 相跑本批 owner；两侧共享
 * 同一个 window，桥的两端因此是生产语义。
 *
 * 钉住四件事：
 *   1. classic 相注册的真初值在 ESM claim 时被吸收（吸收式认领，无双存储）；
 *   2. 认领后双向转发：owner 活绑定/setter ↔ classic 裸标识符读写（
 *      input-render / input-composer / app-main 的消费形态）；
 *   3. compact 记账按真实语义工作：存储键按会话拼装、迟到清理不越权、
 *      归零同时停计时器且只在发起视图上声明输入面变更；
 *   4. 私有键不上桥（getPartialCompactStorageKey / clearPartialCompactStartedAt
 *      零跨文件消费方，window 上没有它们）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const DOMAIN = 'public/src/modules/p2-w2-3b-rollback-domain.js';
const CLASSIC = 'public/src/modules/rollback-dialog.js';

/** 最小会话存储桩（owner 只用 getItem / setItem / removeItem）。 */
function createSessionStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { map.delete(key); },
  };
}

/**
 * classic 相：生产顺序里 rollback-dialog.js 之前的东西只用到 KernelState（由
 * 沙箱地基安装），它自己再补上运行时才解析的依赖（此处用最小桩——本用例不驱动
 * 对话框装配，只驱动状态与 compact 记账）。
 */
function rollbackCaseOptions() {
  const sessionStorage = createSessionStorage();
  const options = {
    classic: (sandbox) => {
      sandbox.__cacheKey = 'session-a';
      sandbox.__surfaceNotices = 0;
      // 桥接期消费方（app-main / input-render）在本用例里以桩形态存在
      sandbox._getSessionInputCacheKey = () => sandbox.__cacheKey;
      sandbox.notifyInputSurfaceChanged = () => { sandbox.__surfaceNotices += 1; };
      sandbox.loadSource(CLASSIC);
    },
    globals: { sessionStorage },
  };
  return { sessionStorage, options };
}

test('状态 owner：classic 相真初值 → claim 吸收 → 双向转发', async () => {
  const { options } = rollbackCaseOptions();
  await withP2EsmCase(options, async (c) => {
    // 首屏同步链在 classic 相裸读的就是这些值（input-render / input-composer）
    assert.equal(c.read('typeof _rollbackDialogOpen'), 'boolean');
    assert.equal(c.read('_rollbackDialogOpen'), false);
    assert.equal(c.read('_partialCompactInFlight'), false);
    assert.equal(c.read('_partialCompactRuntimeId'), null);
    assert.equal(c.read('_partialCompactContextKey'), null);
    assert.equal(c.read('_compactTimerInterval'), null);

    // claim 之前的 classic 写落在哑存储（对话框已打开、压缩在飞的瞬态）
    c.read('_rollbackDialogOpen = true; _partialCompactInFlight = true;'
      + ' _partialCompactRuntimeId = "rt-1"; _partialCompactContextKey = "session-a";');

    const domain = await c.load(DOMAIN);
    assert.equal(domain.rollbackDialogOpen, true, 'claim 吸收 classic 相写入');
    assert.equal(domain.partialCompactInFlight, true);
    assert.equal(domain.partialCompactRuntimeId, 'rt-1');
    assert.equal(domain.partialCompactContextKey, 'session-a');

    // owner → classic 裸读（活绑定）
    domain.setRollbackDialogOpen(false);
    domain.setCompactTimerInterval(42);
    assert.equal(c.read('_rollbackDialogOpen'), false);
    assert.equal(c.read('_compactTimerInterval'), 42);

    // classic 裸写 → owner（对话框关闭、压缩归零的真实写点）
    c.read('_rollbackDialogOpen = true; _partialCompactInFlight = false;'
      + ' _partialCompactRuntimeId = null; _compactTimerInterval = null;');
    assert.equal(domain.rollbackDialogOpen, true);
    assert.equal(domain.partialCompactInFlight, false);
    assert.equal(domain.partialCompactRuntimeId, null);
    assert.equal(domain.compactTimerInterval, null);

    // 与顶层 let 一致的属性语义：不可枚举、可配置（终局撤桥需要）
    assert.equal(c.read('Object.prototype.propertyIsEnumerable.call(window, "_rollbackDialogOpen")'), false);
    assert.equal(c.read('Object.getOwnPropertyDescriptor(window, "_partialCompactContextKey").configurable'), true);
  });
});

test('compact 记账：按会话拼装存储键并读写开始时间', async () => {
  const { options, sessionStorage } = rollbackCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const domain = await c.load(DOMAIN);

    assert.equal(domain.getPartialCompactStorageKey, undefined, '存储键拼装是模块私有，不导出不上桥');
    assert.equal(c.read('typeof window.getPartialCompactStorageKey'), 'undefined');

    // classic 消费方（input-render 压缩卡分支）经桥键读写
    assert.equal(c.read('typeof window.writePartialCompactStartedAt'), 'function');
    assert.equal(c.read('typeof window.readPartialCompactStartedAt'), 'function');

    c.read('writePartialCompactStartedAt(1111, "session-a")');
    assert.equal(sessionStorage.map.get('agentdev-partial-compact-start:session-a'), '1111');
    assert.equal(c.read('readPartialCompactStartedAt("session-a")'), 1111);

    // 默认上下文键来自会话身份（app-main 的 _getSessionInputCacheKey）
    c.read('__cacheKey = "session-default"');
    c.read('writePartialCompactStartedAt(2222)');
    assert.equal(domain.readPartialCompactStartedAt(), 2222);
    assert.equal(domain.readPartialCompactStartedAt('session-a'), 1111, '默认键只写自己的会话');

    // 非数字 / 空键：不写入、读回 null（原实现的输入校验语义）
    c.read('writePartialCompactStartedAt("nope", "session-a")');
    assert.equal(domain.readPartialCompactStartedAt('session-a'), 1111, '非法开始时间不覆盖既有值');
    c.read('writePartialCompactStartedAt(3333, "")');
    assert.equal(sessionStorage.map.size, 2, '空上下文键不写存储');
    assert.equal(domain.readPartialCompactStartedAt(''), null);

    // 存储内容被外部改坏时读回 null（渲染路径按当前时刻补齐）
    sessionStorage.map.set('agentdev-partial-compact-start:session-broken', 'not-a-number');
    assert.equal(domain.readPartialCompactStartedAt('session-broken'), null);
  });
});

test('classic 裸调 clearPartialCompactState：经桥转发到 owner（app-main 的真实调用形态）', async () => {
  const { options, sessionStorage } = rollbackCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const domain = await c.load(DOMAIN);

    // app-main 的调用形态是**裸标识符**（classic script 里的 `clearPartialCompactState()`），
    // 不是 `window.` 前缀，也不是 import——这里就按那个形态驱动。
    assert.equal(c.read('typeof clearPartialCompactState'), 'function', '裸标识符经桥解析到 owner 实现');
    assert.equal(c.read('clearPartialCompactState === window.clearPartialCompactState'), true,
      '裸标识符与 window 访问器同一个函数对象');

    c.read('_partialCompactInFlight = true; _partialCompactRuntimeId = "rt-7";'
      + ' _partialCompactContextKey = "session-a";'
      + ' _compactTimerInterval = setInterval(() => {}, 60);'
      + ' writePartialCompactStartedAt(7000, "session-a");');
    assert.equal(c.timerCount(), 1);

    // 真实调用点（无参 → 默认上下文键 = 当前会话身份）
    c.read('clearPartialCompactState()');

    assert.equal(domain.partialCompactInFlight, false, '裸调命中 owner 状态归零');
    assert.equal(domain.partialCompactRuntimeId, null);
    assert.equal(domain.partialCompactContextKey, null);
    assert.equal(c.timerCount(), 0, '计时器随之停止');
    assert.equal(sessionStorage.map.has('agentdev-partial-compact-start:session-a'), false);
    assert.equal(c.read('__surfaceNotices'), 1, '发起视图上声明一次输入面变更');
  });
});

test('compact 归零：清状态、停计时器、只抹自己的开始时间、只在发起视图声明输入面', async () => {
  const { options, sessionStorage } = rollbackCaseOptions();
  await withP2EsmCase(options, async (c) => {
    const domain = await c.load(DOMAIN);

    // 发起视图 = session-a（与 _getSessionInputCacheKey 一致）
    c.read('_partialCompactInFlight = true; _partialCompactRuntimeId = "rt-1";'
      + ' _partialCompactContextKey = "session-a";'
      + ' _compactTimerInterval = setInterval(() => {}, 60);'
      + ' writePartialCompactStartedAt(4444, "session-a");'
      + ' writePartialCompactStartedAt(5555, "session-other");');
    assert.equal(c.timerCount(), 1, '压缩计时器在飞');

    domain.clearPartialCompactState();

    assert.equal(domain.partialCompactInFlight, false);
    assert.equal(domain.partialCompactRuntimeId, null);
    assert.equal(domain.partialCompactContextKey, null);
    assert.equal(domain.compactTimerInterval, null);
    assert.equal(c.timerCount(), 0, '归零同时停掉计时器');
    assert.equal(sessionStorage.map.has('agentdev-partial-compact-start:session-a'), false);
    assert.equal(sessionStorage.map.has('agentdev-partial-compact-start:session-other'), true,
      '不越权清理别的会话的开始时间');
    assert.equal(c.read('__surfaceNotices'), 1, '发起视图上声明一次输入面变更');

    // 迟到清理（旧会话的压缩结束，当前视图已切到 session-a）：整体不动作
    c.read('_partialCompactInFlight = true; _partialCompactRuntimeId = "rt-2";'
      + ' _partialCompactContextKey = "session-old";');
    domain.clearPartialCompactState('session-new');
    assert.equal(domain.partialCompactInFlight, true, '跨上下文键的迟到清理被拒绝');
    assert.equal(domain.partialCompactContextKey, 'session-old');

    // 自己的那份清理照常执行，但“当前视图”已不是发起视图 → 不再声明输入面变更
    domain.clearPartialCompactState('session-old');
    assert.equal(domain.partialCompactInFlight, false);
    assert.equal(c.read('__surfaceNotices'), 1, '旧 lease 的结束不重渲染新会话输入面');
  });
});
