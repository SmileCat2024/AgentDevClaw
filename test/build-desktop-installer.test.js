import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshExecutable, recoverInstaller } from '../scripts/build-desktop-installer.mjs';

const root = mkdtempSync(join(tmpdir(), 'desktop-installer-recovery-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('NSIS 安装包恢复', () => {
  it('末尾覆盖失败时把完整的新安装包另存，保留旧安装包', async () => {
    const source = join(root, 'nsis-output.exe');
    const name = 'AgentDevClaw_0.1.0_x64-setup.exe';
    const old = join(root, name);
    const content = Buffer.alloc(1_000_001);
    content.write('MZ');
    writeFileSync(source, content);
    writeFileSync(old, 'old installer');
    const recovered = await recoverInstaller(Date.now() - 1_000, { source, directory: root, name });
    assert.ok(recovered.endsWith('-setup.exe'));
    assert.notEqual(recovered, old);
    assert.equal(statSync(recovered).size, content.length);
    assert.equal(readFileSync(old, 'utf8'), 'old installer');
  });

  it('不把旧的 NSIS 临时产物误认为本次构建', async () => {
    const source = join(root, 'stale-output.exe');
    const content = Buffer.alloc(1_000_001);
    content.write('MZ');
    writeFileSync(source, content);
    const past = (Date.now() - 60_000) / 1_000;
    utimesSync(source, past, past);
    assert.equal(freshExecutable(source, Date.now()), false);
    assert.equal(await recoverInstaller(Date.now(), { source, directory: root }), null);
  });
});
