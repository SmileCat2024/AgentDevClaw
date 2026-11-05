/**
 * classic script 的 window 同名覆盖防护。
 *
 * app-core.js 之外的模块走 classic script（无模块作用域）：顶层
 * `function foo(){}` 声明会成为 window 属性。若同一文件里再写
 * `window.foo = ...`，后者覆盖前者——文件内部的 `foo()` 调用点随之指向
 * 覆盖后的实现。赋成包装器时，内部调用变成自递归，且错误以「参数空、
 * 目标找不到」之类的表象出现，很难从现象回溯到这一行。
 *
 * 真实事故：thread-store 新增 window.enterThreadAwaitSurface 包装器，
 * 覆盖了同名的内部函数 enterThreadAwaitSurface；openConversationTarget
 * 的等待分支与新包装器自身都调用它，实参按 target 解析得到空 threadId，
 * 点击线程一律返回 thread_missing。
 *
 * 合法写法是「声明后导出别名」（`window.foo = foo;`），本测试放行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'public', 'src');

function collectFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('classic script 模块不得用 window 赋值覆盖同名顶层函数（自递归陷阱）', () => {
  const violations = [];
  for (const file of collectFiles(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    const declared = new Set(
      [...source.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]),
    );
    if (declared.size === 0) continue;
    for (const match of source.matchAll(/^window\.([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)$/gm)) {
      const [, name, rhs] = match;
      if (!declared.has(name)) continue;
      // 导出别名（右边就是同名标识符本身）是既有写法，不在防护范围。
      if (new RegExp(`^${name.replace(/\$/g, '\$')}\s*;?$`).test(rhs.trim())) continue;
      violations.push(`${path.relative(ROOT, file)}: window.${name} 覆盖了同名顶层函数`);
    }
  }
  assert.deepEqual(violations, [], `存在 window 同名覆盖（内部调用会指向覆盖后的实现）：\n${violations.join('\n')}`);
});
