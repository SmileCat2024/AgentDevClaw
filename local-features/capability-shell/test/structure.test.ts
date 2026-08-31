/**
 * 第二道检查点测试 — 结构分段与 v1 拒绝特征（ticket 033）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStructure,
  containsGlob,
  containsDollarOutsideSingleQuotes,
} from '../src/structure.js';

describe('capability-shell checkStructure', () => {
  it('放行：字面量参数 + 管道', () => {
    const r = checkStructure('gh pr list --json number,title | jq \'.[:5]\'');
    assert.equal(r.ok, true);
    assert.equal(r.segments!.length, 2);
    assert.deepEqual(
      { verb: r.segments![0].verb, args: r.segments![0].args },
      { verb: 'gh', args: ['pr', 'list', '--json', 'number,title'] },
    );
    assert.equal(r.segments![1].verb, 'jq');
    assert.equal(r.segments![1].args[0], '.[:5]');
  });

  it('放行重定向 > >> <（字面量目标）', () => {
    assert.equal(checkStructure('gh pr list > out.txt').ok, true);
    assert.equal(checkStructure('gh pr list >> out.txt').ok, true);
    assert.equal(checkStructure('jq . < in.json').ok, true);
  });

  it('拒绝：命令替换 $(...)', () => {
    const r = checkStructure('echo $(whoami)');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'structure_rejected');
  });

  it('拒绝：反引号', () => {
    const r = checkStructure('echo `whoami`');
    assert.equal(r.ok, false);
  });

  it('拒绝：变量引用 $x / ${x} / $?（含引号内）', () => {
    for (const cmd of [
      'echo $HOME',
      'echo ${HOME}',
      'echo $?',
      'cat $FILE',
      'echo "$HOME"',
    ]) {
      const r = checkStructure(cmd);
      assert.equal(r.ok, false, `应拒绝: ${cmd}`);
      assert.equal(r.code, 'structure_rejected');
    }
  });

  it('拒绝：进程替换 <() 与 >()', () => {
    assert.equal(checkStructure('diff <(ls) <(ls ..)').ok, false);
    assert.equal(checkStructure('tee >(wc -l)').ok, false);
  });

  it('拒绝：glob 通配符（未引用）', () => {
    for (const cmd of ['ls *', 'cat *.txt', 'ls file?.txt', 'ls [abc]']) {
      const r = checkStructure(cmd);
      assert.equal(r.ok, false, `应拒绝: ${cmd}`);
    }
  });

  it('引用内的 glob/变量字面量（shell-quote 剥引号后不含元字符）放行', () => {
    // 单引号内 * 被 shell-quote 剥成字面量 *？—— shell-quote 保留引号内内容；
    // 剥引号后 token 为 '*'，仍是 glob 形态，v1 一律拒绝（保守语义）
    const r = checkStructure("echo '*'");
    assert.equal(r.ok, false);
  });

  it('拒绝：heredoc', () => {
    assert.equal(checkStructure('cat << EOF\nhi\nEOF').ok, false);
    assert.equal(checkStructure('jq . <<< \'{}\'').ok, false);
  });

  it('拒绝：后台 &', () => {
    assert.equal(checkStructure('sleep 5 &').ok, false);
  });

  it('拒绝：&& 与 ; 与 ||', () => {
    assert.equal(checkStructure('a && b').ok, false);
    assert.equal(checkStructure('a || b').ok, false);
    assert.equal(checkStructure('a; b').ok, false);
  });

  it('拒绝：空命令', () => {
    assert.equal(checkStructure('').ok, false);
    assert.equal(checkStructure('   ').ok, false);
  });

  it('拒绝：管道悬空', () => {
    // 尾悬空：| 后无命令 → 收尾段校验应拒绝（jq 段缺失，管道 op 后无 token）
    const r1 = checkStructure('gh pr list |');
    assert.equal(r1.ok, false, '管道尾悬空应拒绝');
    assert.equal(checkStructure('| jq .').ok, false);
  });

  it('拒绝：注释', () => {
    assert.equal(checkStructure('gh pr list # comment').ok, false);
  });

  it('报错文案含可用动词提示（拒绝特征罗列）', () => {
    const r = checkStructure('echo $(whoami)');
    assert.equal(r.ok, false);
    assert.ok(r.message!.includes('$()'));
    assert.ok(r.message!.includes('管道'));
  });

  it('单段命令的 verb/args 切分正确', () => {
    const r = checkStructure('gh pr view 123 --json title');
    assert.equal(r.ok, true);
    assert.equal(r.segments![0].verb, 'gh');
    assert.deepEqual(r.segments![0].args, ['pr', 'view', '123', '--json', 'title']);
  });
});

describe('capability-shell token 检测', () => {
  it('containsDollarOutsideSingleQuotes：单引号外 $ 拒绝，单引号内/转义放行', () => {
    assert.equal(containsDollarOutsideSingleQuotes('echo $HOME'), true);
    assert.equal(containsDollarOutsideSingleQuotes('echo "$HOME"'), true);
    assert.equal(containsDollarOutsideSingleQuotes('echo ${HOME}'), true);
    assert.equal(containsDollarOutsideSingleQuotes('echo $?'), true);
    assert.equal(containsDollarOutsideSingleQuotes("echo '$HOME'"), false); // 单引号内字面量
    assert.equal(containsDollarOutsideSingleQuotes('echo \\$HOME'), false); // 转义字面量
    assert.equal(containsDollarOutsideSingleQuotes('literal'), false);
  });

  it('containsGlob', () => {
    assert.equal(containsGlob('*.txt'), true);
    assert.equal(containsGlob('file?'), true);
    assert.equal(containsGlob('[abc]'), true);
    assert.equal(containsGlob('.[:5]'), false); // jq 过滤器（[ 非段首）
    assert.equal(containsGlob('literal'), false);
  });
});
