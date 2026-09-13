/**
 * Tests for git repository discovery (server/routes/git.js discoverGitRepos)
 *
 * BFS 扫描纯行为验证（真实 tmp 目录 IO）：层级上限、剪枝规则（仓库内部 /
 * node_modules / 隐藏目录 / 符号链接）、worktree 形态 .git 文件、子项截断
 * 语义与缓存 force 绕过。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverGitRepos } from '../server/routes/git.js';

// win32 无特权环境 symlinkSync 需要 junction（对齐 agentdev-local-links 先例）
const SYMLINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

let root;

function makeRepo(dir, gitAsFile = false) {
  mkdirSync(dir, { recursive: true });
  if (gitAsFile) {
    writeFileSync(join(dir, '.git'), 'gitdir: ../elsewhere\n');
  } else {
    mkdirSync(join(dir, '.git'));
  }
}

before(async () => {
  root = await mkdtempSync(join(tmpdir(), 'claw-git-discover-'));
});

after(async () => {
  await rmSync(root, { recursive: true, force: true });
});

describe('discoverGitRepos', () => {
  it('finds plain / nested / worktree repos and returns sorted relPaths', async () => {
    makeRepo(join(root, 'repoA'));
    makeRepo(join(root, 'deep', 'nested', 'repoB'));
    makeRepo(join(root, 'worktreeC'), true); // .git 是文件（worktree/submodule 形态）

    const repos = await discoverGitRepos(root, { force: true });
    const paths = repos.map((r) => r.relPath);
    assert.deepEqual(paths, ['deep/nested/repoB', 'repoA', 'worktreeC']);
    // root 字段是绝对路径（与 validateDir 归一化产物一致可比较）
    assert.ok(repos[1].root.startsWith(root));
  });

  it('skips node_modules, hidden dirs, symlinked dirs and repos nested inside a found repo', async () => {
    makeRepo(join(root, 'skip-nm', 'node_modules', 'pkg'));      // node_modules 剪枝
    makeRepo(join(root, '.hidden', 'repoD'));                    // 隐藏目录剪枝
    makeRepo(join(root, 'outer'));                               // 命中后内部剪枝
    makeRepo(join(root, 'outer', 'sub', 'repoInner'));           // 不应出现
    makeRepo(join(root, 'link-target'));
    symlinkSync(join(root, 'link-target'), join(root, 'symlinked'), SYMLINK_TYPE); // 符号链接不跟随

    const repos = await discoverGitRepos(root, { force: true });
    const paths = repos.map((r) => r.relPath);
    assert.ok(!paths.some((p) => p.includes('node_modules')));
    assert.ok(!paths.some((p) => p.startsWith('.hidden')));
    assert.ok(!paths.some((p) => p.includes('repoInner')));
    assert.ok(!paths.some((p) => p.startsWith('symlinked')));
    assert.ok(paths.includes('outer'));
    assert.ok(paths.includes('link-target'));
  });

  it('respects depth limit (default 4 levels below root)', async () => {
    makeRepo(join(root, 'l1', 'l2', 'l3', 'repo4'));   // 深度 4：可发现
    makeRepo(join(root, 'l1', 'l2', 'l3', 'l4', 'repo5')); // 深度 5：超出

    const repos = await discoverGitRepos(root, { force: true });
    const paths = repos.map((r) => r.relPath);
    assert.ok(paths.includes('l1/l2/l3/repo4'));
    assert.ok(!paths.some((p) => p.includes('repo5')));
  });

  it('truncates children per directory when maxChildren injected', async () => {
    for (let i = 0; i < 6; i++) {
      makeRepo(join(root, 'cap', `r${i}`));
    }
    const repos = await discoverGitRepos(root, { force: true, maxChildren: 3 });
    const found = repos.filter((r) => r.relPath.startsWith('cap/'));
    assert.equal(found.length, 3);
  });

  it('caches results: new repo invisible until force', async () => {
    // 上一次 force 扫描已建立缓存快照；新建仓库在 TTL 内不应出现
    makeRepo(join(root, 'created-after-scan'));
    const cached = await discoverGitRepos(root); // 命中正结果 TTL
    assert.ok(!cached.some((r) => r.relPath === 'created-after-scan'));

    const forced = await discoverGitRepos(root, { force: true });
    assert.ok(forced.some((r) => r.relPath === 'created-after-scan'));
  });

  it('returns empty array when no repos exist (negative result)', async () => {
    const emptyRoot = join(root, 'empty-area');
    mkdirSync(emptyRoot, { recursive: true });
    const repos = await discoverGitRepos(emptyRoot, { force: true });
    assert.deepEqual(repos, []);
  });
});
