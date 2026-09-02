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

  it('可选尾参（ticket 035）：可缺省、可提供；必填数不足仍拒绝', () => {
    const optionalTail: ShellVerbDecl = {
      description: '',
      params: [
        { name: 'agentId', kind: 'literal' },
        { name: 'title', kind: 'literal', required: false },
      ],
      usage: "v <agentId> ['title']",
      adapter: { key: 'k' },
    };
    // 只有必填参数：放行
    assert.equal(checkArgs([seg('v', ['a'])], decls({ v: optionalTail })).ok, true);
    // 必填 + 可选：放行
    assert.equal(checkArgs([seg('v', ['a', 't'])], decls({ v: optionalTail })).ok, true);
    // 超过声明长度：拒绝
    assert.equal(checkArgs([seg('v', ['a', 'b', 'c'])], decls({ v: optionalTail })).ok, false);
    // 必填数不足（0 个参数）仍拒绝，文案含区间
    const r0 = checkArgs([seg('v', [])], decls({ v: optionalTail }));
    assert.equal(r0.ok, false);
    assert.ok(r0.message!.includes('1~2 个参数'), r0.message);
  });

  it('可变尾参（variadic）：末位声明可重复，超声明个数不拒绝，逐值按末位约束校验', () => {
    const variadicVerb: ShellVerbDecl = {
      description: '',
      params: [{ name: 'id', kind: 'literal', variadic: true }],
      usage: 'v <id> [id...]',
      adapter: { key: 'k' },
    };
    // 声明个数（1 个）：放行
    assert.equal(checkArgs([seg('v', ['a'])], decls({ v: variadicVerb })).ok, true);
    // 超过声明个数：放行
    assert.equal(checkArgs([seg('v', ['a', 'b', 'c'])], decls({ v: variadicVerb })).ok, true);
    // 0 个：仍拒绝，文案为下限
    const r0 = checkArgs([seg('v', [])], decls({ v: variadicVerb }));
    assert.equal(r0.ok, false);
    assert.ok(r0.message!.includes('1+ 个参数'), r0.message);

    // 可变部分逐值校验：enum 约束对每个可变值生效
    const enumVariadic: ShellVerbDecl = {
      description: '',
      params: [{ name: 'state', kind: 'literal', variadic: true, enum: ['open', 'closed'] }],
      adapter: { key: 'k' },
    };
    assert.equal(checkArgs([seg('v', ['open', 'closed'])], decls({ v: enumVariadic })).ok, true);
    const rBad = checkArgs([seg('v', ['open', 'bogus'])], decls({ v: enumVariadic }));
    assert.equal(rBad.ok, false);
    assert.ok(rBad.message!.includes('bogus'), rBad.message);
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

describe('capability-shell 尾随 flag（ShellVerbDecl.flags）', () => {
  function flagDecl(): ShellVerbDecl {
    return {
      description: '',
      params: [{ name: 'a', kind: 'literal' }, { name: 'b', kind: 'literal' }],
      flags: ['--no-wait'],
      adapter: { key: 'k' },
    };
  }

  it('放行：尾随声明 flag 剥离后按位置参数校验（不计入个数）', () => {
    const r = checkArgs([seg('send', ['wt-1', 'key', '--no-wait'])], decls({ send: flagDecl() }));
    assert.equal(r.ok, true);
  });

  it('拒绝：未声明的 -- 前缀尾参不剥离，按位置参数计数（防误吞指令文本）', () => {
    const r = checkArgs([seg('send', ['wt-1', 'key', '--other'])], decls({ send: flagDecl() }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'arg_rejected');
    assert.ok(r.message!.includes('实际 3 个'), `报文应按 3 个位置参数计数: ${r.message}`);
  });

  it('拒绝：flag 前参数缺失时仍按必填数拒绝', () => {
    const r = checkArgs([seg('send', ['wt-1', '--no-wait'])], decls({ send: flagDecl() }));
    assert.equal(r.ok, false);
    assert.ok(r.message!.includes('2 个参数'));
  });

  it('未声明 flags 的动词行为不变（尾参 --x 按位置参数计数）', () => {
    const r = checkArgs([seg('v', ['a', 'b', '--x'])], decls({ v: twoParams() }));
    assert.equal(r.ok, false);
  });
});
