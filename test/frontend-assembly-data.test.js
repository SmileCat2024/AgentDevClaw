/**
 * Tests for public/src/modules/assembly-data.js
 *
 * Covers pure functions:
 *   - Session type checks (isAssemblySession, isAssemblySessionRunning)
 *   - Path/name sanitization (sanitizeWorkspacePathFragment, isValid*Name,
 *     normalizeAssemblyDirectoryToken)
 *   - Project key building (buildWorkspaceProjectKey)
 *   - Draft normalization (normalizeAssemblyDraft, getAssemblyDisplayName,
 *     getAssemblyEditorMode)
 *   - Environment state (getAssemblyEnvironmentState, status label/tone)
 *   - Output directory resolution (getFeatureCreatorOutputDirectory,
 *     getAgentCreatorOutputDirectory, getExpectedAssemblyEnvDir)
 *   - Status chip rendering (renderAssemblyStatusChip)
 *
 * 装载路线（ESM 迁移配方第三节）：assembly-data 已迁 ESM，用例一律真实
 * `import`（withP2EsmCase 的 c.load，每个用例整图隔离），断言直接打命名导出。
 * classic 相只保留生产里仍是 classic 的部分：动作分发器（markdown-utils 顶层
 * 注册动作）、markdown-bootstrap 的 escapeHtml / renderer 桥键，以及本模块
 * 静态依赖链读到的 bootstrap 状态宿主（契约桩，真实实现留在 app-core /
 * app-main / sidebar-render）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const ASSEMBLY_DATA = 'public/src/modules/assembly-data.js';

/**
 * assembly-data 的静态依赖链（workspace-blocks / assembly-actions / agent-* /
 * runtime-* / sidebar-*）在求值时向 window 取 bootstrap 状态宿主。按各宿主契约
 * 给最小可读写面；真实实现留在 app-core / app-main / sidebar-render（classic，
 * 首屏同步边界）。状态语义本身不在本文件断言范围内。
 */
function createBootstrapHosts() {
  // ph-session 宿主用成对 get/set 复刻 app-core 的 Object.freeze 槽位语义。
  const phSessionState = { phSessionSortMode: 'updatedAt', phSearchQuery: '', _phSearchTimer: null };
  return {
    createP2BootstrapAssemblyHost: () => ({
      assemblyControlPanelOpen: false,
      assemblyDraftRenderTimer: null,
      assemblyLaunchInProgress: false,
      assemblySideRailRevealTimer: null,
    }),
    createP2BootstrapDebugPanelHost: () => ({
      currentLogs: [],
      currentLogsSignature: '',
      currentLogsTruncation: null,
      logFilters: {},
      currentMcpInfo: null,
      selectedOverviewLifecycle: 'StepFinish',
      selectedFeatureName: null,
      selectedRepositoryPackageId: null,
      repoSearchQuery: '',
      repoSourceFilter: 'all',
    }),
    // 调用活跃态与预构建会话切换的 classic 槽位（真实实现是 app-core 的
    // Object.freeze 宿主：Map/Set 只读引用 + 成对 get/set；此处按契约给最小面）。
    createP2BootstrapCallActivityHost: () => ({
      _agentCallActive: new Map(),
      _recentlyFinishedRuntimes: new Set(),
      _seenChoiceAlertIds: new Set(),
      _autoTitleTriggered: new Set(),
      _lastInterruptUserActionAt: 0,
    }),
    createP2BootstrapSessionSwitchHost: () => ({
      templateWarmupToken: null,
      prebuiltSessionSwitchInFlight: false,
    }),
    createP2BootstrapPhSessionHost: () => ({
      get phSessionSortMode() { return phSessionState.phSessionSortMode; },
      set phSessionSortMode(value) { phSessionState.phSessionSortMode = value; },
      get phSearchQuery() { return phSessionState.phSearchQuery; },
      set phSearchQuery(value) { phSessionState.phSearchQuery = value; },
      get _phSearchTimer() { return phSessionState._phSearchTimer; },
      set _phSearchTimer(value) { phSessionState._phSearchTimer = value; },
      savedPhTabState: {},
    }),
    createP2BootstrapSidebarHost: () => ({
      restartingRuntimeIds: new Set(),
      suppressSidebarRerender: false,
    }),
    createP2BootstrapSidebarRenderHost: () => ({ lastAgentListRenderSignature: '' }),
    // 跨批静态边（P2 输入面）：agent-data-loader → input-actions → p2-bootstrap-dom /
    // poll-coordinator-host。两个 classic 工厂的真实实现分别是 app-core 的 DOM 引用
    // 与 app-main 的轮询协调器宿主；本文件只跑装配数据纯函数，按契约给最小面。
    createP2BootstrapDomHost: () => ({ container: {}, ctxMenu: {}, compactContextMenu: {}, agentContextMenu: {}, projectContextMenu: {}, featureRepoContextMenu: {} }),
    createPollCoordinatorHost: () => ({
      run: async () => {}, fastInterval: () => 1000, setTimeout: () => 0, clearTimeout: () => {},
    }),
    AgentLoaderHost: { loadedAgentDetailIds: new Set() },
    createCallInterruptHost: () => ({ pending: new Map(), now: () => 0 }),
    createSessionViewCommitHost: () => ({
      identity: () => null, read: () => ({}), apply() {}, normalizeModel: (value) => value || {},
    }),
    createRuntimeViewCacheHost: () => ({
      cache: new Map(), capacity: 20, contextKey: () => '', readView: () => ({}), signatures: () => ({}),
      todoSignature: (plan) => JSON.stringify(plan || {}), emptyTodo: () => ({}), followLatest: () => false,
      captureAnchor: () => null, scrollTop: () => 0, activeCollapseContext: () => '',
      forgetContext() {}, activateCollapse() {}, normalizeIdentity: (identity) => identity, patch() {},
      setRestoredScrollTop() {}, restoreAnchor() {}, updatePlanBadge() {},
    }),
    createAgentCallStatesHost: () => ({
      calling: new Map(), suspended: new Set(), interrupting: new Map(), finished: new Set(),
      agents: () => [], currentRuntimeId: () => null, runtimeId: () => '', remoteEntries: () => [],
      normalize: (value) => value, resolveCalling: () => false, isSuspended: () => false,
      markStarted() {}, syncActionButton() {}, isSseActive: () => false, isRemote: () => false,
      fetch: (...args) => globalThis.fetch(...args), now: () => 0, lastRefresh: () => 0,
      setLastRefresh() {}, render() {},
    }),
    createSessionDataLoaderHost: () => ({ now: () => 0, warn() {} }),
    createRuntimeStatusLoaderHost: () => ({ now: () => 0, warn() {} }),
    createAgentSnapshotLoaderHost: () => ({
      state: {}, detailIds: new Set(), now: () => 0, captureToken: () => null, isTokenCurrent: () => true,
      ownership: () => ({}), connected: async () => [],
      viewer: async () => ({ ok: false, json: async () => ({ agents: [] }) }),
      loadLayout: async () => {}, loadProjects: async () => {}, schedule: () => {}, diagnostic() {},
      runtimeId: (agent) => agent?.id || '', agentRuntimeId: (agent) => agent?.id || '',
      logicalId: (agent) => agent?.id || '', mergeSessions: (previous) => previous,
      reconcileStops() {}, pruneCallStates() {}, renderList() {}, renderPanel() {}, refreshCalls() {},
      isRemote: () => false, fallback: () => null, loadDetail: async () => {}, selectSurface() {},
      preferHome() {}, resolveFocus: () => null, clickPrebuilt() {}, loadData: async () => {},
      warn() {}, error() {}, log() {},
    }),
    createRuntimeSwitchHost: () => ({
      state: {}, now: () => 0, warn() {}, setSurface() {}, renderPanel() {}, renderList() {},
      renderCurrentMainView() {}, beginLoading() {}, clearLoading() {}, navigate() {},
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timerId) => clearTimeout(timerId),
      switchAgent: () => Promise.resolve(),
    }),
    createWorkspaceSurfaceHost: () => ({
      state: {}, now: () => 0, warn() {}, renderPanel() {}, renderList() {}, renderCurrentMainView() {},
      saveScroll() {}, applyPatch() {}, setFollowLatest() {}, resetSurface() {},
      beginNavigation() {}, clearNavigation() {}, beginLoading() {}, clearLoading() {},
    }),
  };
}

/** classic 相：真实 classic 源（动作分发器、markdown 桥键）+ 宿主契约桩。 */
function loadClassicBootstrap(sandbox) {
  sandbox.loadSource('public/src/modules/action-dispatcher.js');
  // markdown-bootstrap 是 escapeHtml / renderer 桥键的唯一 classic 实现，
  // 装载它需要 marked Renderer 与 hljs 面（真实库在 index.html 里先于它加载）。
  sandbox.marked = { Renderer: class { constructor() {} }, setOptions() {} };
  sandbox.hljs = { getLanguage: () => null, highlight: () => ({ value: '' }) };
  sandbox.loadSource('public/src/modules/markdown-bootstrap.js');
  Object.assign(sandbox, createBootstrapHosts());
}

/** 一个用例 = 一份沙箱 + 一张 ESM 图；回调收到真实模块命名空间。 */
function withAssemblyData(fn) {
  return withP2EsmCase({ classic: loadClassicBootstrap }, async (c) => fn(await c.load(ASSEMBLY_DATA)));
}

// ── isAssemblySession ──────────────────────────────────────────────

describe('assembly-data: isAssemblySession', () => {
  it('returns true when formId is assembly-form', async () => {
    await withAssemblyData(({ isAssemblySession }) => {
      assert.equal(isAssemblySession({ formId: 'assembly-form' }), true);
    });
  });

  it('returns false for other formId', async () => {
    await withAssemblyData(({ isAssemblySession }) => {
      assert.equal(isAssemblySession({ formId: 'startup-form' }), false);
    });
  });

  it('returns false for null session', async () => {
    await withAssemblyData(({ isAssemblySession }) => {
      assert.equal(isAssemblySession(null), false);
    });
  });

  it('returns false for session without formId', async () => {
    await withAssemblyData(({ isAssemblySession }) => {
      assert.equal(isAssemblySession({}), false);
    });
  });
});

// ── isAssemblySessionRunning ───────────────────────────────────────

describe('assembly-data: isAssemblySessionRunning', () => {
  it('returns false for null agent', async () => {
    await withAssemblyData(({ isAssemblySessionRunning }) => {
      assert.equal(isAssemblySessionRunning(null, { formId: 'assembly-form', id: 's1' }), false);
    });
  });

  it('returns false for non-assembly session', async () => {
    await withAssemblyData(({ isAssemblySessionRunning }) => {
      assert.equal(isAssemblySessionRunning({}, { formId: 'startup-form', id: 's1' }), false);
    });
  });

  it('returns true when session is active and runtime exists', async () => {
    await withAssemblyData(({ isAssemblySessionRunning }) => {
      const agent = { active_workspace_session_id: 's1', runtime_session_id: 'rt-1' };
      const session = { formId: 'assembly-form', id: 's1' };
      assert.equal(isAssemblySessionRunning(agent, session), true);
    });
  });

  it('returns false when session id does not match active', async () => {
    await withAssemblyData(({ isAssemblySessionRunning }) => {
      const agent = { active_workspace_session_id: 's2', runtime_session_id: 'rt-1' };
      const session = { formId: 'assembly-form', id: 's1' };
      assert.equal(isAssemblySessionRunning(agent, session), false);
    });
  });
});

// ── buildWorkspaceProjectKey ───────────────────────────────────────

describe('assembly-data: buildWorkspaceProjectKey', () => {
  it('uses openDirectory when present', async () => {
    await withAssemblyData(({ buildWorkspaceProjectKey }) => {
      assert.equal(buildWorkspaceProjectKey({ openDirectory: 'D:\\code' }), 'dir:d:/code');
    });
  });

  it('lowercases and normalizes backslashes', async () => {
    await withAssemblyData(({ buildWorkspaceProjectKey }) => {
      assert.equal(buildWorkspaceProjectKey({ openDirectory: 'D:\\Code\\Test' }), 'dir:d:/code/test');
    });
  });

  it('uses feature+targetDir when no openDirectory', async () => {
    await withAssemblyData(({ buildWorkspaceProjectKey }) => {
      assert.equal(buildWorkspaceProjectKey({ featureName: 'MyFeature', targetDir: 'D:\\out' }), 'feature:myfeature@d:/out');
    });
  });

  it('uses feature only when no targetDir', async () => {
    await withAssemblyData(({ buildWorkspaceProjectKey }) => {
      assert.equal(buildWorkspaceProjectKey({ featureName: 'Shell' }), 'feature:shell');
    });
  });

  it('returns empty string for empty source', async () => {
    await withAssemblyData(({ buildWorkspaceProjectKey }) => {
      assert.equal(buildWorkspaceProjectKey({}), '');
      assert.equal(buildWorkspaceProjectKey(), '');
    });
  });
});

// ── sanitizeWorkspacePathFragment ──────────────────────────────────

describe('assembly-data: sanitizeWorkspacePathFragment', () => {
  it('lowercases and replaces special chars with dashes', async () => {
    await withAssemblyData(({ sanitizeWorkspacePathFragment }) => {
      assert.equal(sanitizeWorkspacePathFragment('My Feature@Name'), 'my-feature-name');
    });
  });

  it('collapses consecutive dashes', async () => {
    await withAssemblyData(({ sanitizeWorkspacePathFragment }) => {
      assert.equal(sanitizeWorkspacePathFragment('a---b'), 'a-b');
    });
  });

  it('trims leading/trailing dashes', async () => {
    await withAssemblyData(({ sanitizeWorkspacePathFragment }) => {
      assert.equal(sanitizeWorkspacePathFragment('---hello---'), 'hello');
    });
  });

  it('allows underscores and hyphens', async () => {
    await withAssemblyData(({ sanitizeWorkspacePathFragment }) => {
      assert.equal(sanitizeWorkspacePathFragment('my_feature-name'), 'my_feature-name');
    });
  });

  it('returns "untitled-feature" for empty/all-special input', async () => {
    await withAssemblyData(({ sanitizeWorkspacePathFragment }) => {
      assert.equal(sanitizeWorkspacePathFragment(''), 'untitled-feature');
      assert.equal(sanitizeWorkspacePathFragment('@@@'), 'untitled-feature');
    });
  });

  it('handles null/undefined', async () => {
    await withAssemblyData(({ sanitizeWorkspacePathFragment }) => {
      assert.equal(sanitizeWorkspacePathFragment(null), 'untitled-feature');
    });
  });
});

// ── isValidFeatureCreatorName / isValidAgentCreatorName ────────────

describe('assembly-data: name validators', () => {
  it('accepts valid kebab-case names', async () => {
    await withAssemblyData(({ isValidFeatureCreatorName, isValidAgentCreatorName }) => {
      assert.equal(isValidFeatureCreatorName('my-feature'), true);
      assert.equal(isValidFeatureCreatorName('shell'), true);
      assert.equal(isValidAgentCreatorName('my-agent'), true);
    });
  });

  it('rejects uppercase', async () => {
    await withAssemblyData(({ isValidFeatureCreatorName }) => {
      assert.equal(isValidFeatureCreatorName('MyFeature'), false);
    });
  });

  it('rejects starting with number', async () => {
    await withAssemblyData(({ isValidFeatureCreatorName }) => {
      assert.equal(isValidFeatureCreatorName('2nd-feature'), false);
    });
  });

  it('rejects empty', async () => {
    await withAssemblyData(({ isValidFeatureCreatorName }) => {
      assert.equal(isValidFeatureCreatorName(''), false);
      assert.equal(isValidFeatureCreatorName(null), false);
    });
  });

  it('rejects trailing dash', async () => {
    await withAssemblyData(({ isValidFeatureCreatorName }) => {
      assert.equal(isValidFeatureCreatorName('feature-'), false);
    });
  });

  it('rejects double dash', async () => {
    await withAssemblyData(({ isValidFeatureCreatorName }) => {
      assert.equal(isValidFeatureCreatorName('feature--name'), false);
    });
  });
});

// ── normalizeAssemblyDirectoryToken ────────────────────────────────

describe('assembly-data: normalizeAssemblyDirectoryToken', () => {
  it('normalizes slashes', async () => {
    await withAssemblyData(({ normalizeAssemblyDirectoryToken }) => {
      assert.equal(normalizeAssemblyDirectoryToken('D:\\code\\test'), 'd:/code/test');
    });
  });

  it('lowercases', async () => {
    await withAssemblyData(({ normalizeAssemblyDirectoryToken }) => {
      assert.equal(normalizeAssemblyDirectoryToken('D:/Code/Test'), 'd:/code/test');
    });
  });

  it('collapses multiple slashes', async () => {
    await withAssemblyData(({ normalizeAssemblyDirectoryToken }) => {
      assert.equal(normalizeAssemblyDirectoryToken('D:////Code'), 'd:/code');
    });
  });

  it('trims', async () => {
    await withAssemblyData(({ normalizeAssemblyDirectoryToken }) => {
      assert.equal(normalizeAssemblyDirectoryToken('  D:/Code  '), 'd:/code');
    });
  });

  it('handles null', async () => {
    await withAssemblyData(({ normalizeAssemblyDirectoryToken }) => {
      assert.equal(normalizeAssemblyDirectoryToken(null), '');
    });
  });
});

// ── normalizeAssemblyDraft ─────────────────────────────────────────

describe('assembly-data: normalizeAssemblyDraft', () => {
  it('ensures all string fields default to empty string', async () => {
    await withAssemblyData(({ normalizeAssemblyDraft }) => {
      const result = normalizeAssemblyDraft({});
      assert.equal(result.assembly_name, '');
      assert.equal(result.display_name, '');
      assert.equal(result.env_dir, '');
      assert.equal(result.env_status, '');
    });
  });

  it('normalizes env_created to "1" or "0"', async () => {
    await withAssemblyData(({ normalizeAssemblyDraft }) => {
      assert.equal(normalizeAssemblyDraft({ env_created: '1' }).env_created, '1');
      assert.equal(normalizeAssemblyDraft({ env_created: 1 }).env_created, '1');
      assert.equal(normalizeAssemblyDraft({ env_created: false }).env_created, '0');
      assert.equal(normalizeAssemblyDraft({}).env_created, '0');
    });
  });

  it('preserves existing string values', async () => {
    await withAssemblyData(({ normalizeAssemblyDraft }) => {
      const result = normalizeAssemblyDraft({ assembly_name: 'test', env_dir: '/path' });
      assert.equal(result.assembly_name, 'test');
      assert.equal(result.env_dir, '/path');
    });
  });

  it('coerces non-string fields to empty string', async () => {
    await withAssemblyData(({ normalizeAssemblyDraft }) => {
      const result = normalizeAssemblyDraft({ assembly_name: 123 });
      assert.equal(result.assembly_name, '');
    });
  });
});

// ── getAssemblyDisplayName ─────────────────────────────────────────

describe('assembly-data: getAssemblyDisplayName', () => {
  it('uses display_name when present', async () => {
    await withAssemblyData(({ getAssemblyDisplayName }) => {
      assert.equal(getAssemblyDisplayName({ display_name: 'My Agent', assembly_name: 'agent' }), 'My Agent');
    });
  });

  it('falls back to assembly_name', async () => {
    await withAssemblyData(({ getAssemblyDisplayName }) => {
      assert.equal(getAssemblyDisplayName({ assembly_name: 'agent' }), 'agent');
    });
  });

  it('returns empty for empty draft', async () => {
    await withAssemblyData(({ getAssemblyDisplayName }) => {
      assert.equal(getAssemblyDisplayName({}), '');
    });
  });
});

// ── getAssemblyEditorMode ──────────────────────────────────────────

describe('assembly-data: getAssemblyEditorMode', () => {
  it('returns "blank" for empty draft', async () => {
    await withAssemblyData(({ getAssemblyEditorMode }) => {
      assert.equal(getAssemblyEditorMode({}), 'blank');
    });
  });

  it('returns "creating" when assembly_name is set but no saved setup', async () => {
    await withAssemblyData(({ getAssemblyEditorMode }) => {
      assert.equal(getAssemblyEditorMode({ assembly_name: 'test' }), 'creating');
    });
  });

  it('returns "editing-saved" when savedSetupExists and name is set', async () => {
    await withAssemblyData(({ getAssemblyEditorMode }) => {
      assert.equal(getAssemblyEditorMode({ assembly_name: 'test' }, true), 'editing-saved');
    });
  });

  it('returns "blank" when name is empty even with savedSetupExists', async () => {
    await withAssemblyData(({ getAssemblyEditorMode }) => {
      assert.equal(getAssemblyEditorMode({}, true), 'blank');
    });
  });
});

// ── getAssemblyEnvironmentState ────────────────────────────────────

describe('assembly-data: getAssemblyEnvironmentState', () => {
  it('returns missing-name when no assembly name', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentState }) => {
      const result = getAssemblyEnvironmentState({});
      assert.equal(result.status, 'missing-name');
      assert.equal(result.needsConfiguration, true);
    });
  });

  it('returns missing when name set but no env config', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentState }) => {
      const result = getAssemblyEnvironmentState({ assembly_name: 'test' });
      assert.equal(result.status, 'missing');
      assert.equal(result.needsConfiguration, true);
      assert.equal(result.isReady, false);
    });
  });

  it('returns ready when env_dir is set', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentState }) => {
      const result = getAssemblyEnvironmentState({ assembly_name: 'test', env_dir: '~/.agentdev/agent-dev/test' });
      assert.equal(result.status, 'ready');
      assert.equal(result.isReady, true);
      assert.equal(result.needsConfiguration, false);
    });
  });

  it('returns ready when env_created is "1"', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentState }) => {
      const result = getAssemblyEnvironmentState({ assembly_name: 'test', env_created: '1' });
      assert.equal(result.status, 'ready');
    });
  });

  it('detects stale when configured name differs from assembly name', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentState }) => {
      const result = getAssemblyEnvironmentState({
        assembly_name: 'new',
        env_configured_name: 'old',
        env_dir: '~/.agentdev/agent-dev/old',
      });
      assert.equal(result.status, 'stale');
      assert.equal(result.stale, true);
    });
  });

  it('computes expectedDir from assembly name', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentState }) => {
      const result = getAssemblyEnvironmentState({ assembly_name: 'myagent' });
      assert.equal(result.expectedDir, '~/.agentdev/agent-dev/myagent');
    });
  });

  it('detects feature stale when selected features differ from configured', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentState }) => {
      const result = getAssemblyEnvironmentState({
        assembly_name: 'test',
        env_created: '1',
        selected_features: 'shell, audit',
        env_configured_features: 'shell',
      });
      assert.equal(result.status, 'stale');
    });
  });
});

// ── getAssemblyEnvironmentStatusLabel ──────────────────────────────

describe('assembly-data: getAssemblyEnvironmentStatusLabel', () => {
  it('returns label for each known status', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentStatusLabel }) => {
      const statuses = ['missing-name', 'missing', 'stale', 'creating', 'installing', 'starting', 'running', 'ready', 'error'];
      for (const status of statuses) {
        const label = getAssemblyEnvironmentStatusLabel(status);
        assert.ok(typeof label === 'string' && label.length > 0, `Expected non-empty label for ${status}`);
      }
    });
  });

  it('returns default label for unknown status', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentStatusLabel }) => {
      const label = getAssemblyEnvironmentStatusLabel('unknown');
      assert.ok(label.length > 0);
    });
  });
});

// ── getAssemblyEnvironmentStatusTone ───────────────────────────────

describe('assembly-data: getAssemblyEnvironmentStatusTone', () => {
  it('returns success tone for ready/running', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentStatusTone }) => {
      assert.equal(getAssemblyEnvironmentStatusTone('ready'), 'var(--success-color)');
      assert.equal(getAssemblyEnvironmentStatusTone('running'), 'var(--success-color)');
    });
  });

  it('returns warning tone for transient states', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentStatusTone }) => {
      assert.equal(getAssemblyEnvironmentStatusTone('creating'), 'var(--warning-color)');
      assert.equal(getAssemblyEnvironmentStatusTone('installing'), 'var(--warning-color)');
      assert.equal(getAssemblyEnvironmentStatusTone('starting'), 'var(--warning-color)');
    });
  });

  it('returns error tone for error/stale', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentStatusTone }) => {
      assert.equal(getAssemblyEnvironmentStatusTone('error'), 'var(--error-color)');
      assert.equal(getAssemblyEnvironmentStatusTone('stale'), 'var(--error-color)');
    });
  });

  it('returns default tone for unknown', async () => {
    await withAssemblyData(({ getAssemblyEnvironmentStatusTone }) => {
      assert.equal(getAssemblyEnvironmentStatusTone('unknown'), 'var(--text-secondary)');
    });
  });
});

// ── getExpectedAssemblyEnvDir ──────────────────────────────────────

describe('assembly-data: getExpectedAssemblyEnvDir', () => {
  it('builds path from name', async () => {
    await withAssemblyData(({ getExpectedAssemblyEnvDir }) => {
      assert.equal(getExpectedAssemblyEnvDir('myagent'), '~/.agentdev/agent-dev/myagent');
    });
  });

  it('returns empty for empty name', async () => {
    await withAssemblyData(({ getExpectedAssemblyEnvDir }) => {
      assert.equal(getExpectedAssemblyEnvDir(''), '');
      assert.equal(getExpectedAssemblyEnvDir(null), '');
    });
  });

  it('trims input', async () => {
    await withAssemblyData(({ getExpectedAssemblyEnvDir }) => {
      assert.equal(getExpectedAssemblyEnvDir('  agent  '), '~/.agentdev/agent-dev/agent');
    });
  });
});

// ── getFeatureCreatorOutputDirectory / getAgentCreatorOutputDirectory ─

describe('assembly-data: output directory resolution', () => {
  it('returns path for feature-creator', async () => {
    await withAssemblyData(({ getFeatureCreatorOutputDirectory }) => {
      assert.equal(
        getFeatureCreatorOutputDirectory({ id: 'feature-creator' }, { feature_name: 'my-feat', target_dir: 'D:\\code' }),
        'D:\\code\\my-feat',
      );
    });
  });

  it('returns empty for non feature-creator agent', async () => {
    await withAssemblyData(({ getFeatureCreatorOutputDirectory }) => {
      assert.equal(getFeatureCreatorOutputDirectory({ id: 'agent-creator' }, { feature_name: 'x' }), '');
    });
  });

  it('returns empty when missing feature_name', async () => {
    await withAssemblyData(({ getFeatureCreatorOutputDirectory }) => {
      assert.equal(getFeatureCreatorOutputDirectory({ id: 'feature-creator' }, { target_dir: 'D:\\code' }), '');
    });
  });

  it('returns empty when missing target_dir', async () => {
    await withAssemblyData(({ getFeatureCreatorOutputDirectory }) => {
      assert.equal(getFeatureCreatorOutputDirectory({ id: 'feature-creator' }, { feature_name: 'x' }), '');
    });
  });

  it('strips trailing slashes from parent dir', async () => {
    await withAssemblyData(({ getFeatureCreatorOutputDirectory }) => {
      assert.equal(
        getFeatureCreatorOutputDirectory({ id: 'feature-creator' }, { feature_name: 'x', target_dir: 'D:\\code\\' }),
        'D:\\code\\x',
      );
    });
  });

  it('returns path for agent-creator', async () => {
    await withAssemblyData(({ getAgentCreatorOutputDirectory }) => {
      assert.equal(
        getAgentCreatorOutputDirectory({ id: 'agent-creator' }, { agent_name: 'my-bot', target_dir: 'D:\\out' }),
        'D:\\out\\my-bot',
      );
    });
  });

  it('returns empty for non agent-creator', async () => {
    await withAssemblyData(({ getAgentCreatorOutputDirectory }) => {
      assert.equal(getAgentCreatorOutputDirectory({ id: 'feature-creator' }, { agent_name: 'x' }), '');
    });
  });
});

// ── renderAssemblyStatusChip ───────────────────────────────────────

describe('assembly-data: renderAssemblyStatusChip', () => {
  it('renders a span with label and tone', async () => {
    await withAssemblyData(({ renderAssemblyStatusChip }) => {
      const html = renderAssemblyStatusChip('Running', 'var(--success-color)');
      assert.ok(html.includes('assembly-status-chip'));
      assert.ok(html.includes('Running'));
      assert.ok(html.includes('var(--success-color)'));
    });
  });

  it('uses default tone when not provided', async () => {
    await withAssemblyData(({ renderAssemblyStatusChip }) => {
      const html = renderAssemblyStatusChip('Label');
      assert.ok(html.includes('var(--text-secondary)'));
    });
  });

  it('escapes HTML in label', async () => {
    await withAssemblyData(({ renderAssemblyStatusChip }) => {
      // 转义来自真实 classic markdown-bootstrap 的 escapeHtml 桥键
      const html = renderAssemblyStatusChip('<script>');
      assert.ok(!html.includes('<script>'));
      assert.ok(html.includes('&lt;script&gt;'));
    });
  });
});

// ── getAssemblySessionStatus ───────────────────────────────────────

describe('assembly-data: getAssemblySessionStatus', () => {
  it('returns Running when session is running', async () => {
    await withAssemblyData(({ getAssemblySessionStatus }) => {
      const agent = { active_workspace_session_id: 's1', runtime_session_id: 'rt' };
      const session = { formId: 'assembly-form', id: 's1' };
      const result = getAssemblySessionStatus(agent, session);
      assert.equal(result.tone, 'var(--success-color)');
    });
  });

  it('returns Saved Session when not running', async () => {
    await withAssemblyData(({ getAssemblySessionStatus }) => {
      const result = getAssemblySessionStatus({}, { formId: 'assembly-form', id: 's1' });
      assert.equal(result.tone, 'var(--text-secondary)');
    });
  });
});
