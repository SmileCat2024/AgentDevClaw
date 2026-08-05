import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GenerativeUISurfaceFeature } from '../src/surface-feature.js';
import { CONTINUITY_FIELD_KEY } from '../../continuity-participant/src/index.js';

function makeSpec(title = 'Release settings') {
  return {
    schemaVersion: 1 as const,
    catalogVersion: 'v1' as const,
    title,
    root: 'root',
    initialValues: { rollout: 25 },
    elements: {
      root: { type: 'Stack', props: {}, children: ['rollout'] },
      rollout: { type: 'Slider', props: { name: 'rollout', label: 'Rollout', min: 0, max: 100 }, children: [] },
    },
  };
}

function createTransport() {
  const calls: Array<{ kind: string; agentId: string; surfaceId: string }> = [];
  return {
    calls,
    async upsert(agentId: string, input: any) {
      calls.push({ kind: 'upsert', agentId, surfaceId: input.surfaceId });
      return {
        agentId,
        surfaceId: input.surfaceId,
        revision: 1,
        status: 'active' as const,
        spec: input.spec,
        contentHash: '',
        createdAt: 0,
        updatedAt: 0,
        presentation: input.presentation || { open: 'if-empty' },
      };
    },
    async close(agentId: string, surfaceId: string) {
      calls.push({ kind: 'close', agentId, surfaceId });
      return { ok: true, surfaceId, alreadyClosed: false };
    },
    async get() { return null; },
    async list() { return []; },
  };
}

describe('GenerativeUISurfaceFeature tool descriptions', () => {
  it('identifies the AgentDevClaw browser panel rather than an ambiguous right panel', () => {
    const feature = new GenerativeUISurfaceFeature();
    const tools = feature.getTools();
    const upsert = tools.find(tool => tool.name === 'ui_surface_upsert');
    const close = tools.find(tool => tool.name === 'ui_surface_close');

    assert.ok(upsert);
    assert.match(upsert.description, /AgentDevClaw browser client/);
    assert.match(upsert.description, /right-side “交互页面” \(Interaction Pages\) panel/);
    assert.match(upsert.description, /not a chat message, a new browser tab, or an external webpage/);

    assert.ok(close);
    assert.match(close.description, /AgentDevClaw browser client/);
  });

  it('captures published surfaces through Feature state and reprojects them after restore', async () => {
    const source: any = new GenerativeUISurfaceFeature();
    const sourceTransport = createTransport();
    source.pushDebugSnapshot('agent-a');
    source._transport = sourceTransport;

    const upsert = source.getTools().find((tool: any) => tool.name === 'ui_surface_upsert');
    const close = source.getTools().find((tool: any) => tool.name === 'ui_surface_close');
    const spec = makeSpec();
    await upsert.execute({ surfaceId: 'release-settings', spec });
    await close.execute({ surfaceId: 'release-settings' });

    const snapshot = source.captureState();
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.surfaces.length, 1);
    assert.equal(snapshot.surfaces[0].status, 'closed');
    assert.equal(snapshot.surfaces[0].spec.initialValues.rollout, 25);
    assert.equal(JSON.stringify(snapshot).includes('viewState'), false);
    assert.equal(snapshot[CONTINUITY_FIELD_KEY].protocol, 'claw.generative-ui-surface.v1');

    // The Feature snapshot is value-only: mutating the original tool argument
    // cannot mutate a later session restore.
    spec.title = 'Mutated after publish';
    const restored: any = new GenerativeUISurfaceFeature();
    const restoredTransport = createTransport();
    restored.pushDebugSnapshot('agent-a');
    restored._transport = restoredTransport;
    await restored.restoreState(snapshot);

    const restoredSnapshot = restored.captureState();
    assert.equal(restoredSnapshot.surfaces[0].spec.title, 'Release settings');
    assert.deepEqual(restoredTransport.calls, [
      { kind: 'upsert', agentId: 'agent-a', surfaceId: 'release-settings' },
      { kind: 'close', agentId: 'agent-a', surfaceId: 'release-settings' },
    ]);
  });

  it('fails closed when restored surface data is invalid', async () => {
    const feature: any = new GenerativeUISurfaceFeature();
    await feature.restoreState({
      schemaVersion: 1,
      surfaces: [{ surfaceId: 'bad', status: 'active', presentation: { open: 'if-empty' }, spec: { schemaVersion: 999 } }],
    });

    assert.deepEqual(feature.captureState().surfaces, []);
  });
});
