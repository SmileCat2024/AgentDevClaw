/**
 * 第三道检查点测试 — 逐段动词校验（ticket 033）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkVerbs, listVerbs } from '../src/verbs.js';
import type { ShellSegment } from '../src/types.js';

const VERBS = {
  'pr_list': { description: '列出 PR', params: [], adapter: { key: 'gh' } },
  'pr_view': { description: '查看 PR', params: [], adapter: { key: 'gh' } },
};

function seg(verb: string, args: string[] = []): ShellSegment {
  return { verb, args };
}

describe('capability-shell checkVerbs', () => {
  it('放行：全部段动词都在动词表内', () => {
    const segments = [seg('pr_list'), seg('pr_view', ['123'])];
    const r = checkVerbs('test_shell', segments, { pr_list: {}, pr_view: {} });
    assert.equal(r.ok, true);
  });

  it('拒绝：未知动词，报错含可用动词清单（稳定排序）', () => {
    const r = checkVerbs('test_shell', [seg('unknown_cmd')], {
      pr_view: {},
      pr_list: {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unknown_verb');
    assert.equal(r.segmentIndex, 0);
    assert.ok(r.message!.includes('pr_list, pr_view'));
  });

  it('管道第二段未知动词也拦截', () => {
    const segments = [seg('pr_list'), seg('rm', ['-rf', '/'])];
    const r = checkVerbs('test_shell', segments, { pr_list: {} });
    assert.equal(r.ok, false);
    assert.equal(r.segmentIndex, 1);
    assert.equal(r.verb, 'rm');
    assert.ok(r.message!.includes('可用动词'));
  });

  it('listVerbs 稳定排序', () => {
    assert.equal(listVerbs({ b: 1, a: {}, c: {} }), 'a, b, c');
  });
});
