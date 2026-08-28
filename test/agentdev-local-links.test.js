import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { probe, reason } from '../scripts/check-agentdev-local.mjs';

const CORE_DTS = 'export declare enum CoreLifecycle {}\nexport type HookDeclarations = Record<string, unknown>;\n';
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

const root = mkdtempSync(join(tmpdir(), 'agentdev-links-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

// 造一个带完整 core dist 的包目录（index.d.ts 含预检要求的导出名）
function pkgDir(name, { validCoreDts = true } = {}) {
  const p = join(root, name);
  mkdirSync(join(p, 'dist'), { recursive: true });
  writeFileSync(join(p, 'dist', 'index.js'), 'export {};\n');
  writeFileSync(join(p, 'dist', 'index.d.ts'), validCoreDts ? CORE_DTS : 'export {};\n');
  return p;
}

function link(target, linkPath) {
  symlinkSync(target, linkPath, LINK_TYPE);
}

describe('check-agentdev-local probe（开发态本地链接不变量）', () => {
  it('实体目录即使 dist 与导出齐全也判为 unlinked（回归：快照拷贝曾被静默放行）', () => {
    const target = pkgDir('sibling-core');
    const installed = pkgDir('installed-copy');
    const state = probe(installed, 'core', true, realpathSync(target));
    assert.equal(state.status, 'unlinked');
    const text = reason(state);
    assert.match(text, /实体目录/);
    assert.match(text, /framework too old/);
  });

  it('指向相邻仓库对应包的链接判为 ok', () => {
    const target = pkgDir('sibling-core');
    const installed = join(root, 'linked-core');
    link(target, installed);
    const state = probe(installed, 'core', true, realpathSync(target));
    assert.equal(state.status, 'ok');
    assert.equal(state.isLink, true);
  });

  it('链接指向错误目标判为 unlinked', () => {
    const target = pkgDir('sibling-core');
    const other = pkgDir('other-core');
    const installed = join(root, 'mislinked-core');
    link(other, installed);
    const state = probe(installed, 'core', true, realpathSync(target));
    assert.equal(state.status, 'unlinked');
    assert.match(reason(state), /指向/);
  });

  it('链接失效（目标不存在）判为 unlinked', () => {
    const target = pkgDir('doomed-core');
    const installed = join(root, 'dangling-core');
    link(target, installed);
    rmSync(target, { recursive: true, force: true });
    const state = probe(installed, 'core', true, null);
    assert.equal(state.status, 'unlinked');
    assert.match(reason(state), /失效|指向/);
  });

  it('导出缺失的链接判为 stale（沿用原语义）', () => {
    const bad = pkgDir('stale-core', { validCoreDts: false });
    const installed = join(root, 'stale-link');
    link(bad, installed);
    const state = probe(installed, 'core', true, realpathSync(bad));
    assert.equal(state.status, 'stale');
    assert.deepEqual(state.missing, ['CoreLifecycle', 'HookDeclarations']);
  });

  it('发布态（expectLink=false）不要求链接，实体目录仍可 ok', () => {
    const copy = pkgDir('published-copy');
    const state = probe(copy, 'core');
    assert.equal(state.status, 'ok');
  });

  it('不存在的路径判为 missing', () => {
    assert.equal(probe(join(root, 'nope'), 'core', true, null).status, 'missing');
  });
});
