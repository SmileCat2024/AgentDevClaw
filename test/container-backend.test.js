import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDataMounts } from '../server/runtime-executor/container-backend.js';

function makeFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'claw-container-mounts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'workspaces', 'coder', 'sessions'), { recursive: true });
  mkdirSync(path.join(root, 'workspaces', 'coder', 'feature-config'), { recursive: true });
  writeFileSync(path.join(root, 'workspaces', 'coder', 'feature-config', 'agent.json'), '{}');
  writeFileSync(path.join(root, 'feature-setup.json'), '{}');
  mkdirSync(path.join(root, 'agent-configs'), { recursive: true });
  mkdirSync(path.join(root, 'oauth-tokens'), { recursive: true });
  mkdirSync(path.join(root, 'images'), { recursive: true });
  for (const file of ['default.json', 'presets.json', 'model-connections.json']) {
    writeFileSync(path.join(root, file), '{}');
  }
  writeFileSync(path.join(root, 'agent-configs', 'coder.json'), '{}');
  return root;
}

test('Coder container mounts only its required data and workspace, with settings read-only', (t) => {
  const root = makeFixture(t);
  const { binds } = buildDataMounts('coder', {}, root);
  const rootPosix = root.replaceAll('\\', '/');
  const expected = [
    `${rootPosix}/workspaces/coder/sessions:/data/workspaces/coder/sessions`,
    `${rootPosix}/default.json:/data/default.json:ro`,
    `${rootPosix}/presets.json:/data/presets.json:ro`,
    `${rootPosix}/model-connections.json:/data/model-connections.json:ro`,
    `${rootPosix}/agent-configs/coder.json:/data/agent-configs/coder.json:ro`,
    `${rootPosix}/images:/data/images`,
    `${rootPosix}/oauth-tokens:/data/oauth-tokens`,
    `${rootPosix}/feature-setup.json:/data/feature-setup.json:ro`,
    `${rootPosix}/workspaces/coder/feature-config/agent.json:/data/workspaces/coder/feature-config/agent.json:ro`,
  ];
  assert.deepEqual(binds, expected);
  assert.equal(binds.some((bind) => bind.includes('/agent-configs/other-agent.json')), false);
  assert.equal(binds.some((bind) => bind.includes('remote-connections.json')), false);
  assert.equal(binds.some((bind) => bind.includes('/threads')), false);
  assert.equal(binds.some((bind) => bind.includes('/workspaces/coder:')), false, 'the session mount must not expose sibling feature config or other workspace assets');
  assert.equal(binds.some((bind) => bind.includes('/workspaces/coder/feature-config:')), false, 'only the Coder agent config file is exposed');
});

test('handoff is mounted read-only and workspace path is the only project directory mount', (t) => {
  const root = makeFixture(t);
  const handoff = path.join(root, 'handoff.json');
  const workspace = path.join(root, 'project-A');
  mkdirSync(workspace);
  writeFileSync(handoff, '{}');
  const { binds } = buildDataMounts('coder', {
    PROTOCLAW_HANDOFF_PATH: handoff,
    PROTOCLAW_SESSION_WORKSPACE_CWD: workspace,
  }, root);
  const rootPosix = root.replaceAll('\\', '/');
  assert.ok(binds.includes(`${rootPosix}/handoff.json:/data/context-handoffs/handoff.json:ro`));
  assert.ok(binds.includes(`${workspace.replaceAll('\\', '/')}:/workspace`));
  assert.equal(binds.some((bind) => bind.endsWith(':/app')), false);
});
