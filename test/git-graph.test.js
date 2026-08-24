/**
 * git-graph.js 泳道算法测试
 *
 * 用 frontend-vm 沙箱加载 public/src/modules/git-graph.js，
 * 验证 computeLanes 在线性 / 分叉 / 合并 / 截断窗口四种拓扑下的
 * 泳道分配与连线，以及 buildGraphSvg 的输出尺寸。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

let ctx;

before(() => {
  ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/git-graph.js');
});

// vm 沙箱与本 realm 的对象原型不同，assert 深比较会失败：
// 结果一律 JSON 序列化跨越沙箱边界
function run(expr) {
  return JSON.parse(ctx.run('JSON.stringify(' + expr + ')'));
}

describe('computeLanes topology', () => {
  it('linear history stays on lane 0', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'a',parents:['b']}, {hash:'b',parents:['c']}, {hash:'c',parents:[]}
    ])`);
    assert.equal(r.laneCount, 1);
    assert.deepEqual(r.commits.map((c) => c.lane), [0, 0, 0]);
    assert.equal(r.edges.length, 2);
    assert.deepEqual(r.edges[0], { row: 0, fromLane: 0, toLane: 0, toRow: 1 });
  });

  it('fork assigns the second child a new lane, both merge back to base', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'x',parents:['b']}, {hash:'y',parents:['b']}, {hash:'b',parents:[]}
    ])`);
    assert.equal(r.laneCount, 2);
    assert.deepEqual(r.commits.map((c) => c.lane), [0, 1, 0]);
    // x(lane0)->b 直线；y(lane1)->b 跨泳道曲线
    assert.deepEqual(r.edges[0], { row: 0, fromLane: 0, toLane: 0, toRow: 2 });
    assert.deepEqual(r.edges[1], { row: 1, fromLane: 1, toLane: 0, toRow: 2 });
  });

  it('merge commit draws curve to the already-tracked second parent', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'m',parents:['x','y']},
      {hash:'x',parents:['b']},
      {hash:'y',parents:['b']},
      {hash:'b',parents:[]}
    ])`);
    // m 消费 lane0（追踪 x）；第二父 y 已被 lane1 追踪 → 合并曲线 0→1
    assert.deepEqual(r.commits.map((c) => c.lane), [0, 0, 1, 0]);
    const mergeEdge = r.edges.find((e) => e.row === 0 && e.fromLane === 0 && e.toLane === 1);
    assert.ok(mergeEdge, 'merge edge 0->1 exists');
    assert.equal(mergeEdge.toRow, 2);
    // x、y 各自连到 b（row 3, lane0）
    assert.equal(r.edges.filter((e) => e.toRow === 3).length, 2);
  });

  it('parent outside the window produces a truncation edge (toRow null)', () => {
    const r = run(`window.GitGraph.computeLanes([{hash:'h',parents:['GONE']}])`);
    assert.equal(r.edges.length, 1);
    assert.equal(r.edges[0].toRow, null);
  });

  it('octopus merge (three parents) opens two extra lanes', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'o',parents:['p1','p2','p3']},
      {hash:'p1',parents:[]}, {hash:'p2',parents:[]}, {hash:'p3',parents:[]}
    ])`);
    assert.equal(r.laneCount, 3);
    // p2、p3 各占新泳道
    assert.equal(r.commits[2].lane, 1);
    assert.equal(r.commits[3].lane, 2);
  });

  it('lane is reused after its chain ends', () => {
    // 侧链结束后，后续分叉应复用释放的泳道而非无限扩容
    const r = run(`window.GitGraph.computeLanes([
      {hash:'a',parents:['base']},
      {hash:'side1',parents:['base']},
      {hash:'base',parents:[]},
      {hash:'main2',parents:['base2']},
      {hash:'side2',parents:['base2']},
      {hash:'base2',parents:[]}
    ])`);
    // 注意：base 之后的提交在 log 中更旧，窗口里 lane1 已释放
    // side2 应复用 lane1 而非开 lane2
    assert.equal(r.commits[4].lane, 1);
    assert.equal(r.laneCount, 2);
  });
});

describe('buildGraphSvg', () => {
  it('produces svg sized to rows and lanes', () => {
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([{hash:'a',parents:['b']},{hash:'b',parents:[]}]);
      return window.GitGraph.buildGraphSvg(lanes, 0);
    })()`);
    assert.ok(out.svg.startsWith('<svg'));
    assert.ok(out.svg.includes('circle'));
    assert.equal(out.height, 2 * 26);      // ROW_H = 26
    assert.equal(out.width, 8 * 2 + 1 * 14); // PAD_X*2 + laneCount*LANE_W
  });

  it('HEAD row gets the highlight ring', () => {
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([{hash:'a',parents:['b']},{hash:'b',parents:[]}]);
      return window.GitGraph.buildGraphSvg(lanes, 0);
    })()`);
    assert.ok(out.svg.includes('git-dot-head-ring'));
  });
});
