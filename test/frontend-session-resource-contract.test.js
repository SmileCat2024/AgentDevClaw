import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const autoTitle = fs.readFileSync(new URL('../public/src/modules/auto-title.js', import.meta.url), 'utf8');
const workspaceActions = fs.readFileSync(new URL('../public/src/modules/workspace-actions.js', import.meta.url), 'utf8');

describe('session resource identity contracts', () => {
  it('maps runtime child title requests to the logical workspace agent', () => {
    assert.match(autoTitle, /getLogicalAgentId\(runtimeAgent\)/);
    assert.match(autoTitle, /return \{ agent: runtimeAgent, agentId: logicalAgentId \|\| runtimeAgent\.id, sessionId \}/);
    assert.match(autoTitle, /autoGenerateSessionTitle\(logicalAgentId \|\| agent\.id, sessionId/);
  });

  it('does not reference compact-session state from the managed-session finally block', () => {
    const start = workspaceActions.indexOf('if (needsManagedSession)');
    const end = workspaceActions.indexOf("if (action.type === 'show_chat'", start);
    const managedFlow = workspaceActions.slice(start, end);
    assert.doesNotMatch(managedFlow, /clearSessionLoading\(_csAgent\.id\)/);
    assert.match(managedFlow, /clearSessionLoading\(activeAgent\.id\)/);
  });
});
