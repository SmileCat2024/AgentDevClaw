/**
 * Tests for public/src/modules/feature-config.js
 *
 * Covers pure data-path helpers:
 *   - Config normalization (normalizeFeatureConfigEntry, normalizeFeatureConfigMap)
 *   - Config lookup/matching (buildFeatureConfigLookupKeys, featureConfigKeyMatches,
 *     findFeatureConfigMapEntry, removeMatchingFeatureConfigAliases)
 *   - Manifest helpers (resolveFeaturePackageRecord, findFeatureManifestForSelection,
 *     getFeatureManifestPropertyEntries, getFeatureManifestDisplayName,
 *     formatManifestDefaultValue, normalizeManifestComparableValue)
 *   - Status meta (getFeatureConfigStatusMeta)
 *   - Value coercion (coerceFeatureManifestValue, parseInlineDataValue)
 *   - File accept matching (normalizeAcceptList, matchesFeatureConfigAccept)
 *   - DOM ID generation (featureControlDomId)
 *
 * 装载路线：真实 ESM import（withP2EsmCase 的 c.load）+ 直接调用命名导出；
 * 旧 vm 沙箱的 loadSource + 字符串求值已移除。每个用例独立一张模块图。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { withP2EsmCase } from './helpers/p2-esm-case.js';
import { prepareSidebarDomain } from './p2-classic-hosts.js';

/**
 * 装载路线（ESM 迁移配方第三节）：feature-config.js 已是 ESM，真实 import 其命名
 * 导出后直接调用纯函数；每个用例一份 window + 一张 ESM 图（整图隔离）。
 *
 * classic 相跑真实装载链（与 index.html 的先行脚本同形），宿主全部来自真实实现：
 *   i18n 词表 → 事件分发器 → app-core（内核桥键真初值 + 多数 host 工厂）→
 *   runtime-status（`_agentSuspended` 等 const 容器）→ session-view-state（commit
 *   host）→ sidebar-render（侧栏签名 / call-states / 列表快照三处 host 工厂）。
 * 只有 app-main / app-ui 的三个 host 工厂需要 seam（它们的顶层是整条首屏 boot，
 * 不在用例装载面内），按真实工厂成员面逐项补全，不使用 Proxy 兜底。
 *
 * 语言初值走真实路径：app-core 从 `localStorage.agentdev-language` 读取并注册
 * i18n 桥键。旧用例的环境是 `currentLanguage: 'en'`，本文件默认同样播种 'en'，
 * 并用真实 i18n owner 的 getter 断言它确实是 'en'（否则英文断言只是 undefined
 * 分支的偶然绿）；另有 zh 对照用例证明文案确实由语言驱动。
 */
const FEATURE_CONFIG = 'public/src/modules/feature-config.js';
const I18N_STATE = 'public/src/modules/i18n-environment-state.js';

/** classic 相真实装载链（顺序同 index.html：classic 先行于 deferred ESM）。 */
const CLASSIC_BOOTSTRAP = [
  'public/src/modules/action-dispatcher.js',
  'public/src/app-core.js',
  // session-view-state 自 P4 T2 起是 ESM：由 prepareEsmModules(sandbox, SESSION_VIEW_DOMAIN)
  // / prepareClassicSandbox 在模块相装载，classic 链里不再有它。
];

/**
 * app-main / app-ui 的宿主工厂 seam（真实实现住在首屏 boot 文件里）。
 * 成员面逐项对齐真实工厂（`createRuntimeSwitchHost` / `createCompactResumeHost`
 * / `createWorkspaceSurfaceHost`），漏面会直接抛错而不是被 Proxy 吞掉。
 * 计时器走沙箱 setTimeout，受 case 级记账与 dispose 清理约束。
 */
function installSeamFactories(sandbox) {
  const noop = () => {};
  // app-main 的轮询协调器宿主：ESM 图经 agent-data-loader → input-actions 触达
  // poll-coordinator-host，后者在模块求值期取该工厂。本文件不驱动轮询。
  sandbox.createPollCoordinatorHost = () => ({
    run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
  });
  const falsy = () => false;
  const nil = () => null;
  sandbox.createRuntimeSwitchHost = () => ({
    state: {
      pendingSwitchTarget: null, pendingSwitchSerial: 0, navigationEpoch: 0, switchEpoch: 0,
      focusedAgentId: null, runtimeId: null, readOnlyMode: false, lastRenderedWorkspaceHtml: '',
      followLatest: false, restoredScrollTop: 0,
    },
    switchAgent: async () => {},
    setTimeout: (callback, delay) => sandbox.setTimeout(callback, delay),
    hasPendingNavigation: falsy, bumpNavigationGuard: noop, closeContextMenu: noop,
    findAgent: nil, isWorkspaceHost: falsy,
    runtimeId: (agent) => agent?.id || '', agentRuntimeId: (agent) => agent?.id || '',
    isRemote: falsy, remote: nil, closeReadOnlySession: noop, isWorkspaceSurface: falsy,
    selectWorkspace: noop, storeDraft: noop, saveWorkspaceScroll: noop, saveCache: noop,
    logicalId: (agent) => agent?.id || '', normalize: (value) => value ?? '',
    clearFinished: noop, deriveSession: nil, bindSession: noop, updateThreadIndicators: noop,
    browseOnly: falsy, resetSurface: noop, resetScroll: noop, resetStatus: noop,
    activateCollapse: noop, contextKey: nil, restoreCache: noop, setPendingScroll: noop,
    render: noop, renderPanel: noop, patch: noop,
    emptyOverview: () => ({}), emptyTodo: () => ({}),
    setFollowLatest: noop, beginFollowWindows: noop, renderAgents: noop,
  });
  sandbox.createCompactResumeHost = () => ({
    isRemote: falsy,
    remote: () => sandbox.RemoteConnections || null,
    createOperationId: (reason) => `op-${reason || 'compact'}`,
    now: () => Date.now(),
    observe: () => noop,
    checkpoint: noop,
    fetch: (...args) => sandbox.fetch(...args),
    idempotencyKey: () => 'seam-key',
    refreshThreads: noop,
  });
  sandbox.createWorkspaceSurfaceHost = () => ({
    bumpNavigationGuard: noop, closeReadOnlySession: noop, hasDetail: falsy,
    loadDetail: async () => {}, findAgent: nil, currentAgent: nil,
    preferenceKey: () => '', tabs: () => [], surfacePreference: nil,
    defaultMode: () => 'chat', ui: () => ({}), focusedAgentId: nil, runtimeId: nil,
    contextKey: () => '', saveScroll: noop, readOnlyMode: falsy, saveCache: noop,
    bindWorkspace: noop, setFollowLatest: noop, resetRuntimeState: noop,
    beginPending: noop, setTab: noop, beginLoading: noop, clearPending: noop,
    renderAgents: noop, render: noop, renderPanel: noop, refreshPanels: noop,
  });
}

/** 一个用例 = 一份 window + 一张 feature-config ESM 图。 */
function withFeatureConfig(fn, { language = 'en' } = {}) {
  return withP2EsmCase({
    label: 'feature-config',
    classic: (sandbox) => {
      // 语言初值经真实路径进入：app-core 读 localStorage 注册 i18n 桥键真初值
      sandbox.localStorage.setItem('agentdev-language', language);
      for (const file of CLASSIC_BOOTSTRAP) sandbox.loadSource(file);
      prepareSidebarDomain(sandbox);
      installSeamFactories(sandbox);
    },
  }, async (c) => {
    const fc = await c.load(FEATURE_CONFIG);
    const i18n = await c.load(I18N_STATE);
    return fn(fc, c, i18n);
  });
}

// ── normalizeFeatureConfigEntry ────────────────────────────────────

describe('feature-config: normalizeFeatureConfigEntry', () => {
  it('returns empty object for null', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeFeatureConfigEntry(null), {});
    });
  });

  it('returns empty object for arrays', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeFeatureConfigEntry([1,2]), {});
    });
  });

  it('returns empty object for primitives', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeFeatureConfigEntry("hi"), {});
    });
  });

  it('clones a valid config object', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.normalizeFeatureConfigEntry({ a: 1, b: "x" });
      assert.deepEqual(result, { a: 1, b: 'x' });
    });
  });

  it('filters out undefined values', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.normalizeFeatureConfigEntry({ a: 1, b: undefined });
      assert.deepEqual(result, { a: 1 });
    });
  });

  it('filters out empty/whitespace keys', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.normalizeFeatureConfigEntry({ "": 1, "  ": 2, valid: 3 });
      assert.deepEqual(result, { valid: 3 });
    });
  });

  it('keeps falsy values that are not undefined', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.normalizeFeatureConfigEntry({ a: 0, b: false, c: "", d: null });
      assert.deepEqual(result, { a: 0, b: false, c: '', d: null });
    });
  });
});

// ── buildFeatureConfigLookupKeys ───────────────────────────────────

describe('feature-config: buildFeatureConfigLookupKeys', () => {
  it('returns empty set for null/empty', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.buildFeatureConfigLookupKeys("").size, 0);
      assert.equal(fc.buildFeatureConfigLookupKeys(null).size, 0);
    });
  });

  it('lowercases raw input', async () => {
    await withFeatureConfig((fc) => {
      const keys = fc.buildFeatureConfigLookupKeys("Shell");
      assert.ok(keys.has('shell'));
    });
  });

  it('strips @agentdevjs/ prefix and -feature suffix', async () => {
    await withFeatureConfig((fc) => {
      const keys = fc.buildFeatureConfigLookupKeys("@agentdevjs/shell-feature");
      assert.ok(keys.has('shell'));
      assert.ok(keys.has('@agentdevjs/shell'));
      assert.ok(keys.has('@agentdevjs/shell-feature'));
    });
  });

  it('handles name without -feature suffix', async () => {
    await withFeatureConfig((fc) => {
      const keys = fc.buildFeatureConfigLookupKeys("@agentdevjs/websearch");
      assert.ok(keys.has('websearch'));
      assert.ok(keys.has('@agentdevjs/websearch'));
      assert.ok(keys.has('@agentdevjs/websearch-feature'));
    });
  });

  it('trims whitespace', async () => {
    await withFeatureConfig((fc) => {
      const keys = fc.buildFeatureConfigLookupKeys("  audit  ");
      assert.ok(keys.has('audit'));
    });
  });
});

// ── featureConfigKeyMatches ────────────────────────────────────────

describe('feature-config: featureConfigKeyMatches', () => {
  it('matches identical keys', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureConfigKeyMatches("shell", "shell"), true);
    });
  });

  it('matches with different casing', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureConfigKeyMatches("Shell", "SHELL"), true);
    });
  });

  it('matches scoped vs unscoped', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureConfigKeyMatches("@agentdevjs/shell-feature", "shell"), true);
    });
  });

  it('matches unscoped vs scoped', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureConfigKeyMatches("shell", "@agentdevjs/shell-feature"), true);
    });
  });

  it('does not match different features', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureConfigKeyMatches("shell", "audit"), false);
    });
  });

  it('returns false for empty refs', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureConfigKeyMatches("", "shell"), false);
    });
  });
});

// ── findFeatureConfigMapEntry ──────────────────────────────────────

describe('feature-config: findFeatureConfigMapEntry', () => {
  it('returns null for null configs', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.findFeatureConfigMapEntry(null, "shell"), null);
    });
  });

  it('returns null for empty key', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.findFeatureConfigMapEntry({ shell: {} }, ""), null);
    });
  });

  it('finds exact match', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.findFeatureConfigMapEntry({ shell: { enabled: true } }, "shell");
      assert.deepEqual(result, { key: 'shell', value: { enabled: true } });
    });
  });

  it('finds via alias match', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.findFeatureConfigMapEntry({ "@agentdevjs/shell-feature": { x: 1 } }, "shell");
      assert.ok(result);
      assert.equal(result.key, '@agentdevjs/shell-feature');
    });
  });

  it('returns null when no match found', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.findFeatureConfigMapEntry({ shell: {} }, "audit"), null);
    });
  });

  it('normalizes the value entry', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.findFeatureConfigMapEntry({ shell: { "": 1, valid: 2 } }, "shell");
      assert.deepEqual(result.value, { valid: 2 });
    });
  });
});

// ── removeMatchingFeatureConfigAliases ─────────────────────────────

describe('feature-config: removeMatchingFeatureConfigAliases', () => {
  it('removes alias keys that match the target', async () => {
    await withFeatureConfig((fc) => {
      var configs = { "@agentdevjs/shell-feature": { a: 1 }, "shell": { a: 1 } };
      fc.removeMatchingFeatureConfigAliases(configs, "shell");
      // "shell" is the target, alias "@agentdevjs/shell-feature" should be removed
      assert.equal("@agentdevjs/shell-feature" in configs, false);
      assert.equal("shell" in configs, true);
    });
  });

  it('keeps non-matching keys', async () => {
    await withFeatureConfig((fc) => {
      var configs2 = { shell: { a: 1 }, audit: { b: 2 } };
      fc.removeMatchingFeatureConfigAliases(configs2, "shell");
      assert.equal("audit" in configs2, true);
      assert.equal("shell" in configs2, true);
    });
  });

  it('handles null configs gracefully', async () => {
    await withFeatureConfig((fc) => {
      // Should not throw
      fc.removeMatchingFeatureConfigAliases(null, "shell");
    });
  });
});

// ── normalizeFeatureConfigMap ──────────────────────────────────────

describe('feature-config: normalizeFeatureConfigMap', () => {
  it('returns empty for null', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeFeatureConfigMap(null), {});
    });
  });

  it('normalizes all entries', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.normalizeFeatureConfigMap({ shell: { a: 1 }, audit: { b: undefined } });
      assert.deepEqual(result, { shell: { a: 1 } });
    });
  });

  it('skips empty keys', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.normalizeFeatureConfigMap({ "": { a: 1 }, valid: { b: 2 } });
      assert.deepEqual(result, { valid: { b: 2 } });
    });
  });

  it('trims keys', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.normalizeFeatureConfigMap({ "  shell  ": { a: 1 } });
      assert.deepEqual(result, { shell: { a: 1 } });
    });
  });
});

// ── resolveFeaturePackageRecord ────────────────────────────────────

describe('feature-config: resolveFeaturePackageRecord', () => {
  it('returns null for empty token', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.resolveFeaturePackageRecord([], ""), null);
    });
  });

  it('returns null for empty packages', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.resolveFeaturePackageRecord([], "shell"), null);
    });
  });

  it('finds by packageName', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.resolveFeaturePackageRecord([{ packageName: "@agentdevjs/shell-feature" }], "shell");
      assert.ok(result);
      assert.equal(result.packageName, '@agentdevjs/shell-feature');
    });
  });

  it('finds by name', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.resolveFeaturePackageRecord([{ name: "shell" }], "shell");
      assert.ok(result);
      assert.equal(result.name, 'shell');
    });
  });

  it('finds by id', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.resolveFeaturePackageRecord([{ id: "audit" }], "audit");
      assert.ok(result);
      assert.equal(result.id, 'audit');
    });
  });

  it('returns null when not found', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.resolveFeaturePackageRecord([{ name: "shell" }], "audit"), null);
    });
  });
});

// ── getFeatureManifestPropertyEntries ──────────────────────────────

describe('feature-config: getFeatureManifestPropertyEntries', () => {
  it('returns empty array for null manifest', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.getFeatureManifestPropertyEntries(null), []);
    });
  });

  it('returns empty array when no properties', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.getFeatureManifestPropertyEntries({ settings: {} }), []);
    });
  });

  it('extracts properties as entries', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.getFeatureManifestPropertyEntries({ settings: { properties: { foo: { type: "string" }, bar: { type: "boolean" } } } });
      assert.equal(result.length, 2);
    });
  });

  it('filters empty keys and non-object values', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.getFeatureManifestPropertyEntries({ settings: { properties: { "": {}, valid: null, ok: { type: "string" } } } });
      assert.equal(result.length, 1);
    });
  });
});

// ── getFeatureManifestDisplayName ──────────────────────────────────

describe('feature-config: getFeatureManifestDisplayName', () => {
  it('uses pkg.name first', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.getFeatureManifestDisplayName("tok", { name: "@agentdevjs/shell-feature" }, null), 'shell');
    });
  });

  it('falls back to manifest.featureName', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.getFeatureManifestDisplayName("tok", null, { featureName: "@agentdevjs/audit-feature" }), 'audit');
    });
  });

  it('falls back to token', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.getFeatureManifestDisplayName("websearch", null, null), 'websearch');
    });
  });

  it('returns empty for all empty', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.getFeatureManifestDisplayName("", null, {}), '');
    });
  });
});

// ── formatManifestDefaultValue ─────────────────────────────────────

describe('feature-config: formatManifestDefaultValue', () => {
  it('returns "No default" when no default property exists', async () => {
    await withFeatureConfig((fc, c, i18n) => {
      // 英文文案的前提是真实 i18n owner 的语言确实是 'en'（不是 undefined 落到英文分支）
      assert.equal(i18n.getCurrentLanguage(), 'en');
      assert.equal(fc.formatManifestDefaultValue({ type: "string" }), 'No default');
    });
  });

  it('formats boolean true', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.formatManifestDefaultValue({ type: "boolean", default: true }), 'true');
    });
  });

  it('formats boolean false', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.formatManifestDefaultValue({ type: "boolean", default: false }), 'false');
    });
  });

  it('formats directory with array default', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.formatManifestDefaultValue({ type: "directory", default: ["/a", "/b"] }), '/a, /b');
    });
  });

  it('formats directory with empty array default', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.formatManifestDefaultValue({ type: "directory", default: [] }), 'Empty');
    });
  });

  it('formats empty string default as "Empty"', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.formatManifestDefaultValue({ type: "string", default: "" }), 'Empty');
    });
  });

  it('formats number default', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.formatManifestDefaultValue({ type: "number", default: 42 }), '42');
    });
  });

  it('formats string default', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.formatManifestDefaultValue({ type: "string", default: "hello" }), 'hello');
    });
  });
});

// ── normalizeManifestComparableValue ───────────────────────────────

// ── 语言驱动的文案：en / zh 对照 ────────────────────────────────────
// 旧用例环境是 currentLanguage:'en'；本批改由真实路径播种（app-core 从
// localStorage 读 agentdev-language 注册 i18n 桥键），并断言 owner getter 的
// 真实取值——只断言英文文案无法区分「语言是 en」与「语言未初始化」。
// zh 对照片区证明这些文案确实随语言切换。

describe('feature-config: language-driven labels (en / zh)', () => {
  it('starts with the real i18n owner in English and renders English labels', async () => {
    await withFeatureConfig((fc, c, i18n) => {
      assert.equal(i18n.getCurrentLanguage(), 'en', 'i18n owner 的当前语言必须是播种的 en');
      assert.equal(fc.formatManifestDefaultValue({ type: 'string' }), 'No default');
      assert.equal(fc.formatManifestDefaultValue({ type: 'string', default: '' }), 'Empty');
      assert.equal(
        fc.getFeatureConfigStatusMeta({ settings: { properties: { foo: { type: 'string', default: 'bar' } } } }, { foo: 'baz' }).label,
        '1 override',
      );
      assert.equal(fc.getFeatureConfigStatusMeta(null, {}).label, 'Using defaults');
    }, { language: 'en' });
  });

  it('renders Chinese labels when the owner language is zh', async () => {
    await withFeatureConfig((fc, c, i18n) => {
      assert.equal(i18n.getCurrentLanguage(), 'zh');
      assert.equal(fc.formatManifestDefaultValue({ type: 'string' }), '无默认值');
      assert.equal(fc.formatManifestDefaultValue({ type: 'string', default: '' }), '空');
      assert.equal(
        fc.getFeatureConfigStatusMeta({ settings: { properties: { foo: { type: 'string', default: 'bar' } } } }, { foo: 'baz' }).label,
        '已自定义 1 项',
      );
      assert.equal(fc.getFeatureConfigStatusMeta(null, {}).label, '使用默认值');
    }, { language: 'zh' });
  });
});

describe('feature-config: normalizeManifestComparableValue', () => {
  it('normalizes number type', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.normalizeManifestComparableValue("number", "42"), 42);
      assert.equal(fc.normalizeManifestComparableValue("number", "abc"), null);
      assert.equal(fc.normalizeManifestComparableValue("number", 3.14), 3.14);
    });
  });

  it('normalizes boolean type', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.normalizeManifestComparableValue("boolean", true), true);
      assert.equal(fc.normalizeManifestComparableValue("boolean", "true"), true);
      assert.equal(fc.normalizeManifestComparableValue("boolean", 1), true);
      assert.equal(fc.normalizeManifestComparableValue("boolean", "1"), true);
      assert.equal(fc.normalizeManifestComparableValue("boolean", false), false);
      assert.equal(fc.normalizeManifestComparableValue("boolean", 0), false);
      assert.equal(fc.normalizeManifestComparableValue("boolean", "no"), false);
    });
  });

  it('normalizes directory type with sorted join', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.normalizeManifestComparableValue("directory", ["/b", "/a"]), '/a|/b');
      assert.equal(fc.normalizeManifestComparableValue("directory", []), '');
      assert.equal(fc.normalizeManifestComparableValue("directory", "not-array"), '');
    });
  });

  it('normalizes file type with sorted join', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.normalizeManifestComparableValue("file", ["z.txt", "a.txt"]), 'a.txt|z.txt');
    });
  });

  it('normalizes string type (trimmed)', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.normalizeManifestComparableValue("string", "  hello  "), 'hello');
      assert.equal(fc.normalizeManifestComparableValue("string", null), '');
    });
  });
});

// ── getFeatureConfigStatusMeta ─────────────────────────────────────

describe('feature-config: getFeatureConfigStatusMeta', () => {
  it('returns zero overrides when config matches defaults', async () => {
    await withFeatureConfig((fc) => {
      const manifest = { settings: { properties: { foo: { type: 'string', default: 'bar' } } } };
      const config = { foo: 'bar' };
      const result = fc.getFeatureConfigStatusMeta(manifest, config);
      assert.equal(result.overriddenCount, 0);
      assert.equal(result.customized, false);
    });
  });

  it('detects override when value differs from default', async () => {
    await withFeatureConfig((fc) => {
      const manifest = { settings: { properties: { foo: { type: 'string', default: 'bar' } } } };
      const config = { foo: 'baz' };
      const result = fc.getFeatureConfigStatusMeta(manifest, config);
      assert.equal(result.overriddenCount, 1);
      assert.equal(result.customized, true);
    });
  });

  it('ignores fields not in manifest', async () => {
    await withFeatureConfig((fc) => {
      const manifest = { settings: { properties: { foo: { type: 'string', default: 'bar' } } } };
      const config = { foo: 'bar', unknown: 'x' };
      const result = fc.getFeatureConfigStatusMeta(manifest, config);
      assert.equal(result.overriddenCount, 0);
    });
  });

  it('handles empty manifest', async () => {
    await withFeatureConfig((fc) => {
      const result = fc.getFeatureConfigStatusMeta(null, { foo: 1 });
      assert.equal(result.overriddenCount, 0);
    });
  });

  it('handles empty config', async () => {
    await withFeatureConfig((fc) => {
      const manifest = { settings: { properties: { foo: { type: 'string', default: 'bar' } } } };
      const result = fc.getFeatureConfigStatusMeta(manifest, {});
      assert.equal(result.overriddenCount, 0);
    });
  });
});

// ── coerceFeatureManifestValue ─────────────────────────────────────

describe('feature-config: coerceFeatureManifestValue', () => {
  it('coerces boolean', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.coerceFeatureManifestValue("boolean", true), true);
      assert.equal(fc.coerceFeatureManifestValue("boolean", ""), false);
      assert.equal(fc.coerceFeatureManifestValue("boolean", "anything"), true);
    });
  });

  it('coerces number', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.coerceFeatureManifestValue("number", "42"), 42);
      assert.equal(fc.coerceFeatureManifestValue("number", ""), undefined);
      assert.equal(fc.coerceFeatureManifestValue("number", "abc"), undefined);
    });
  });

  it('coerces directory from array', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.coerceFeatureManifestValue("directory", ["/a", "", "/b"]), ['/a', '/b']);
    });
  });

  it('coerces directory from string', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.coerceFeatureManifestValue("directory", "/path"), ['/path']);
      assert.deepEqual(fc.coerceFeatureManifestValue("directory", ""), []);
    });
  });

  it('coerces file from array', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.coerceFeatureManifestValue("file", ["a.txt", "", "b.txt"]), ['a.txt', 'b.txt']);
    });
  });

  it('coerces string (trimmed)', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.coerceFeatureManifestValue("string", "  hello  "), 'hello');
      assert.equal(fc.coerceFeatureManifestValue("string", ""), undefined);
    });
  });
});

// ── parseInlineDataValue ───────────────────────────────────────────

describe('feature-config: parseInlineDataValue', () => {
  it('returns empty string for null', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.parseInlineDataValue(null), '');
    });
  });

  it('parses JSON', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.parseInlineDataValue('["a","b"]'), ['a', 'b']);
    });
  });

  it('returns raw string when JSON parse fails', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.parseInlineDataValue("not-json"), 'not-json');
    });
  });

  it('parses number string', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.parseInlineDataValue("42"), 42);
    });
  });
});

// ── normalizeAcceptList ────────────────────────────────────────────

describe('feature-config: normalizeAcceptList', () => {
  it('handles string input', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeAcceptList(".ts"), ['.ts']);
    });
  });

  it('handles comma-separated string', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeAcceptList(".ts, .js, .json"), ['.ts', '.js', '.json']);
    });
  });

  it('handles array input', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeAcceptList([".ts", ".js"]), ['.ts', '.js']);
    });
  });

  it('lowercases and trims', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeAcceptList([" .TS "]), ['.ts']);
    });
  });

  it('filters empty values', async () => {
    await withFeatureConfig((fc) => {
      assert.deepEqual(fc.normalizeAcceptList(["", ".ts", ""]), ['.ts']);
    });
  });
});

// ── matchesFeatureConfigAccept ─────────────────────────────────────

describe('feature-config: matchesFeatureConfigAccept', () => {
  it('matches extension rules', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.matchesFeatureConfigAccept("file.ts", ".ts"), true);
      assert.equal(fc.matchesFeatureConfigAccept("file.js", ".ts"), false);
    });
  });

  it('matches audio/* wildcard', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.matchesFeatureConfigAccept("song.mp3", "audio/*"), true);
      assert.equal(fc.matchesFeatureConfigAccept("song.wav", "audio/*"), true);
      assert.equal(fc.matchesFeatureConfigAccept("doc.pdf", "audio/*"), false);
    });
  });

  it('matches MIME types', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.matchesFeatureConfigAccept("image.png", "image/png"), true);
    });
  });

  it('returns true when accept list is empty', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.matchesFeatureConfigAccept("file.ts", []), true);
    });
  });

  it('returns true when path is empty', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.matchesFeatureConfigAccept("", ".ts"), true);
    });
  });
});

// ── featureControlDomId ────────────────────────────────────────────

describe('feature-config: featureControlDomId', () => {
  it('generates prefixed DOM id', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureControlDomId("shell", "enabled"), 'fw-manifest-shell__enabled');
    });
  });

  it('includes suffix when provided', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureControlDomId("shell", "port", "range"), 'fw-manifest-shell__port__range');
    });
  });

  it('replaces special characters with dashes', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureControlDomId("@agentdevjs/shell-feature", "my.field"), 'fw-manifest--agentdevjs-shell-feature__my-field');
    });
  });

  it('handles empty inputs', async () => {
    await withFeatureConfig((fc) => {
      assert.equal(fc.featureControlDomId("", ""), 'fw-manifest-__');
    });
  });
});
