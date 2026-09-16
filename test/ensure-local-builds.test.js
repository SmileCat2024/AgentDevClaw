import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isStale, frameworkBuildNeeded } from '../scripts/ensure-local-builds.mjs';

const root = mkdtempSync(join(tmpdir(), 'ensure-builds-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

// 用 utimesSync 显式控制 mtime，避免连续写文件落在同一毫秒导致次序不确定。
const PAST = Math.floor(Date.now() / 1000) - 60;
const FRESH = PAST + 120;

// 造一个 src/dist 双目录的包；默认 dist 比 src 新（fresh 构建产物）。
function freshPackage(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const src = join(dir, 'src', 'index.ts');
  const dist = join(dir, 'dist', 'index.js');
  writeFileSync(src, 'export {};\n');
  writeFileSync(dist, 'export {};\n');
  utimesSync(src, PAST, PAST);
  utimesSync(dist, FRESH, FRESH);
  return { dir, src, dist };
}

describe('isStale（源码树 vs dist 的新旧比较）', () => {
  it('src 比 dist 新判为过时（git pull 场景）', () => {
    const p = freshPackage(join(root, 'stale-pkg'));
    utimesSync(p.src, FRESH, FRESH); // src 拉新
    utimesSync(p.dist, PAST, PAST);
    assert.equal(isStale(join(p.dir, 'src'), join(p.dir, 'dist')), true);
  });

  it('dist 比 src 新判为最新', () => {
    const p = freshPackage(join(root, 'fresh-pkg'));
    assert.equal(isStale(join(p.dir, 'src'), join(p.dir, 'dist')), false);
  });

  it('dist 不存在判为过时（全新克隆 / 构建被中断）', () => {
    const p = freshPackage(join(root, 'no-dist-pkg'));
    rmSync(join(p.dir, 'dist'), { recursive: true, force: true });
    assert.equal(isStale(join(p.dir, 'src'), join(p.dir, 'dist')), true);
  });

  it('src 目录不存在判为最新（无可编译单元）', () => {
    const dir = join(root, 'no-src');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    const f = join(dir, 'dist', 'index.js');
    writeFileSync(f, 'export {};\n');
    assert.equal(isStale(join(dir, 'src'), join(dir, 'dist')), false);
  });

  it('src 下 node_modules 中的文件不参与判定', () => {
    const p = freshPackage(join(root, 'hoisted-pkg'));
    mkdirSync(join(p.dir, 'src', 'node_modules', 'dep'), { recursive: true });
    const hoisted = join(p.dir, 'src', 'node_modules', 'dep', 'fresh.js');
    writeFileSync(hoisted, 'export {};\n');
    utimesSync(hoisted, FRESH + 120, FRESH + 120); // 比 dist 更新，但应被排除
    assert.equal(isStale(join(p.dir, 'src'), join(p.dir, 'dist')), false);
  });
});

describe('frameworkBuildNeeded（相邻框架仓库 dist 过时检测）', () => {
  function fakeFramework() {
    const dir = join(root, `framework-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(dir, 'packages'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}\n');
    return dir;
  }

  it('全部被消费的包都新鲜时不需要构建', () => {
    const dir = fakeFramework();
    freshPackage(join(dir, 'packages', 'core'));
    freshPackage(join(dir, 'packages', 'llm'));
    assert.equal(frameworkBuildNeeded(dir), false);
  });

  it('任一被消费的包过时即需要重建', () => {
    const dir = fakeFramework();
    freshPackage(join(dir, 'packages', 'core'));
    const llm = freshPackage(join(dir, 'packages', 'llm'));
    utimesSync(llm.src, FRESH, FRESH); // 源码被 git pull 刷新，晚于 dist
    utimesSync(llm.dist, PAST, PAST);
    assert.equal(frameworkBuildNeeded(dir), true);
  });

  it('dist 缺失的包触发重建（老仓库从未构建）', () => {
    const dir = fakeFramework();
    mkdirSync(join(dir, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'core', 'src', 'index.ts'), 'export {};\n');
    utimesSync(join(dir, 'packages', 'core', 'src', 'index.ts'), PAST, PAST);
    assert.equal(frameworkBuildNeeded(dir), true);
  });

  it('PACKAGE_MAP 之外的包（deprecated / 未消费）stale 不触发构建', () => {
    // 回归：audit-feature 已 deprecated 且 Claw 运行时零消费，不参与判定；
    // 它的 dist 陈旧与否与启动正确性无关，纳入只会带来无关的启动期全量构建。
    const dir = fakeFramework();
    freshPackage(join(dir, 'packages', 'core'));
    const audit = freshPackage(join(dir, 'packages', 'audit-feature'));
    utimesSync(audit.src, FRESH, FRESH);
    utimesSync(audit.dist, PAST, PAST);
    assert.equal(frameworkBuildNeeded(dir), false);
  });

  it('非框架仓库目录（缺 package.json）判为无需构建', () => {
    assert.equal(frameworkBuildNeeded(join(root, 'not-a-repo')), false);
  });
});
