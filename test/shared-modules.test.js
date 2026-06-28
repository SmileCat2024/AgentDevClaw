/**
 * Tests for Phase 0 shared infrastructure modules.
 *
 * Covers pure functions extracted from server.js into server/shared/:
 * - string-helpers: sanitizeSessionFragment, cleanSessionText, isWorkspaceSessionAgent
 * - session-access: normalizeSessionMetadata, buildSessionTitle, path helpers
 * - agent-access: getManagedRuntimeKey, buildStatus
 * - constants: PROJECT_ROOT validity
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  PROJECT_ROOT,
  WORKSPACE_SESSION_AGENT_IDS,
  HIDDEN_PREBUILT_AGENT_IDS,
} from '../server/shared/constants.js';
import {
  sanitizeSessionFragment,
  cleanSessionText,
  isWorkspaceSessionAgent,
} from '../server/shared/string-helpers.js';
import {
  normalizeSessionMetadata,
  buildSessionTitle,
  getPrebuiltAgentSessionDir,
  getPrebuiltSessionFilePath,
  getPrebuiltSessionIndexPath,
  getPrebuiltWorkspaceDir,
} from '../server/shared/session-access.js';
import {
  getManagedRuntimeKey,
  buildStatus,
} from '../server/shared/agent-access.js';

// ─── constants.js ──────────────────────────────────────────────────

describe('constants', () => {
  it('PROJECT_ROOT should resolve to the project directory', () => {
    assert.ok(PROJECT_ROOT.toLowerCase().endsWith('agentdevclaw'),
      `PROJECT_ROOT should end with 'agentdevclaw' (case-insensitive), got: ${PROJECT_ROOT}`);
  });

  it('WORKSPACE_SESSION_AGENT_IDS should include expected agents', () => {
    assert.ok(WORKSPACE_SESSION_AGENT_IDS.has('flow-workspace'));
    assert.ok(WORKSPACE_SESSION_AGENT_IDS.has('programming-helper'));
    assert.ok(WORKSPACE_SESSION_AGENT_IDS.has('feature-creator'));
    assert.ok(WORKSPACE_SESSION_AGENT_IDS.has('agent-creator'));
    assert.ok(!WORKSPACE_SESSION_AGENT_IDS.has('qqbot'));
  });

  it('HIDDEN_PREBUILT_AGENT_IDS should include expected agents', () => {
    assert.ok(HIDDEN_PREBUILT_AGENT_IDS.has('agent-creator'));
    assert.ok(HIDDEN_PREBUILT_AGENT_IDS.has('flow-test'));
    assert.ok(!HIDDEN_PREBUILT_AGENT_IDS.has('qqbot'));
  });
});

// ─── string-helpers.js ─────────────────────────────────────────────

describe('sanitizeSessionFragment', () => {
  it('should return lowercase-unchanged alphanumeric', () => {
    assert.strictEqual(sanitizeSessionFragment('abc123'), 'abc123');
  });

  it('should replace special characters with hyphens', () => {
    assert.strictEqual(sanitizeSessionFragment('hello world!'), 'hello-world');
  });

  it('should collapse consecutive hyphens', () => {
    assert.strictEqual(sanitizeSessionFragment('a---b'), 'a-b');
  });

  it('should trim leading/trailing hyphens', () => {
    assert.strictEqual(sanitizeSessionFragment('---abc---'), 'abc');
  });

  it('should return "default" for empty or falsy input', () => {
    assert.strictEqual(sanitizeSessionFragment(''), 'default');
    assert.strictEqual(sanitizeSessionFragment(null), 'default');
    assert.strictEqual(sanitizeSessionFragment(undefined), 'default');
  });

  it('should preserve underscores and hyphens', () => {
    assert.strictEqual(sanitizeSessionFragment('my_session-id'), 'my_session-id');
  });
});

describe('cleanSessionText', () => {
  it('should trim string values', () => {
    assert.strictEqual(cleanSessionText('  hello  '), 'hello');
  });

  it('should return empty string for non-string types', () => {
    assert.strictEqual(cleanSessionText(null), '');
    assert.strictEqual(cleanSessionText(undefined), '');
    assert.strictEqual(cleanSessionText(123), '');
    assert.strictEqual(cleanSessionText({}), '');
    assert.strictEqual(cleanSessionText([]), '');
  });
});

describe('isWorkspaceSessionAgent', () => {
  it('should return true for workspace agents', () => {
    assert.strictEqual(isWorkspaceSessionAgent('flow-workspace'), true);
    assert.strictEqual(isWorkspaceSessionAgent('programming-helper'), true);
  });

  it('should return false for non-workspace agents', () => {
    assert.strictEqual(isWorkspaceSessionAgent('qqbot'), false);
    assert.strictEqual(isWorkspaceSessionAgent('dispatch-console'), false);
  });

  it('should sanitize input before checking', () => {
    assert.strictEqual(isWorkspaceSessionAgent('  flow-workspace  '), true);
  });
});

// ─── session-access.js ─────────────────────────────────────────────

describe('normalizeSessionMetadata', () => {
  it('should return empty object for falsy input', () => {
    assert.deepEqual(normalizeSessionMetadata(null), {});
    assert.deepEqual(normalizeSessionMetadata(undefined), {});
    assert.deepEqual(normalizeSessionMetadata('not-object'), {});
    assert.deepEqual(normalizeSessionMetadata([]), {});
  });

  it('should extract known fields and clean them', () => {
    const result = normalizeSessionMetadata({
      resumeMode: '  one-shot  ',
      sourceAgentId: 'qqbot',
      sourceSessionId: '  sess-123  ',
      unknownField: 'ignored',
    });
    assert.strictEqual(result.resumeMode, 'one-shot');
    assert.strictEqual(result.sourceAgentId, 'qqbot');
    assert.strictEqual(result.sourceSessionId, 'sess-123');
    assert.strictEqual(result.unknownField, undefined);
  });

  it('should omit fields with falsy values', () => {
    const result = normalizeSessionMetadata({
      resumeMode: '',
      sourceAgentId: null,
      sourceSessionId: 'sess-456',
      handoffId: undefined,
    });
    assert.strictEqual(Object.keys(result).length, 1);
    assert.strictEqual(result.sourceSessionId, 'sess-456');
  });
});

describe('buildSessionTitle', () => {
  it('should format date as "对话 YYYY-MM-DD HH:MM"', () => {
    const title = buildSessionTitle('2026-06-28T14:30:00');
    assert.strictEqual(title, '对话 2026-06-28 14:30');
  });

  it('should zero-pad single-digit months/days/hours/minutes', () => {
    const title = buildSessionTitle('2026-01-05T09:05:00');
    assert.strictEqual(title, '对话 2026-01-05 09:05');
  });
});

describe('session path helpers', () => {
  it('getPrebuiltAgentSessionDir: workspace agent should route to workspaces root', () => {
    const dir = getPrebuiltAgentSessionDir('flow-workspace');
    assert.ok(dir.includes(path.join('workspaces', 'flow-workspace', 'sessions')),
      `Expected workspaces path, got: ${dir}`);
  });

  it('getPrebuiltAgentSessionDir: non-workspace agent should route to prebuilt-sessions root', () => {
    const dir = getPrebuiltAgentSessionDir('qqbot');
    assert.ok(dir.includes(path.join('prebuilt-sessions', 'qqbot')),
      `Expected prebuilt-sessions path, got: ${dir}`);
  });

  it('getPrebuiltSessionFilePath should end with sanitized id + .json', () => {
    const filePath = getPrebuiltSessionFilePath('qqbot', 'my session!');
    assert.ok(filePath.endsWith('my-session.json'),
      `Expected sanitized .json path, got: ${filePath}`);
  });

  it('getPrebuiltSessionIndexPath should end with index.json', () => {
    const indexPath = getPrebuiltSessionIndexPath('qqbot');
    assert.ok(indexPath.endsWith('index.json'),
      `Expected index.json, got: ${indexPath}`);
  });

  it('getPrebuiltWorkspaceDir should be consistent with session dir parent', () => {
    const wsDir = getPrebuiltWorkspaceDir('flow-workspace');
    const sessDir = getPrebuiltAgentSessionDir('flow-workspace');
    assert.ok(sessDir.startsWith(wsDir),
      `Session dir should be under workspace dir`);
  });
});

// ─── agent-access.js ───────────────────────────────────────────────

describe('getManagedRuntimeKey', () => {
  it('should produce "agentId::sessionId" format', () => {
    assert.strictEqual(getManagedRuntimeKey('qqbot', 'sess-1'), 'qqbot::sess-1');
  });

  it('should use NO_SESSION_TOKEN when sessionId is null', () => {
    const key = getManagedRuntimeKey('qqbot', null);
    assert.ok(key.startsWith('qqbot::'));
    assert.ok(!key.endsWith('null'));
  });

  it('should sanitize both fragments', () => {
    assert.strictEqual(
      getManagedRuntimeKey('  qq bot  ', '  my session  '),
      'qq-bot::my-session',
    );
  });
});

describe('buildStatus', () => {
  it('should return stopped status when no runtime exists', () => {
    const status = buildStatus('nonexistent-agent');
    assert.strictEqual(status.status, 'stopped');
    assert.strictEqual(status.pid, null);
    assert.strictEqual(status.viewerAgentId, null);
  });
});
