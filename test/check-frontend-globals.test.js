import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { collectGlobalsFromSource, compareWithBaseline } from '../scripts/check-frontend-globals.mjs';

describe('CLI 冒烟', () => {
  it('当前基线通过态下 exit 0（防脚本崩溃/基线格式损坏静默失效）', () => {
    // 观察点：真实子进程退出码。pretest:core 依赖此脚本 exit 0 放行测试链，
    // 脚本 import 失败、espree 升级破坏解析或基线 JSON 损坏都会在此暴露。
    const stdout = execFileSync('node', ['scripts/check-frontend-globals.mjs'], { encoding: 'utf8' });
    assert.match(stdout, /通过/);
  });
});

describe('collectGlobalsFromSource', () => {
  it('顶层 var/let/const 归 state，顶层 function/class 归 behavior', () => {
    const r = collectGlobalsFromSource(`
      let a = 1;
      var b = 2;
      const c = 3;
      function fn() {}
      class K {}
    `);
    assert.deepEqual(r.state, ['a', 'b', 'c']);
    assert.deepEqual(r.behavior, ['K', 'fn']);
  });

  it('IIFE 与函数体内的声明不算顶层暴露', () => {
    const r = collectGlobalsFromSource(`
      (function () {
        let inner = 1;
        var innerVar = 2;
        function innerFn() {}
      })();
      function outer() {
        let alsoInner = 3;
      }
    `);
    assert.deepEqual(r.state, []);
    assert.deepEqual(r.behavior, ['outer']);
  });

  it('任意深度的 window 赋值按前缀分层：下划线键归 state，其余归 behavior', () => {
    const r = collectGlobalsFromSource(`
      (function () {
        window.refreshThreads = function () {};
        window._priv = 1;
        window['computedKey'] = 2;
        if (true) { window.late = 3; }
      })();
    `);
    assert.deepEqual(r.state, ['_priv']);
    assert.deepEqual(r.behavior, ['computedKey', 'late', 'refreshThreads']);
  });

  it('window 属性链赋值不展开：只记直接键，长链靠首键的整体赋值语句记录', () => {
    const r = collectGlobalsFromSource(`
      window.ClawFW = window.ClawFW || {};
      window.ClawFW.someHelper = () => {};
      window.a.b.c = 1;
    `);
    // window.a.b.c = 1 本身不产生暴露键：a 的暴露由 window.a = … 语句记录
    //（若存在），与 ClawFW.someHelper 不单独记键同理——内部键由 ESLint
    // ClawFW 下划线规则与 owner 模块纪律治理。
    assert.deepEqual(r.behavior, ['ClawFW']);
    assert.deepEqual(r.state, []);
  });

  it('非 window 的成员赋值与函数体内局部写不产生暴露', () => {
    const r = collectGlobalsFromSource(`
      (function () {
        const obj = {};
        obj.x = 1;
        let local = 2;
        local += 3;
      })();
    `);
    assert.deepEqual(r.state, []);
    assert.deepEqual(r.behavior, []);
  });
});

describe('compareWithBaseline', () => {
  const baseline = {
    'a.js': { state: ['s1'], behavior: ['f1'] },
  };

  it('同键集合时无新增无消失', () => {
    const r = compareWithBaseline(baseline, {
      'a.js': { state: ['s1'], behavior: ['f1'] },
    });
    assert.deepEqual(r, { addedState: [], addedBehavior: [], removed: [] });
  });

  it('存量文件新增 state 与 behavior 分别归层', () => {
    const r = compareWithBaseline(baseline, {
      'a.js': { state: ['s1', 's2'], behavior: ['f1', 'f2'] },
    });
    assert.deepEqual(r.addedState, [{ file: 'a.js', key: 's2' }]);
    assert.deepEqual(r.addedBehavior, [{ file: 'a.js', key: 'f2' }]);
    assert.deepEqual(r.removed, []);
  });

  it('基线中不存在的文件（新文件）所有键计为新增', () => {
    const r = compareWithBaseline(baseline, {
      'new.js': { state: ['ns'], behavior: ['nf'] },
    });
    assert.deepEqual(r.addedState, [{ file: 'new.js', key: 'ns' }]);
    assert.deepEqual(r.addedBehavior, [{ file: 'new.js', key: 'nf' }]);
  });

  it('消失的键（含整文件消失）计入 removed', () => {
    const r = compareWithBaseline(
      { 'a.js': { state: ['s1'], behavior: ['f1'] }, 'gone.js': { state: ['g1'], behavior: [] } },
      { 'a.js': { state: [], behavior: ['f1'] } },
    );
    assert.deepEqual(r.removed, [
      { file: 'a.js', key: 's1' },
      { file: 'gone.js', key: 'g1' },
    ]);
  });
});
