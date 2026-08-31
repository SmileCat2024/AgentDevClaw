/**
 * 第四道检查点测试 — 参数校验（ticket 033）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkArgs,
  validateParamValue,
  isAbsoluteLike,
  escapesWorkspace,
} from '../src/args.js';
import type { ShellSegment, ShellVerbDecl } from '../src/types.js';

function seg(verb: string, args: string[]): ShellSegment {
  return { verb, args };
}

function decls(d: Record<string, ShellVerbDecl>): Record<string, ShellVerbDecl> {
  return d;
}

function twoParams(): ShellVerbDecl {
  return {
    description: '',
    params: [{ name: 'x', kind: 'literal' }, { name: 'y', kind: 'literal' }],
    adapter: { key: 'k' },
  };
}

describe('capability-shell checkArgs', () => {
  it('放行：参数个数与约束都满足', () => {
    const r = checkArgs([seg('pr_view', ['123'])], decls({
      pr_view: {
        description: '',
        params: [{ name: 'number', kind: 'literal' }],
        adapter: { key: 'gh' },
      },
    }));
    assert.equal(r.ok, true);
  });

  it('拒绝：参数个数不符（多/少）', () => {
    const two = twoParams();
    const r1 = checkArgs([seg('v', ['a'])], decls({ v: two }));
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'arg_rejected');
    assert.ok(r1.message!.includes('2 个参数'));

    const r2 = checkArgs([seg('v', ['a', 'b', 'c'])], decls({ v: two }));
    assert.equal(r2.ok, false);
  });

  it('拒绝：绝对路径', () => {
    const r = checkArgs(
      [seg('cat_file', ['/etc/passwd'])],
      decls({
        cat_file: {
          description: '',
          params: [{ name: 'file', kind: 'path' }],
          adapter: { key: 'cat' },
        },
      }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.message!.includes('绝对路径'));
  });

  it('拒绝：.. 逃逸 workspace', () => {
    const verbTable = decls({
      cat_file: {
        description: '',
        params: [{ name: 'file', kind: 'path' }],
        adapter: { key: 'cat' },
      },
    });
    for (const p of ['..', '../secret', 'a/../../b']) {
      const r = checkArgs([seg('cat_file', [p])], verbTable);
      assert.equal(r.ok, false, `应拒绝: ${p}`);
      assert.equal(r.code, 'arg_rejected');
    }
  });

  it('放行：workspace 内相对路径', () => {
    const r = checkArgs(
      [seg('cat_file', ['logs/out.txt'])],
      decls({
        cat_file: {
          description: '',
          params: [{ name: 'file', kind: 'path' }],
          adapter: { key: 'cat' },
        },
      }),
    );
    assert.equal(r.ok, true);
  });

  it('拒绝：literal enum 白名单外', () => {
    const r = checkArgs(
      [seg('pr_view', ['999'])],
      decls({
        pr_view: {
          description: '',
          params: [{ name: 'state', kind: 'literal', enum: ['open', 'closed'] }],
          adapter: { key: 'gh' },
        },
      }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.message!.includes('open, closed'));
  });

  it('参数个数不符时报错含用法提示', () => {
    const r = checkArgs(
      [seg('pr_view', [])],
      decls({
        pr_view: {
          description: '',
          params: [{ name: 'number', kind: 'literal' }],
          usage: 'pr_view <number>',
          adapter: { key: 'gh' },
        },
      }),
    );
    assert.equal(r.ok, false);
    assert.ok(r.message!.includes('用法'));
  });
});

describe('capability-shell 路径检测', () => {
  it('isAbsoluteLike', () => {
    assert.equal(isAbsoluteLike('/etc/passwd'), true);
    assert.equal(isAbsoluteLike('C:\\x'), true);
    assert.equal(isAbsoluteLike('C:/x'), true);
    assert.equal(isAbsoluteLike('relative/path'), false);
  });

  it('escapesWorkspace', () => {
    assert.equal(escapesWorkspace('..'), true);
    assert.equal(escapesWorkspace('../x'), true);
    assert.equal(escapesWorkspace('a/../b'), true);
    assert.equal(escapesWorkspace('a..b'), false);
    assert.equal(escapesWorkspace('a/b'), false);
  });

  it('validateParamValue：路径类拒绝，字面量类放行', () => {
    assert.equal(validateParamValue('ok.txt', { name: 'f', kind: 'path' }), null);
    assert.ok(validateParamValue('/abs', { name: 'f', kind: 'path' }) !== null);
    assert.ok(validateParamValue('../out', { name: 'f', kind: 'path' }) !== null);
    assert.equal(validateParamValue('open', { name: 's', kind: 'literal', enum: ['open'] }), null);
    assert.ok(validateParamValue('x', { name: 'e', kind: 'literal', enum: ['open'] }) !== null);
  });
});
