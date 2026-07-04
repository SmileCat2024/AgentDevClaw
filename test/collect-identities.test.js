/**
 * Tests for collectIdentities filtering logic.
 *
 * Imports the REAL collectIdentitiesFromAgents from agent-discovery.js.
 * The pure function was extracted from the closure to enable direct testing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectIdentitiesFromAgents } from '../server/routes/agent-discovery.js';

// ── Tests ──

describe('collectIdentities groupChat filter', () => {

  describe('groupChat: true filter', () => {
    it('includes identity marked with groupChat: true', () => {
      const agents = [{
        id: 'helper',
        name: 'Helper',
        enabled: true,
        identities: [{ id: 'main', groupChat: true, displayName: 'Helper' }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 1);
      assert.equal(ids[0].identityRef, 'helper:main');
    });

    it('excludes identity without groupChat flag', () => {
      const agents = [{
        id: 'helper',
        name: 'Helper',
        enabled: true,
        identities: [{ id: 'main', displayName: 'Helper' }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 0);
    });

    it('excludes identity with groupChat: false', () => {
      const agents = [{
        id: 'helper',
        name: 'Helper',
        enabled: true,
        identities: [{ id: 'main', groupChat: false, displayName: 'Helper' }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 0);
    });

    it('includes only groupChat identities from a mixed list', () => {
      const agents = [{
        id: 'helper',
        name: 'Helper',
        enabled: true,
        identities: [
          { id: 'main', groupChat: true, displayName: 'Main' },
          { id: 'background', groupChat: false, displayName: 'Background' },
          { id: 'observer', displayName: 'Observer' }, // no groupChat flag
        ],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 1);
      assert.equal(ids[0].identityId, 'main');
    });
  });

  describe('no auto-generated default identity (behavior change)', () => {
    it('returns empty for agent with no identities declaration', () => {
      const agents = [{
        id: 'plain-agent',
        name: 'Plain Agent',
        enabled: true,
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 0);
    });

    it('returns empty for agent with empty identities array', () => {
      const agents = [{
        id: 'plain-agent',
        name: 'Plain Agent',
        enabled: true,
        identities: [],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 0);
    });

    it('returns empty for agent with identities but none groupChat-marked', () => {
      const agents = [{
        id: 'plain-agent',
        name: 'Plain Agent',
        enabled: true,
        identities: [{ id: 'default', operations: ['status'] }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 0);
    });
  });

  describe('agent-level filters', () => {
    it('skips agents with enabled: false', () => {
      const agents = [{
        id: 'disabled',
        name: 'Disabled',
        enabled: false,
        identities: [{ id: 'main', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 0);
    });

    it('skips agents with launchMode: ui-only', () => {
      const agents = [{
        id: 'ui-only',
        name: 'UI Only',
        launchMode: 'ui-only',
        identities: [{ id: 'main', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 0);
    });

    it('includes agents without explicit enabled field (defaults to enabled)', () => {
      const agents = [{
        id: 'agent1',
        name: 'Agent1',
        identities: [{ id: 'main', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 1);
    });
  });

  describe('identity field defaults', () => {
    it('uses identity id as displayName when not specified', () => {
      const agents = [{
        id: 'a', name: 'A', enabled: true,
        identities: [{ id: 'bot', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids[0].displayName, 'bot');
    });

    it('defaults sessionModel to persistent', () => {
      const agents = [{
        id: 'a', name: 'A', enabled: true,
        identities: [{ id: 'main', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids[0].sessionModel, 'persistent');
    });

    it('defaults callTimeoutMs to 900000 (15min)', () => {
      const agents = [{
        id: 'a', name: 'A', enabled: true,
        identities: [{ id: 'main', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids[0].callTimeoutMs, 900000);
    });

    it('defaults operations to empty array', () => {
      const agents = [{
        id: 'a', name: 'A', enabled: true,
        identities: [{ id: 'main', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.deepEqual(ids[0].operations, []);
    });

    it('defaults qualifierLabel to null', () => {
      const agents = [{
        id: 'a', name: 'A', enabled: true,
        identities: [{ id: 'main', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids[0].qualifierLabel, null);
    });

    it('respects explicit sessionModel one-shot', () => {
      const agents = [{
        id: 'a', name: 'A', enabled: true,
        identities: [{ id: 'main', groupChat: true, sessionModel: 'one-shot' }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids[0].sessionModel, 'one-shot');
    });

    it('respects explicit callTimeoutMs', () => {
      const agents = [{
        id: 'a', name: 'A', enabled: true,
        identities: [{ id: 'main', groupChat: true, callTimeoutMs: 30000 }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids[0].callTimeoutMs, 30000);
    });
  });

  describe('identityRef construction', () => {
    it('builds identityRef as workspaceId:identityId', () => {
      const agents = [{
        id: 'programming-helper', name: 'Helper', enabled: true,
        identities: [{ id: 'main', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids[0].identityRef, 'programming-helper:main');
    });

    it('handles multi-word workspaceId', () => {
      const agents = [{
        id: 'work-group', name: 'Work Group', enabled: true,
        identities: [{ id: 'admin', groupChat: true }],
      }];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids[0].identityRef, 'work-group:admin');
    });
  });

  describe('multiple agents', () => {
    it('collects from multiple agents', () => {
      const agents = [
        { id: 'a', name: 'A', enabled: true, identities: [{ id: 'main', groupChat: true }] },
        { id: 'b', name: 'B', enabled: true, identities: [{ id: 'main', groupChat: true }] },
        { id: 'c', name: 'C', enabled: true, identities: [{ id: 'main' }] },
      ];
      const ids = collectIdentitiesFromAgents(agents);
      assert.equal(ids.length, 2);
      assert.equal(ids[0].workspaceId, 'a');
      assert.equal(ids[1].workspaceId, 'b');
    });
  });
});
