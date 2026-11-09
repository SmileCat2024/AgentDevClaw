import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'claw-feature-store-overview-'));
process.env.AGENTDEV_DATA_DIR = dataRoot;

after(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

const { collectBaseFeatures } = await import('../server/routes/feature-store.js');

describe('feature-store builtin base overview', () => {
  it('collects the programming-helper static feature list without starting session projections', async () => {
    const features = await collectBaseFeatures('main');
    const dispatch = features.find((feature) => feature.name === 'claw-coder-dispatch');

    assert.ok(dispatch, '概览应保留编程小助手的静态调度 Feature');
    assert.equal(dispatch.description.length > 0, true);
    assert.deepEqual(dispatch.surface, { hooks: 2, tools: 0, skills: 1, commands: 0 });
  });
});
