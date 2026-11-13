import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isExecutable, assembleSfx } from '../scripts/build-desktop-installer.mjs';

// SFX 契约同步自 desktop-installer/src/payload.rs：
// [exe] [zip] [u64 LE zip 长度] [8B 魔数 ACLAWSET]
const MAGIC = Buffer.from('ACLAWSET', 'ascii');

const root = mkdtempSync(join(tmpdir(), 'desktop-installer-sfx-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fakeExe(bytes = 1_100_000) {
  const buf = Buffer.alloc(bytes);
  buf.write('MZ');
  return buf;
}

describe('SFX 拼接（自研安装器）', () => {
  it('exe + zip + 长度 + 魔数按契约拼接，产物仍是有效 exe', () => {
    const exe = fakeExe();
    const zip = Buffer.from('PK-fake-zip-payload');
    const exePath = join(root, 'installer.exe');
    const zipPath = join(root, 'payload.zip');
    const dest = join(root, 'AgentDevClaw_0.1.0_x64-setup.exe');
    writeFileSync(exePath, exe);
    writeFileSync(zipPath, zip);

    const out = assembleSfx(dest, { exe: exePath, zip: zipPath });
    assert.equal(out, dest);

    const merged = readFileSync(dest);
    assert.equal(merged.length, exe.length + zip.length + 16);
    // 前段 = exe（MZ 头保持）
    assert.equal(merged.subarray(0, 2).toString(), 'MZ');
    assert.ok(merged.subarray(0, exe.length).equals(exe));
    // 中段 = zip
    assert.ok(merged.subarray(exe.length, exe.length + zip.length).equals(zip));
    // 尾 16 字节 = u64 LE 长度 + 魔数
    assert.equal(merged.readBigUInt64LE(exe.length + zip.length), BigInt(zip.length));
    assert.ok(merged.subarray(exe.length + zip.length + 8).equals(MAGIC));
    assert.ok(isExecutable(dest));
  });

  it('isExecutable 拒绝非 MZ 或过小的文件', () => {
    const small = join(root, 'small.exe');
    writeFileSync(small, Buffer.alloc(100));
    const notMz = join(root, 'not-mz.exe');
    writeFileSync(notMz, Buffer.alloc(1_100_000));
    const missing = join(root, 'missing.exe');
    assert.equal(isExecutable(small), false);
    assert.equal(isExecutable(notMz), false);
    assert.equal(isExecutable(missing), false);
  });
});
