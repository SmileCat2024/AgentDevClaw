// scripts/check-import-cycles.mjs 纯函数单测（CLI 入口有 isMain 守卫，导入不触发）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import {
  parseImportEdges,
  resolveRelativeSpecifier,
  findCyclicSccs,
  cycleFingerprint,
  diffCycles,
  projectRoot,
} from '../scripts/check-import-cycles.mjs';

test('parseImportEdges 区分值导入与纯类型导入', () => {
  const src = `
import { a } from './x.js';
import type { B } from './y.js';
import type C from './ydefault.js';
import { type D, e } from './z.js';
import './side-effect.js';
export { f } from './re-export.js';
export type { G } from './type-reexport.js';
export * from './star.js';
const m = import('./dynamic.js');
// import { gone } from './commented-out.js';
`;
  const value = parseImportEdges(src)
    .filter((e) => e.kind === 'value')
    .map((e) => e.specifier);
  // 混合具名导入（type D + e）按值边处理；纯 type 语句与 type 再导出不构成运行期边
  assert.deepEqual(value.sort(), [
    './dynamic.js',
    './re-export.js',
    './side-effect.js',
    './star.js',
    './x.js',
    './z.js',
  ]);
});

test('parseImportEdges 剥离行注释中的 import', () => {
  const src = `// import { a } from './commented.js';\nimport { b } from './real.js';`;
  const specifiers = parseImportEdges(src).map((e) => e.specifier);
  assert.deepEqual(specifiers, ['./real.js']);
});

test('resolveRelativeSpecifier 支持 TS NodeNext 的 .js 后缀映射', () => {
  // assertions.ts 中的 './project-store.js' 实际指向 project-store.ts
  const from = join(projectRoot, 'local-features/agent-studio/src/assertions.ts');
  const target = resolveRelativeSpecifier(from, './project-store.js');
  assert.equal(target, join(projectRoot, 'local-features/agent-studio/src/project-store.ts'));
});

test('resolveRelativeSpecifier 裸包名与仓库外路径返回 null', () => {
  const from = join(projectRoot, 'server/auth.js');
  assert.equal(resolveRelativeSpecifier(from, '@agentdevjs/core'), null);
  assert.equal(resolveRelativeSpecifier(from, 'node:fs'), null);
  assert.equal(resolveRelativeSpecifier(from, '../../AgentDev/packages/core'), null);
  assert.equal(resolveRelativeSpecifier(from, './no-such-file-xyz.js'), null);
});

test('findCyclicSccs 找出多节点环、自环，无环时为空', () => {
  const g = (edges) => {
    const map = new Map();
    for (const [k, vs] of Object.entries(edges)) map.set(k, new Set(vs));
    return map;
  };
  // a -> b -> c -> a 三角环
  assert.deepEqual(findCyclicSccs(g({ a: ['b'], b: ['c'], c: ['a'], d: ['a'] })).length, 1);
  // 自环
  assert.deepEqual(findCyclicSccs(g({ a: ['a'] })).length, 1);
  // DAG
  assert.deepEqual(findCyclicSccs(g({ a: ['b'], b: ['c'] })), []);
});

test('cycleFingerprint 与成员顺序无关', () => {
  assert.equal(cycleFingerprint(['b.ts', 'a.ts']), cycleFingerprint(['a.ts', 'b.ts']));
});

test('diffCycles 区分新增环与已消失环', () => {
  const { added, resolved } = diffCycles(['a|b', 'c|d'], ['a|b', 'e|f']);
  assert.deepEqual(added, ['c|d']);
  assert.deepEqual(resolved, ['e|f']);
});
