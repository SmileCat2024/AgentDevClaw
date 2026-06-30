import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyContinuityToolPolicy,
  exportFeatureContinuity,
  importFeatureContinuity,
} from '../server/context-continuity/feature-continuity.js';

describe('feature continuity protocol', () => {
  it('exports todo feature state and continuity tool policy from a session snapshot', () => {
    const sessionSnapshot = {
      runtime: {
        featureStates: [
          {
            featureName: 'todo',
            snapshot: {
              tasks: [
                {
                  id: '1',
                  subject: 'Keep the plan',
                  description: 'This should survive compact/trim.',
                  status: 'in_progress',
                  createdAt: 10,
                  updatedAt: 20,
                },
              ],
              counter: 1,
              reminderInjected: true,
            },
          },
        ],
      },
    };

    const continuity = exportFeatureContinuity(sessionSnapshot, { mode: 'trim-transcript' });

    assert.equal(continuity.schemaVersion, 1);
    assert.equal(continuity.mode, 'trim-transcript');
    assert.equal(continuity.states.length, 1);
    assert.equal(continuity.states[0].featureName, 'todo');
    assert.equal(continuity.states[0].state.tasks[0].subject, 'Keep the plan');
    assert.ok(continuity.toolPolicy.preserveToolNames.includes('task_update'));
  });

  it('merges protected tool names into an existing export policy', () => {
    const policy = applyContinuityToolPolicy({
      preserveToolNames: ['invoke_skill', 'task_update'],
    });

    assert.deepEqual(
      [...policy.preserveToolNames].sort(),
      ['invoke_skill', 'task_clear', 'task_create', 'task_update'].sort(),
    );
  });

  it('imports todo state into an agent feature through restoreState', async () => {
    let restored = null;
    const agent = {
      features: new Map([
        ['todo', {
          name: 'todo',
          restoreState(snapshot) {
            restored = snapshot;
          },
        }],
      ]),
    };

    const imported = await importFeatureContinuity(agent, {
      states: [
        {
          featureName: 'todo',
          state: {
            tasks: [
              { id: '7', subject: 'Resume me', status: 'completed' },
            ],
            counter: 7,
          },
        },
      ],
    }, { sourceSessionId: 'session-source' });

    assert.deepEqual(imported, ['todo']);
    assert.equal(restored.tasks[0].subject, 'Resume me');
    assert.equal(restored.metadata.importedBy, 'claw-continuity');
    assert.equal(restored.metadata.sourceSessionId, 'session-source');
  });
});
