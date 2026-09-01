/**
 * 第二道检查点测试 — 结构分段与 v1 拒绝特征（ticket 033）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkStructure,
  containsGlobOutsideQuotes,
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

  it('拒绝：glob 通配符（引号外 * ? 任意位置、引号外词首 [）', () => {
    for (const cmd of ['ls *', 'cat *.txt', 'ls file?.txt', 'ls [abc]', 'ls a*', 'cat x?y']) {
      const r = checkStructure(cmd);
      assert.equal(r.ok, false, `应拒绝: ${cmd}`);
    }
  });

  it('放行：引号内的 * ? [ ] 是 bash 字面量（ticket 035 修复）', () => {
    // 单引号内 bash 不做 glob：markdown 加粗、jq 过滤器、glob 形态字面量全放行
    for (const cmd of [
      "send wt-x key '工单 **LAND** 判决'",
      "grep '*' file",
      "echo '*'",
      "jq '.[:5]'",
      'echo "**bold**"',
      'echo "[abc]"',
    ]) {
      const r = checkStructure(cmd);
      assert.equal(r.ok, true, `应放行: ${cmd} → ${r.message ?? ''}`);
    }
  });

  it('放行：引号外词中 [（工具语法字面量）', () => {
    // jq 过滤器裸用（[ 非词首）：与原 token 级 startsWith('[') 规则对齐
    assert.equal(checkStructure('jq .[:5]').ok, true);
    assert.equal(checkStructure('echo a[bc]').ok, true);
  });

  it('拒绝：转义 glob \\*（shell-quote 解析为 glob op，落 op 白名单拒绝）', () => {
    // shell-quote 把 \* 解析为 { op: 'glob' } token，落入"其余 op 拒绝"分支；
    // 保守语义（宁严勿漏），与 033 起的既有行为一致
    const r = checkStructure('ls \\*');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'structure_rejected');
  });

  it('拒绝：引号外裸 glob 仍拒绝（既有语义不回归，断言稳定错误码）', () => {
    for (const cmd of ['ls *', 'cat *.txt', 'ls file?.txt', 'ls [abc]']) {
      const r = checkStructure(cmd);
      assert.equal(r.ok, false, `应拒绝: ${cmd}`);
      assert.equal(r.code, 'structure_rejected');
    }
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

  it('containsGlobOutsideQuotes：引号外 * ? / 词首 [ 拒绝，引号内与转义放行', () => {
    // 引号外拒绝
    assert.equal(containsGlobOutsideQuotes('ls *'), true);
    assert.equal(containsGlobOutsideQuotes('cat *.txt'), true);
    assert.equal(containsGlobOutsideQuotes('rm file?'), true);
    assert.equal(containsGlobOutsideQuotes('ls [abc]'), true);
    // 引号内字面量放行
    assert.equal(containsGlobOutsideQuotes("echo '*'"), false);
    assert.equal(containsGlobOutsideQuotes("echo '**bold**'"), false);
    assert.equal(containsGlobOutsideQuotes("jq '.[:5]'"), false);
    assert.equal(containsGlobOutsideQuotes('echo "[abc]"'), false); // 双引号内不 glob
    // 词中 [ 与转义字面量放行
    assert.equal(containsGlobOutsideQuotes('jq .[:5]'), false);
    assert.equal(containsGlobOutsideQuotes('echo a[bc]'), false);
    assert.equal(containsGlobOutsideQuotes('ls \\*'), false); // 转义字面量
    // 引号本身不算词字符：''[abc] 与裸 [abc] 同判（词首 → 拒）
    assert.equal(containsGlobOutsideQuotes("ls ''[abc]"), true);
    // 引号刚闭合后紧跟的 unquoted * 仍触发 glob
    assert.equal(containsGlobOutsideQuotes("echo 'a'*"), true);
    assert.equal(containsGlobOutsideQuotes('literal'), false);
  });
});
