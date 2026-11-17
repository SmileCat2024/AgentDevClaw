/**
 * P2 收尾：仅 ESM import 消费的 6 个桥键注销（chat 窗口域 + 会话域）。
 *
 * 注销依据（逐键消费面复核，审计记录 C 组）：这 6 个键的唯一消费方都是 ESM
 * 文件里的具名 import，classic 侧零消费面 → 桥键冗余，撤桥（删 defineKey 与
 * 兼容 map 项），只保留命名导出。仍被 classic 裸标识符 / window.* 取用的键一律
 * 不动（见下方 RETAINED）。
 *
 * 装载路线（配方第三节「真实 import」，不造第二套地图）：
 *   - classic 相跑 index.html 的真实先行脚本链（prepareClassicSandbox：i18n /
 *     action-dispatcher / app-core / runtime-status / session-view-state /
 *     sidebar-render / app-ui / app-main），宿主工厂因此是生产实现本身；
 *   - ESM 相在**同一个 case 的同一张真实模块图**里 import 三个 owner
 *     （窗口分级 host / session-ui / session-mutation），不复制实现、不剥 ESM。
 *
 * 钉什么：
 *   1. 6 个键：window 上无访问器也无同名数据属性，classic 裸标识符不可解析，
 *      命名导出仍在（撤桥不撤实现）；
 *   2. 保留的 9 个键：仍有 classic 消费面，桥必须还在，且经裸标识符取到的就是
 *      模块命名导出本身（同一实现，不是快照）；
 *   3. 注册全集：四个 domain 的 defineKey 集合与声明清单等值（多注册 / 少注册
 *      都会红），每个 domain 恰好 claim 一次；
 *   4. 静态守卫：三个 owner 源码不再为注销键调用 defineKey（防回潮）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareClassicSandbox } from './p2-classic-hosts.js';

const REPO = path.resolve(import.meta.dirname, '..');
const MODULE = (name) => path.join(REPO, 'public', 'src', 'modules', name);

const LAZY_TOOL_CONTENT = 'public/src/modules/lazy-tool-content.js';
const CHAT_ROW_VISIBILITY = 'public/src/modules/chat-row-visibility.js';
const WINDOWING_HOST = 'public/src/modules/p2-w2-1-chat-windowing-host.js';
const SESSION_UI = 'public/src/modules/session-ui.js';
const SESSION_MUTATION = 'public/src/modules/session-mutation.js';

/** 本批注销的 6 个桥键 → 提供命名导出的 owner（domain 已随注册行删除）。 */
const RETIRED = [
  { key: 'applyProcessDistance', owner: 'lazyToolContent' },
  { key: 'precomputeViewportIdx', owner: 'lazyToolContent' },
  { key: 'markSessionArchivedForMutation', owner: 'sessionMutation' },
  { key: 'navigateToSessionMutationTarget', owner: 'sessionMutation' },
  { key: 'reconcileArchivedSourceRuntime', owner: 'sessionMutation' },
  { key: 'getWorkspaceSessionById', owner: 'sessionUi' },
];

/** 仍有 classic 消费面的键（不得顺手删）：domain → 键清单。 */
const RETAINED = {
  'lazy-tool-content': [
    'clearProcessDistance', 'freezeProcessWindowing', 'unfreezeProcessWindowing',
    'runLandingCollapseScan', 'setProcessWindowingDisabled',
  ],
  'chat-row-visibility': ['refreshMeasuredChatRows', 'revealMeasuredChatRow'],
  'session-ui': ['getWorkspaceSessions'],
  'session-mutation': ['getSessionReplacementMutation'],
};

/** 包裹 kernel-state 的注册/认领，记录 case 装载期的 (domain, key)。 */
function recordKernelRegistrations(kernel) {
  const keys = [];
  const claims = [];
  const originalDefineKey = kernel.defineKey;
  const originalClaim = kernel.claim;
  kernel.defineKey = (domain, key, initialValue) => {
    keys.push(`${domain}:${key}`);
    return originalDefineKey.call(kernel, domain, key, initialValue);
  };
  kernel.claim = (domain, impl) => {
    claims.push(domain);
    return originalClaim.call(kernel, domain, impl);
  };
  return {
    recorded: { keys, claims },
    restore() {
      kernel.defineKey = originalDefineKey;
      kernel.claim = originalClaim;
    },
  };
}

/**
 * 一个用例 = 真实 classic 先行链 + 同一张真实 ESM 图（每 case 一代实例）。
 * `fn` 拿到 c 与三个 owner 的命名空间。
 */
async function withChatSessionCase(options, fn) {
  const { record = false } = options || {};
  return withP2EsmCase({
    classic: (sandbox) => {
      prepareClassicSandbox(sandbox);
    },
  }, async (c) => {
    const recorder = record ? recordKernelRegistrations(c.window.KernelState) : null;
    try {
      const lazyToolContent = await c.load(LAZY_TOOL_CONTENT);
      const chatRowVisibility = await c.load(CHAT_ROW_VISIBILITY);
      // host 只注册桥（实现模块本身零桥），首屏链之后装载才是生产时相
      await c.load(WINDOWING_HOST);
      const sessionUi = await c.load(SESSION_UI);
      const sessionMutation = await c.load(SESSION_MUTATION);
      const result = await fn({
        c,
        lazyToolContent,
        chatRowVisibility,
        sessionUi,
        sessionMutation,
        recorded: recorder?.recorded,
      });
      // 只读桥面，不应留下计时器句柄（下一个用例的全局不会被旧回调写脏）
      assert.equal(c.timerCount(), 0, '用例结束不应残留计时器');
      return result;
    } finally {
      recorder?.restore();
    }
  });
}

test('六个键注销：window 无访问器、classic 裸标识符不可解析、命名导出仍在', async () => {
  await withChatSessionCase({}, async (scope) => {
    const owners = {
      lazyToolContent: scope.lazyToolContent,
      sessionUi: scope.sessionUi,
      sessionMutation: scope.sessionMutation,
    };
    for (const { key, owner } of RETIRED) {
      const namespace = owners[owner];
      // 撤桥：既不恢复同名访问器，也不留散装数据属性（桥债与全局台账都不再计它）
      assert.equal(Object.getOwnPropertyDescriptor(scope.c.window, key), undefined,
        `${key} 的桥已注销，不得留在 window 上`);
      assert.equal(key in scope.c.window, false, `${key} 不得以任何形态挂在 window 上`);
      // classic 侧（裸标识符）解析不到：说明敞口真的关闭了，不是换个形态继续暴露
      assert.equal(scope.c.read(`typeof ${key}`), 'undefined',
        `${key} 不应可被 classic 裸标识符解析`);
      // 撤桥不撤实现：唯一可达面是 ESM 具名 import
      assert.equal(typeof namespace[key], 'function', `${key} 必须仍是命名导出`);
    }
  });
});

test('保留键仍上桥：classic 消费面取到同一实现（注销没有误删活桥）', async () => {
  await withChatSessionCase({}, async (scope) => {
    const namespaces = {
      'lazy-tool-content': scope.lazyToolContent,
      'chat-row-visibility': scope.chatRowVisibility,
      'session-ui': scope.sessionUi,
      'session-mutation': scope.sessionMutation,
    };
    for (const [domain, keys] of Object.entries(RETAINED)) {
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(scope.c.window, key);
        assert.equal(typeof descriptor?.get, 'function', `${domain}:${key} 仍应有桥 getter`);
        assert.equal(typeof descriptor?.set, 'function', `${domain}:${key} 仍应成对提供 setter`);
        assert.equal(scope.c.read(key), namespaces[domain][key],
          `${domain}:${key} 经裸标识符取到的必须是同一命名导出`);
      }
    }
  });
});

test('注册全集：四个 domain 的桥键集合与声明清单等值，且每域匹配一次 claim', async () => {
  await withChatSessionCase({ record: true }, async ({ recorded }) => {
    const domains = Object.keys(RETAINED);
    const expectedAll = domains.flatMap((domain) => RETAINED[domain].map((key) => `${domain}:${key}`));
    const recordedKeys = recorded.keys.filter((entry) => domains.includes(entry.split(':')[0]));

    // 多注册一个无消费键（正是本批注销的形态）或多漏一个活桥都会在这里变红
    assert.deepEqual([...recordedKeys].sort(), [...expectedAll].sort());
    assert.equal(recordedKeys.length, new Set(recordedKeys).size, '同一桥键不得注册两次');

    const claims = recorded.claims.filter((domain) => domains.includes(domain));
    assert.deepEqual([...claims].sort(), [...domains].sort(), '每个域恰好 claim 一次');

    // 注销键不得以任何 domain 形态出现（防止换个 domain 重新上桥）
    for (const { key } of RETIRED) {
      assert.equal(recordedKeys.some((entry) => entry.endsWith(`:${key}`)), false,
        `${key} 不得再注册桥键`);
    }
  });
});

test('静态守卫：三个 owner 源码不再为注销键调用 defineKey', () => {
  const owners = {
    'p2-w2-1-chat-windowing-host.js': ['applyProcessDistance', 'precomputeViewportIdx'],
    'session-mutation.js': [
      'markSessionArchivedForMutation',
      'navigateToSessionMutationTarget',
      'reconcileArchivedSourceRuntime',
    ],
    'session-ui.js': ['getWorkspaceSessionById'],
  };
  for (const [file, keys] of Object.entries(owners)) {
    const text = readFileSync(MODULE(file), 'utf8');
    for (const key of keys) {
      assert.doesNotMatch(text, new RegExp(`defineKey\\([^\\n]*'${key}'`),
        `${file} 不得再为 ${key} 注册桥键`);
    }
  }
  // 反向守卫：保留键的注册行确实还在（防止把整块兼容面删掉）
  const hostText = readFileSync(MODULE('p2-w2-1-chat-windowing-host.js'), 'utf8');
  for (const key of RETAINED['lazy-tool-content']) {
    assert.match(hostText, new RegExp(`defineKey\\('lazy-tool-content', '${key}'`),
      `${key} 仍为 classic 消费面保留桥键`);
  }
  const mutationText = readFileSync(MODULE('session-mutation.js'), 'utf8');
  assert.match(mutationText, /defineKey\('session-mutation', 'getSessionReplacementMutation'/,
    'getSessionReplacementMutation 仍为 classic runtime-status 保留桥键');
  const sessionUiText = readFileSync(MODULE('session-ui.js'), 'utf8');
  assert.match(sessionUiText, /defineKey\('session-ui', 'getWorkspaceSessions'/,
    'getWorkspaceSessions 仍为 classic 消费面保留桥键');
});
