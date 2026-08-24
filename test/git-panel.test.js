/**
 * Git 面板路由功能测试
 *
 * 用真实临时 git 仓库走完整 HTTP 端点（status/stage/unstage/commit/discard），
 * 验证 porcelain 解析（移植自 simple-git）与各操作的端到端行为。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import express from 'express';
import { setupGitRoutes } from '../server/routes/git.js';

let server;
let baseUrl;

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-git-test-'));
  const git = (cmd) => execSync(`git ${cmd}`, { cwd: dir }).toString();
  git('init -q');
  git('config user.email test@local');
  git('config user.name test');
  git('config commit.gpgsign false');
  return { dir, git };
}

async function api(url, body) {
  const res = await fetch(baseUrl + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { code: res.status, data };
}

before(async () => {
  const app = express();
  setupGitRoutes(app, express);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

describe('git status parsing', () => {
  it('parses worktree/staged/untracked states with branch info', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'tracked.txt'), 'v1');
      await fs.writeFile(path.join(dir, 'space name.txt'), 'v1');
      git('add -A');
      git('commit -q -m init');

      await fs.writeFile(path.join(dir, 'tracked.txt'), 'v2');       // worktree modified
      await fs.writeFile(path.join(dir, 'new.txt'), 'n');            // untracked
      await fs.writeFile(path.join(dir, 'staged.txt'), 's');
      git('add staged.txt');                                        // staged added

      const { code, data } = await api('/protoclaw/git/status', { dir });
      assert.equal(code, 200);
      assert.equal(data.ok, true);
      assert.equal(data.isRepo, true);
      assert.equal(data.root, path.resolve(dir));
      assert.equal(data.status.isClean, false);
      assert.deepEqual(data.status.modified, ['tracked.txt']);
      assert.deepEqual(data.status.not_added, ['new.txt']);
      assert.deepEqual(data.status.staged, ['staged.txt']);
      assert.equal(data.status.current, 'master');
      assert.equal(data.status.ahead, 0);
      assert.equal(data.status.behind, 0);
      const byPath = new Map(data.status.files.map((f) => [f.path, f]));
      assert.equal(byPath.get('tracked.txt').index, ' ');
      assert.equal(byPath.get('tracked.txt').working_dir, 'M');
      assert.equal(byPath.get('new.txt').index, '?');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('parses renames (simple-git from/to shape) and unborn branch', async () => {
    const repo = await makeRepo();
    try {
      // unborn: 尚无提交，porcelain -b 输出 "## No commits yet on <branch>"
      const r0 = await api('/protoclaw/git/status', { dir: repo.dir });
      assert.equal(r0.code, 200);
      assert.equal(r0.data.status.current, 'master');
      assert.deepEqual(r0.data.status.not_added, []);

      await fs.writeFile(path.join(repo.dir, 'a.txt'), 'x');
      repo.git('add -A');
      repo.git('commit -q -m init');
      repo.git('mv a.txt b.txt');

      const { data } = await api('/protoclaw/git/status', { dir: repo.dir });
      assert.equal(data.status.renamed.length, 1);
      assert.equal(data.status.renamed[0].from, 'a.txt');
      assert.equal(data.status.renamed[0].to, 'b.txt');
    } finally {
      await fs.rm(repo.dir, { recursive: true, force: true });
    }
  });

  it('reports non-repo directories without error', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claw-notrepo-'));
    try {
      const { code, data } = await api('/protoclaw/git/status', { dir });
      assert.equal(code, 200);
      assert.equal(data.ok, true);
      assert.equal(data.isRepo, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('git stage / unstage / commit', () => {
  it('stages and unstages selected files, then commits staged only', async () => {
    const { dir, git } = await makeRepo();
    try {
      for (const name of ['a.txt', 'b.txt']) await fs.writeFile(path.join(dir, name), 'v1');
      git('add -A');
      git('commit -q -m init');
      await fs.writeFile(path.join(dir, 'a.txt'), 'v2');
      await fs.writeFile(path.join(dir, 'b.txt'), 'v2');
      await fs.writeFile(path.join(dir, 'c.txt'), 'new');

      let r = await api('/protoclaw/git/stage', { dir, files: ['a.txt', 'c.txt'] });
      assert.equal(r.code, 200);
      r = await api('/protoclaw/git/status', { dir });
      assert.deepEqual(r.data.status.staged.sort(), ['a.txt', 'c.txt']);

      r = await api('/protoclaw/git/unstage', { dir, files: ['c.txt'] });
      assert.equal(r.code, 200);
      r = await api('/protoclaw/git/status', { dir });
      assert.deepEqual(r.data.status.staged, ['a.txt']);
      assert.ok(r.data.status.not_added.includes('c.txt'));

      r = await api('/protoclaw/git/commit', { dir, message: 'commit staged only' });
      assert.equal(r.code, 200);
      assert.equal(r.data.commit.branch, 'master');
      assert.match(r.data.commit.commit, /^[0-9a-f]{7,40}$/);
      // b.txt/c.txt 未提交：只看最新提交的文件清单
      const log = git('log -1 --name-only --format=%s');
      assert.ok(log.includes('commit staged only'));
      assert.ok(!log.includes('b.txt'));
      assert.ok(!log.includes('c.txt'));

      // 全部暂存 / 全部取消
      r = await api('/protoclaw/git/stage', { dir });
      assert.equal(r.code, 200);
      r = await api('/protoclaw/git/status', { dir });
      assert.equal(r.data.status.staged.length, 2);
      r = await api('/protoclaw/git/unstage', { dir });
      assert.equal(r.code, 200);
      r = await api('/protoclaw/git/status', { dir });
      assert.equal(r.data.status.staged.length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('supports multi-paragraph commit messages via repeated -m', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'v1');
      git('add -A');
      const r = await api('/protoclaw/git/commit', {
        dir,
        message: 'title\n\nbody line',
      });
      assert.equal(r.code, 200);
      const body = git('log -1 --format=%B');
      assert.ok(body.includes('title'));
      assert.ok(body.includes('body line'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('git discard', () => {
  it('discards untracked (clean), modified (restore), staged-added (remove)', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'kept.txt'), 'v1');
      git('add -A');
      git('commit -q -m init');

      // untracked → clean 移除
      await fs.writeFile(path.join(dir, 'u.txt'), 'x');
      let r = await api('/protoclaw/git/discard', { dir, files: ['u.txt'] });
      assert.equal(r.code, 200);
      assert.equal(await fs.stat(path.join(dir, 'u.txt')).then(() => true, () => false), false);

      // modified → checkout 恢复
      await fs.writeFile(path.join(dir, 'kept.txt'), 'dirty');
      r = await api('/protoclaw/git/discard', { dir, files: ['kept.txt'] });
      assert.equal(r.code, 200);
      assert.equal(await fs.readFile(path.join(dir, 'kept.txt'), 'utf8'), 'v1');

      // staged added → reset + clean，文件彻底移除
      await fs.writeFile(path.join(dir, 's.txt'), 'staged new');
      git('add s.txt');
      r = await api('/protoclaw/git/discard', { dir, files: ['s.txt'] });
      assert.equal(r.code, 200);
      assert.equal(await fs.stat(path.join(dir, 's.txt')).then(() => true, () => false), false);
      r = await api('/protoclaw/git/status', { dir });
      assert.equal(r.data.status.isClean, true);

      // staged modified → reset + checkout 恢复 HEAD 内容
      await fs.writeFile(path.join(dir, 'kept.txt'), 'v2');
      git('add kept.txt');
      await fs.writeFile(path.join(dir, 'kept.txt'), 'v3');
      r = await api('/protoclaw/git/discard', { dir, files: ['kept.txt'] });
      assert.equal(r.code, 200);
      assert.equal(await fs.readFile(path.join(dir, 'kept.txt'), 'utf8'), 'v1');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects discard of renamed files with a clear error', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'x');
      git('add -A');
      git('commit -q -m init');
      git('mv a.txt b.txt');
      const r = await api('/protoclaw/git/discard', { dir, files: ['b.txt'] });
      assert.equal(r.code, 400);
      assert.match(r.data.error, /重命名|冲突/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('treats already-unchanged files as discarded without error', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'x');
      git('add -A');
      git('commit -q -m init');
      const r = await api('/protoclaw/git/discard', { dir, files: ['a.txt'] });
      assert.equal(r.code, 200);
      assert.equal(r.data.discarded, 1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('git route input validation', () => {
  it('rejects missing dir, non-directory, empty message, empty files', async () => {
    assert.equal((await api('/protoclaw/git/status', {})).code, 400);
    assert.equal((await api('/protoclaw/git/status', { dir: '/nonexistent/path/x' })).code, 400);
    assert.equal((await api('/protoclaw/git/commit', { dir: process.cwd(), message: '' })).code, 400);
    assert.equal((await api('/protoclaw/git/discard', { dir: process.cwd(), files: [] })).code, 400);
    assert.equal((await api('/protoclaw/git/stage', { dir: process.cwd(), files: 'a.txt' })).code, 400);
  });
});

describe('git graph / commit_files', () => {
  it('returns commits with parents, refs and subject in new-to-old order', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'v1');
      git('add -A');
      git('commit -q -m first');
      await fs.writeFile(path.join(dir, 'a.txt'), 'v2');
      git('add -A');
      git('commit -q -m second');
      git('tag v1.0');

      const { code, data } = await api('/protoclaw/git/graph', { dir, limit: 10 });
      assert.equal(code, 200);
      assert.equal(data.commits.length, 2);
      const [head, first] = data.commits;
      assert.equal(head.subject, 'second');
      assert.equal(first.subject, 'first');
      assert.equal(head.parents.length, 1);
      assert.equal(head.parents[0].slice(0, 7), first.hash.slice(0, 7));
      // HEAD -> master 装饰 + tag
      assert.ok(head.refs.some((r) => r.type === 'head'));
      assert.ok(head.refs.some((r) => r.type === 'tag' && r.name === 'v1.0'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty commits for a repository without any commit', async () => {
    const { dir } = await makeRepo();
    try {
      const { code, data } = await api('/protoclaw/git/graph', { dir, limit: 10 });
      assert.equal(code, 200);
      assert.deepEqual(data.commits, []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('commit_files lists changed files with add/remove counts', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n');
      git('add -A');
      git('commit -q -m init');
      await fs.writeFile(path.join(dir, 'a.txt'), 'line1\nline2 changed\nline3\nline4\n');
      await fs.writeFile(path.join(dir, 'b.txt'), 'new');
      git('add -A');
      git('commit -q -m second');

      const { code, data } = await api('/protoclaw/git/commit_files', { dir, hash: 'HEAD' });
      assert.equal(code, 200);
      const byPath = new Map(data.files.map((f) => [f.path, f]));
      assert.ok(byPath.has('a.txt'));
      assert.equal(byPath.get('a.txt').added, 2);   // line2 改写 + line4 新增
      assert.equal(byPath.get('a.txt').removed, 1); // line2 被替换
      assert.ok(byPath.has('b.txt'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('git branch operations', () => {
  it('lists branches, creates, switches, and deletes', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'v1');
      git('add -A');
      git('commit -q -m init');

      let r = await api('/protoclaw/git/branches', { dir });
      assert.equal(r.code, 200);
      assert.equal(r.data.locals.length, 1);
      assert.equal(r.data.current, 'master');
      // for-each-ref 格式：带最后提交相对时间与当前标记
      assert.ok(typeof r.data.locals[0].relTime === 'string' && r.data.locals[0].relTime.length > 0);
      assert.equal(r.data.locals[0].current, true);

      r = await api('/protoclaw/git/branch', { dir, op: 'create', name: 'feature/x' });
      assert.equal(r.code, 200);
      r = await api('/protoclaw/git/branches', { dir });
      assert.equal(r.data.locals.length, 2);

      r = await api('/protoclaw/git/branch', { dir, op: 'switch', name: 'feature/x' });
      assert.equal(r.code, 200);
      r = await api('/protoclaw/git/branches', { dir });
      assert.equal(r.data.current, 'feature/x');

      // 删除当前分支应失败
      r = await api('/protoclaw/git/branch', { dir, op: 'delete', name: 'feature/x' });
      assert.equal(r.code, 500);
      // 切回后删除成功
      await api('/protoclaw/git/branch', { dir, op: 'switch', name: 'master' });
      r = await api('/protoclaw/git/branch', { dir, op: 'delete', name: 'feature/x' });
      assert.equal(r.code, 200);
      r = await api('/protoclaw/git/branches', { dir });
      assert.equal(r.data.locals.length, 1);

      r = await api('/protoclaw/git/branch', { dir, op: 'unknown' });
      assert.equal(r.code, 400);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('git stash operations', () => {
  it('saves, lists, pops and drops stashes', async () => {
    const { dir, git } = await makeRepo();
    try {
      await fs.writeFile(path.join(dir, 'a.txt'), 'v1');
      git('add -A');
      git('commit -q -m init');

      let r = await api('/protoclaw/git/stash', { dir, op: 'list' });
      assert.equal(r.data.entries.length, 0);

      await fs.writeFile(path.join(dir, 'a.txt'), 'dirty');
      r = await api('/protoclaw/git/stash', { dir, op: 'save' });
      assert.equal(r.code, 200);
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'v1'); // 贮藏后工作区恢复

      r = await api('/protoclaw/git/stash', { dir, op: 'list' });
      assert.equal(r.data.entries.length, 1);
      const ref = r.data.entries[0].ref;
      assert.match(ref, /^stash@\{0\}$/);

      r = await api('/protoclaw/git/stash', { dir, op: 'pop', ref });
      assert.equal(r.code, 200);
      assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'dirty'); // pop 恢复改动
      r = await api('/protoclaw/git/stash', { dir, op: 'list' });
      assert.equal(r.data.entries.length, 0);

      // drop 路径
      await api('/protoclaw/git/stash', { dir, op: 'save' });
      r = await api('/protoclaw/git/stash', { dir, op: 'drop', ref: 'stash@{0}' });
      assert.equal(r.code, 200);
      r = await api('/protoclaw/git/stash', { dir, op: 'list' });
      assert.equal(r.data.entries.length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
