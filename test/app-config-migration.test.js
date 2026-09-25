import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyAppConfig } from '../server/app-config-migration.js';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoots() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claw-app-config-migration-'));
  tempDirs.push(root);
  return {
    legacyRoot: path.join(root, 'legacy'),
    userDataRoot: path.join(root, 'user-data'),
  };
}

async function writeLegacy(legacyRoot, relativePath, content) {
  const fullPath = path.join(legacyRoot, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  return fullPath;
}

describe('migrateLegacyAppConfig', () => {
  it('copies only known legacy app settings and leaves their sources intact', async () => {
    const { legacyRoot, userDataRoot } = await makeRoots();
    const legacyModel = await writeLegacy(legacyRoot, 'config/default.json', '{"defaultModel":{"model":"legacy"}}');
    const legacyAgent = await writeLegacy(legacyRoot, '.agentdev/agent-configs/coder.json', '{"processMode":"shared-global"}');
    await writeLegacy(legacyRoot, '.agentdev/qqbot.config.json', '{"appId":"legacy-qq"}');
    await writeLegacy(legacyRoot, '.agentdev/mcp-gateway.json', '{"servers":{}}');
    await writeLegacy(legacyRoot, '.agentdev/remote-claw.json', '{"enabled":false}');
    await writeLegacy(legacyRoot, '.agentdev/agent-configs/notes.txt', 'not a config');
    await writeLegacy(legacyRoot, '.agentdev/mcps/project.json', '{"command":"project"}');
    await writeLegacy(legacyRoot, '.agentdev/RULES.md', 'project guidance');

    const result = await migrateLegacyAppConfig({ legacyRoot, userDataRoot });

    assert.deepEqual(result.migrated, [
      'default.json',
      'qqbot.config.json',
      'mcp-gateway.json',
      'remote-claw.json',
      path.join('agent-configs', 'coder.json'),
    ]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(path.join(userDataRoot, 'default.json'), 'utf8'), '{"defaultModel":{"model":"legacy"}}');
    assert.equal(await readFile(path.join(userDataRoot, 'qqbot.config.json'), 'utf8'), '{"appId":"legacy-qq"}');
    assert.equal(await readFile(path.join(userDataRoot, 'mcp-gateway.json'), 'utf8'), '{"servers":{}}');
    assert.equal(await readFile(path.join(userDataRoot, 'remote-claw.json'), 'utf8'), '{"enabled":false}');
    assert.equal(await readFile(path.join(userDataRoot, 'agent-configs', 'coder.json'), 'utf8'), '{"processMode":"shared-global"}');
    assert.equal(await readFile(legacyModel, 'utf8'), '{"defaultModel":{"model":"legacy"}}');
    assert.equal(await readFile(legacyAgent, 'utf8'), '{"processMode":"shared-global"}');
    await assert.rejects(readFile(path.join(userDataRoot, 'mcps', 'project.json')));
    await assert.rejects(readFile(path.join(userDataRoot, 'RULES.md')));
  });

  it('never overwrites existing user settings and reports conflicts', async () => {
    const { legacyRoot, userDataRoot } = await makeRoots();
    await writeLegacy(legacyRoot, 'config/default.json', 'legacy');
    await writeLegacy(legacyRoot, '.agentdev/agent-configs/coder.json', 'legacy-agent');
    await mkdir(path.join(userDataRoot, 'agent-configs'), { recursive: true });
    await writeFile(path.join(userDataRoot, 'default.json'), 'user');
    await writeFile(path.join(userDataRoot, 'agent-configs', 'coder.json'), 'user-agent');

    const result = await migrateLegacyAppConfig({ legacyRoot, userDataRoot });

    assert.deepEqual(result.migrated, []);
    assert.deepEqual(result.skipped, ['default.json', path.join('agent-configs', 'coder.json')]);
    assert.deepEqual(result.errors, []);
    assert.equal(await readFile(path.join(userDataRoot, 'default.json'), 'utf8'), 'user');
    assert.equal(await readFile(path.join(userDataRoot, 'agent-configs', 'coder.json'), 'utf8'), 'user-agent');
  });

  it('is a no-op when the legacy application config paths do not exist', async () => {
    const { legacyRoot, userDataRoot } = await makeRoots();
    const result = await migrateLegacyAppConfig({ legacyRoot, userDataRoot });
    assert.deepEqual(result, { migrated: [], skipped: [], errors: [] });
  });
});
