/**
 * Tests for public/src/modules/session-ui.js
 *
 * Covers pure and near-pure functions:
 *   - isCompactedResumeSession (session metadata check)
 *   - getWorkspaceSessions / getWorkspaceSessionById (session lookup)
 *   - sortPhSessionsByMode (TODO-priority + date sorting)
 *   - getSessionContextLength / getSessionCompressRatio (config fallback)
 *   - renderSessionArchivedBadge / renderSessionTodoBadge / renderSessionResumeBadge (badges)
 *   - renderSessionTitleAiButton (AI button HTML)
 *   - renderSessionTokenBar (token usage bar)
 *
 * 装载路线（P2 测试改造）：session-ui 已迁 ESM，经 withP2EsmCase 真实 import
 * （每 case 整图隔离，模块私有 _modelInfoCache 不跨用例）；classic 侧按真实
 * 加载序先载 action-dispatcher / app-core / session-view-state / runtime-status
 * / sidebar-render——session-ui 的 import 图在模块顶层经 window 上的 classic
 * 工厂（createAgentSnapshotLoaderHost / createP2BootstrapSidebarHost /
 * createP2BootstrapPhSessionHost …）取宿主面，这正是生产装载顺序；已迁 ESM 的
 * agent-data-loader（host 工厂）按依赖顺序先经真实 import 装载。
 * 语言与排序偏好经真实桥与 classic 工厂赋值（不复制状态）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deepEqual as deepLoose } from 'node:assert';
import { withP2EsmCase } from './helpers/p2-esm-case.js';

const SESSION_UI = 'public/src/modules/session-ui.js';

/** classic 真实加载序（session-ui import 图的宿主工厂来源）。 */
const CLASSIC_STACK = [
  'public/src/modules/action-dispatcher.js',
  'public/src/app-core.js',
  'public/src/modules/session-view-state.js',
  'public/src/modules/runtime-status.js',
  'public/src/modules/sidebar-render.js',
];

/**
 * 在独立 case 内装载真实 session-ui 图并在 case 存续期间求值。
 * @param {{language?: string, sortMode?: string}} options
 * @param {(mod: object, c: object) => any} probe
 */
async function withSessionUi({ language = 'zh', sortMode = '' } = {}, probe) {
  return withP2EsmCase({
    classic: (sandbox) => {
      sandbox.setInterval = () => 0;
      for (const file of CLASSIC_STACK) sandbox.loadSource(file);
      // session-ui 经 sidebar-operations → project-data 拉入的静态图在装载期取
      // classic 宿主工厂（生产由 app-ui / app-main 提供）；本文件只驱动会话列表
      // 数据面，这些能力不被触达。
      // app-core / sidebar-render 提供的 P2 引导宿主沿用真实实现（本用例的
      // phSessionSortMode 就写在其中的 createP2BootstrapPhSessionHost 上）；
      // app-ui / app-main 的四个渲染与编排宿主按契约给最小 seam。
      sandbox.createPollCoordinatorHost = () => ({});
      sandbox.createRuntimeSwitchHost = () => ({ state: {} });
      sandbox.createWorkspaceSurfaceHost = () => ({});
      sandbox.createCompactResumeHost = () => ({});
      if (language !== 'zh') sandbox.currentLanguage = language;
      if (sortMode) sandbox.createP2BootstrapPhSessionHost().phSessionSortMode = sortMode;
    },
  }, async (c) => {
    // agent-data-loader 已迁 ESM（P2 W2-4 二段）：host 工厂经 KernelState 桥
    // 供下游 loader host 模块求值期取用，必须先装载。
    await c.load('public/src/modules/agent-data-loader.js');
    const mod = await c.load(SESSION_UI);
    return probe(mod, c);
  });
}

// ── isCompactedResumeSession ────────────────────────────────

describe('session-ui: isCompactedResumeSession', () => {
  it('compacted resumeMode → true', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.isCompactedResumeSession({ metadata: { resumeMode: 'compacted' } }), true);
    });
  });

  it('non-compacted resumeMode → false', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.isCompactedResumeSession({ metadata: { resumeMode: 'trimmed' } }), false);
    });
  });

  it('no metadata → false', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.isCompactedResumeSession({}), false);
    });
  });

  it('null → false', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.isCompactedResumeSession(null), false);
    });
  });
});

// ── getWorkspaceSessions ────────────────────────────────────

describe('session-ui: getWorkspaceSessions', () => {
  it('null agent → []', async () => {
    await withSessionUi({}, (ui) => {
      deepLoose(ui.getWorkspaceSessions(null), []);
    });
  });

  it('agent with sessions → sessions array', async () => {
    await withSessionUi({}, (ui) => {
      const agent = { workspace_sessions: { sessions: [{ id: 's1' }, { id: 's2' }] } };
      const result = ui.getWorkspaceSessions(agent);
      assert.equal(result.length, 2);
      assert.equal(result[0].id, 's1');
    });
  });

  it('agent without workspace_sessions → []', async () => {
    await withSessionUi({}, (ui) => {
      deepLoose(ui.getWorkspaceSessions({ id: 'ph' }), []);
    });
  });
});

// ── getWorkspaceSessionById ─────────────────────────────────

describe('session-ui: getWorkspaceSessionById', () => {
  it('matching session → session object', async () => {
    await withSessionUi({}, (ui) => {
      const agent = { workspace_sessions: { sessions: [{ id: 's1' }, { id: 's2' }] } };
      const result = ui.getWorkspaceSessionById(agent, 's2');
      assert.equal(result.id, 's2');
    });
  });

  it('no matching session → null', async () => {
    await withSessionUi({}, (ui) => {
      const agent = { workspace_sessions: { sessions: [{ id: 's1' }] } };
      assert.equal(ui.getWorkspaceSessionById(agent, 'nonexistent'), null);
    });
  });

  it('null agent → null', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getWorkspaceSessionById(null, 's1'), null);
    });
  });
});

// ── sortPhSessionsByMode ────────────────────────────────────

describe('session-ui: sortPhSessionsByMode', () => {
  it('TODO sessions sort above non-TODO', async () => {
    await withSessionUi({}, (ui) => {
      const sessions = [
        { id: 'a', updatedAt: '2025-03-01', createdAt: '2025-01-01', todo: false },
        { id: 'b', updatedAt: '2025-01-01', createdAt: '2025-01-01', todo: true },
      ];
      const sorted = ui.sortPhSessionsByMode(sessions);
      assert.equal(sorted[0].id, 'b'); // TODO first
      assert.equal(sorted[1].id, 'a');
    });
  });

  it('updatedAt mode (default) → most recent first', async () => {
    await withSessionUi({}, (ui) => {
      const sessions = [
        { id: 'old', updatedAt: '2025-01-01', createdAt: '2025-01-01' },
        { id: 'new', updatedAt: '2025-03-01', createdAt: '2025-02-01' },
      ];
      const sorted = ui.sortPhSessionsByMode(sessions);
      assert.equal(sorted[0].id, 'new');
      assert.equal(sorted[1].id, 'old');
    });
  });

  it('createdAt mode → most recently created first', async () => {
    await withSessionUi({ sortMode: 'createdAt' }, (ui) => {
      const sessions = [
        { id: 'old', updatedAt: '2025-03-01', createdAt: '2025-01-01' },
        { id: 'new', updatedAt: '2025-01-01', createdAt: '2025-03-01' },
      ];
      const sorted = ui.sortPhSessionsByMode(sessions);
      assert.equal(sorted[0].id, 'new');
      assert.equal(sorted[1].id, 'old');
    });
  });

  it('does not mutate original array', async () => {
    await withSessionUi({}, (ui) => {
      const sessions = [
        { id: 'a', updatedAt: '2025-01-01', createdAt: '2025-01-01' },
        { id: 'b', updatedAt: '2025-03-01', createdAt: '2025-03-01' },
      ];
      ui.sortPhSessionsByMode(sessions);
      assert.equal(sessions[0].id, 'a'); // original order preserved
    });
  });
});

// ── getSessionContextLength ─────────────────────────────────

describe('session-ui: getSessionContextLength', () => {
  it('session contextLength → session value', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionContextLength({ contextLength: 128000 }, {}), 128000);
    });
  });

  it('agent fallback → agent value', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionContextLength({}, { workspace_sessions: { contextLength: 64000 } }), 64000);
    });
  });

  it('no explicit → default 200000', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionContextLength({}, {}), 200000);
    });
  });

  it('invalid session value (≤0) → fallback', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionContextLength({ contextLength: 0 }, { workspace_sessions: { contextLength: 128000 } }), 128000);
    });
  });
});

// ── getSessionCompressRatio ─────────────────────────────────

describe('session-ui: getSessionCompressRatio', () => {
  it('session compressRatio → session value', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionCompressRatio({ compressRatio: 60 }, {}), 60);
    });
  });

  it('agent fallback → agent value', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionCompressRatio({}, { workspace_sessions: { compressRatio: 70 } }), 70);
    });
  });

  it('no explicit → default 80', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionCompressRatio({}, {}), 80);
    });
  });

  it('invalid (>100) → fallback', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionCompressRatio({ compressRatio: 150 }, {}), 80);
    });
  });

  it('invalid (≤0) → fallback', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.getSessionCompressRatio({ compressRatio: -5 }, {}), 80);
    });
  });
});

// ── renderSessionArchivedBadge ──────────────────────────────

describe('session-ui: renderSessionArchivedBadge', () => {
  it('archived true (zh) → badge HTML', async () => {
    await withSessionUi({}, (ui) => {
      const result = ui.renderSessionArchivedBadge({ archived: true });
      assert.ok(result.includes('workspace-history-archived'));
      assert.ok(result.includes('已归档'));
    });
  });

  it('archived false → empty string', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.renderSessionArchivedBadge({ archived: false }), '');
    });
  });

  it('null → empty string', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.renderSessionArchivedBadge(null), '');
    });
  });

  it('archived true (en) → English label', async () => {
    await withSessionUi({ language: 'en' }, (ui) => {
      const result = ui.renderSessionArchivedBadge({ archived: true });
      assert.ok(result.includes('Archived'));
    });
  });
});

// ── renderSessionTodoBadge ──────────────────────────────────

describe('session-ui: renderSessionTodoBadge', () => {
  it('todo true (zh) → badge HTML', async () => {
    await withSessionUi({}, (ui) => {
      const result = ui.renderSessionTodoBadge({ todo: true });
      assert.ok(result.includes('workspace-history-todo'));
      assert.ok(result.includes('待办'));
    });
  });

  it('todo false → empty string', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.renderSessionTodoBadge({ todo: false }), '');
    });
  });

  it('null → empty string', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.renderSessionTodoBadge(null), '');
    });
  });
});

// ── renderSessionResumeBadge ────────────────────────────────

describe('session-ui: renderSessionResumeBadge', () => {
  it('always returns empty string', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.renderSessionResumeBadge({}), '');
      assert.equal(ui.renderSessionResumeBadge(null), '');
    });
  });
});

// ── renderSessionTitleAiButton ──────────────────────────────

describe('session-ui: renderSessionTitleAiButton', () => {
  it('(zh) → button HTML with Chinese labels', async () => {
    await withSessionUi({}, (ui) => {
      const result = ui.renderSessionTitleAiButton({ id: 's1' });
      assert.ok(result.includes('session-title-ai-btn'));
      assert.ok(result.includes('AI 生成标题'));
      assert.ok(result.includes('AI生成'));
    });
  });

  it('(en) → button HTML with English labels', async () => {
    await withSessionUi({ language: 'en' }, (ui) => {
      const result = ui.renderSessionTitleAiButton({ id: 's1' });
      assert.ok(result.includes('AI generate title'));
      assert.ok(result.includes('AI Generate'));
    });
  });

  it('includes session.id in onclick', async () => {
    await withSessionUi({}, (ui) => {
      const result = ui.renderSessionTitleAiButton({ id: 'sess-abc' });
      assert.ok(result.includes('sess-abc'));
    });
  });
});

// ── renderSessionTokenBar ───────────────────────────────────

describe('session-ui: renderSessionTokenBar', () => {
  it('no token usage → empty string', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.renderSessionTokenBar({}, {}), '');
    });
  });

  it('zero tokens → empty string', async () => {
    await withSessionUi({}, (ui) => {
      assert.equal(ui.renderSessionTokenBar({ tokenUsage: { totalTokens: 0 } }, {}), '');
    });
  });

  it('low usage → tone-low', async () => {
    await withSessionUi({}, (ui) => {
      const result = ui.renderSessionTokenBar({ tokenUsage: { lastRequestUsage: { inputTokens: 10000 } } }, {});
      assert.ok(result.includes('tone-low'));
      assert.ok(result.includes('5%')); // 10000/200000 = 5%
    });
  });

  it('high usage → tone-compress', async () => {
    await withSessionUi({}, (ui) => {
      const result = ui.renderSessionTokenBar({ tokenUsage: { lastRequestUsage: { inputTokens: 170000 } } }, {});
      assert.ok(result.includes('tone-compress'));
      assert.ok(result.includes('85%')); // 170000/200000 = 85
    });
  });

  it('mid usage → tone-mid', async () => {
    await withSessionUi({}, (ui) => {
      const result = ui.renderSessionTokenBar({ tokenUsage: { lastRequestUsage: { inputTokens: 100000 } }, contextLength: 200000 }, {});
      assert.ok(result.includes('tone-mid'));
      assert.ok(result.includes('50%'));
    });
  });

  it('includes compress zone marker', async () => {
    await withSessionUi({}, (ui) => {
      const result = ui.renderSessionTokenBar({ tokenUsage: { lastRequestUsage: { inputTokens: 50000 } } }, {});
      assert.ok(result.includes('session-token-compress-zone'));
      assert.ok(result.includes('left:80%'));
    });
  });
});
