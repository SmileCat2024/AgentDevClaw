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

// 常量经沙箱导出（避免测试硬编码 ROW_H/LANE_W，改视觉参数不破坏断言）
function constants() {
  return run('window.GitGraph.constants');
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
    const C = constants();
    assert.ok(out.svg.startsWith('<svg'));
    assert.ok(out.svg.includes('circle'));
    assert.equal(out.height, 2 * C.ROW_H);
    assert.equal(out.width, 8 * 2 + 1 * C.LANE_W); // PAD_X*2 + laneCount*LANE_W
  });

  it('HEAD row gets the bullseye node and merge commits render hollow', () => {
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([
        {hash:'h',parents:['m']},
        {hash:'m',parents:['a','b']},
        {hash:'a',parents:[]},
        {hash:'b',parents:[]}
      ]);
      return window.GitGraph.buildGraphSvg(lanes, 0);
    })()`);
    // HEAD：加大空心环 + 中心实心点
    assert.ok(out.svg.includes('git-dot-head"'));
    assert.ok(out.svg.includes('git-dot-head-core'));
    // merge 提交：空心圆（fill 为面板底色变量）
    assert.ok(out.svg.includes('git-dot-merge'));
    assert.ok(out.svg.includes('var(--git-node-bg'));
  });

  it('ahead (unpushed) commits render as dashed rings, pushed ones solid', () => {
    // Set 必须在 VM 同一 realm 内创建（跨 realm 的 instanceof Set 会为 false）
    const out = run(`(function(){
      const commits = [
        {hash:'head1',parents:['mid1'],refs:[]},
        {hash:'mid1',parents:['base1'],refs:[]},
        {hash:'base1',parents:[],refs:[]}
      ];
      const ahead = new Set(['head1','mid1']);
      const lanes = window.GitGraph.computeLanes(commits);
      return window.GitGraph.buildGraphSvg(lanes, 0, ahead);
    })()`);
    // ahead 的 HEAD + 普通提交 → 虚线空心圈；base1 已推送 → 实心小圆
    assert.ok(out.svg.includes('stroke-dasharray="2.5 2.5"'));
    // 两个 ahead 节点都带虚线
    assert.equal((out.svg.match(/stroke-dasharray="2.5 2.5"/g) || []).length, 2);
    // base1 为已推送普通提交 —— 实心（git-dot 无 dasharray 且非 merge/head）
    assert.ok(out.svg.includes('git-dot git-dot"') === false); // 无该形态，普通节点 class 为 git-dot
  });

  it('no ahead set (or non-Set) falls back to solid nodes', () => {
    const out = run(`(function(){
      const commits = [{hash:'a',parents:[]}];
      const lanes = window.GitGraph.computeLanes(commits);
      return window.GitGraph.buildGraphSvg(lanes, 0, undefined);
    })()`);
    assert.ok(!out.svg.includes('stroke-dasharray'));
  });

  // 回归：服务端 hash 与 parents 统一为 12 位短哈希后，边的 toRow 必须能
  // 命中行号（历史上 40 位 parents 匹配 12 位 hash 失败，全图退化为截断线）
  it('edges resolve toRow for 12-char short-hash form (server payload shape)', () => {
    const h = (n) => String(n).padStart(12, '0');
    const r = run(`(function(){
      return window.GitGraph.computeLanes([
        {hash:'${h(1)}',parents:['${h(2)}']},
        {hash:'${h(2)}',parents:['${h(3)}','${h(4)}']},
        {hash:'${h(3)}',parents:['${h(5)}']},
        {hash:'${h(4)}',parents:['${h(5)}']},
        {hash:'${h(5)}',parents:[]}
      ]);
    })()`);
    assert.equal(r.edges.length, 5);
    for (const e of r.edges) {
      assert.notEqual(e.toRow, null, 'edge must resolve to a row, got truncation');
    }
    // 第二提交是 merge：应有跨泳道曲线边
    assert.ok(r.edges.some((e) => e.fromLane !== e.toLane));
  });
});
