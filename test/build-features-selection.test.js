import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNeeded, selectedFeatureNames } from '../scripts/build-features.mjs';

const root = mkdtempSync(join(tmpdir(), 'build-features-selection-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('feature 增量构建', () => {
  it('仅选指定 feature，拒绝未知目录', () => {
    assert.deepEqual(selectedFeatureNames(['--only=force-continuation']), ['force-continuation']);
    assert.throws(() => selectedFeatureNames(['--only=unknown']));
  });

  it('依赖和 lock 一致且安装完整时跳过 npm install', () => {
    const dir = join(root, 'installed');
    mkdirSync(join(dir, 'node_modules', '@agentdevjs', 'core'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@agentdevjs/core': '0.1.1' } }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {
      '': { devDependencies: { '@agentdevjs/core': '0.1.1' } },
      'node_modules/@agentdevjs/core': { version: '0.1.1' },
    } }));
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify({ packages: {
      'node_modules/@agentdevjs/core': { version: '0.1.1' },
    } }));
    assert.equal(installNeeded(dir), false);
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {
      '': { devDependencies: { '@agentdevjs/core': '0.1.1' } },
      'node_modules/@agentdevjs/core': { version: '0.1.2' },
    } }));
    assert.equal(installNeeded(dir), true);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@agentdevjs/core': '0.1.2' } }));
    assert.equal(installNeeded(dir), true);
  });
});
