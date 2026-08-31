/**
 * git-graph.js 泳道算法测试
 *
 * 用 frontend-vm 沙箱加载 public/src/modules/git-graph.js，验证复刻 VS Code
 * SCM 图形视图（scmHistory.ts）后的槽位模型与 SVG 输出：
 *   - 槽位逐行传递：第一父继承被消费槽位的位置与颜色，其余父追加到行尾
 *   - 重复槽位（merge 的第二父已被追踪）存在一行后随消费归并
 *   - 父在窗口外时槽位保留到最后（无"截断线"概念）
 *   - 颜色：refs 配色表（当前分支主色/上游副色）+ 轮转色板
 *   - SVG：HEAD 空心环、merge 双环、全无虚线、rowTops 偏移
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

describe('computeLanes swimlane model', () => {
  it('linear history keeps a single slot on column 0', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'a',parents:['b']}, {hash:'b',parents:['c']}, {hash:'c',parents:[]}
    ])`);
    assert.equal(r.rows.length, 3);
    assert.deepEqual(r.rows.map((row) => row.circleIndex), [0, 0, 0]);
    // 首行出列追踪 b；根提交（无父）出列为空
    assert.deepEqual(r.rows[0].outputSwimlanes.map((s) => s.id), ['b']);
    assert.deepEqual(r.rows[2].outputSwimlanes, []);
    assert.equal(r.laneCount, 1);
  });

  it('merge: second parent appends a slot; duplicate slot lives one row then merges', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'m',parents:['x','y']},
      {hash:'x',parents:['b']},
      {hash:'y',parents:['b']},
      {hash:'b',parents:[]}
    ])`);
    // m 行：出列 [x, y]——第二父 y 追加到末尾
    assert.deepEqual(r.rows[0].outputSwimlanes.map((s) => s.id), ['x', 'y']);
    // x 行：第一父 b 继承位置 0，y 槽位原位保留
    assert.deepEqual(r.rows[1].outputSwimlanes.map((s) => s.id), ['b', 'y']);
    // y 行：圆在第 1 列；第二父 b 已被追踪 → 重复槽位
    assert.equal(r.rows[2].circleIndex, 1);
    assert.deepEqual(r.rows[2].outputSwimlanes.map((s) => s.id), ['b', 'b']);
    // b 行：一次性消费两个同 id 槽位（circleIndex 取首个），只留一份第一父
    assert.deepEqual(r.rows[3].inputSwimlanes.map((s) => s.id), ['b', 'b']);
    assert.equal(r.rows[3].circleIndex, 0);
    assert.deepEqual(r.rows[3].outputSwimlanes, []);
  });

  it('fork (two children of one base): second child sits in its own column', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'x',parents:['b']},
      {hash:'y',parents:['b']},
      {hash:'b',parents:[]}
    ])`);
    // y 不在任何槽位 → 圆放在入列末尾（新列）；第一父 b 追加产生重复槽位
    assert.equal(r.rows[1].circleIndex, 1);
    assert.deepEqual(r.rows[1].outputSwimlanes.map((s) => s.id), ['b', 'b']);
    assert.deepEqual(r.rows[2].inputSwimlanes.map((s) => s.id), ['b', 'b']);
  });

  it('parent outside the window: slot persists to the last row (no truncation concept)', () => {
    const r = run(`window.GitGraph.computeLanes([{hash:'h',parents:['GONE']}])`);
    assert.equal(r.rows.length, 1);
    // 槽位保留在出列中（渲染为延伸到已加载内容末尾的普通竖线）
    assert.deepEqual(r.rows[0].outputSwimlanes.map((s) => s.id), ['GONE']);
  });

  it('octopus merge (three parents) appends two extra slots', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'o',parents:['p1','p2','p3']},
      {hash:'p1',parents:[]}, {hash:'p2',parents:[]}, {hash:'p3',parents:[]}
    ])`);
    assert.deepEqual(r.rows[0].outputSwimlanes.map((s) => s.id), ['p1', 'p2', 'p3']);
    // 根提交无父 → 出列为空，后续行的入列为空、圆落在第 0 列
    assert.deepEqual(r.rows.map((row) => row.circleIndex), [0, 0, 0, 0]);
    assert.equal(r.laneCount, 3);
  });

  it('slot positions are stable across interleaved side branches', () => {
    const r = run(`window.GitGraph.computeLanes([
      {hash:'m1',parents:['m2','s1']},
      {hash:'s1',parents:['m2']},
      {hash:'m2',parents:['m3','s2']},
      {hash:'s2',parents:['m3']},
      {hash:'m3',parents:[]}
    ])`);
    // s1 行：主线槽位 0 原位保留，s1 槽位 1 被第一父 m2 原位替换
    assert.deepEqual(r.rows[1].outputSwimlanes.map((s) => s.id), ['m2', 'm2']);
    // m2 行：消费两个 m2 槽位 → [m3, s2]
    assert.deepEqual(r.rows[2].outputSwimlanes.map((s) => s.id), ['m3', 's2']);
    // s2 行：[m3, m3]
    assert.deepEqual(r.rows[3].outputSwimlanes.map((s) => s.id), ['m3', 'm3']);
    // 主线（m 链）圆恒在第 0 列
    for (const row of r.rows) {
      if (row.hash.startsWith('m')) assert.equal(row.circleIndex, 0);
    }
  });

  // 回归：服务端 hash 与 parents 统一为 12 位短哈希，槽位 id 匹配依赖
  // 哈希等值（历史上长度不一致导致全图匹配失败）
  it('resolves slots for the 12-char short-hash server payload', () => {
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
    assert.equal(r.rows.length, 5);
    // h3 行：第一父 h5 替换自身槽位，h4 槽位原位保留（单父无重复追加）
    assert.deepEqual(r.rows[2].outputSwimlanes.map((s) => s.id), [h(5), h(4)]);
    // h4 行：第一父 h5 已在槽位 0 → 替换后产生重复槽位 [h5, h5]
    assert.deepEqual(r.rows[3].outputSwimlanes.map((s) => s.id), [h(5), h(5)]);
    assert.deepEqual(r.rows[4].outputSwimlanes, []);
  });
});

describe('computeLanes colors', () => {
  it('current branch ref paints the main line; tracking ref repaints it downstream', () => {
    const C = constants();
    const r = run(`window.GitGraph.computeLanes([
      {hash:'a',parents:['b'],refs:[{type:'head',name:'main'},{type:'local',name:'main'}]},
      {hash:'b',parents:['c'],refs:[{type:'remote',name:'origin/main'}]},
      {hash:'c',parents:[],refs:[]}
    ], {currentBranch:'main', trackingBranch:'origin/main'})`);
    // HEAD（main）= 主色
    assert.equal(r.rows[0].circleColor, C.CURRENT_COLOR);
    // b 带 origin/main → 副色；第一父槽位随之换色（主线在此"转紫"）
    assert.equal(r.rows[1].circleColor, C.REMOTE_COLOR);
    assert.equal(r.rows[1].outputSwimlanes[0].color, C.REMOTE_COLOR);
  });

  it('side branches rotate the palette; merge circle inherits the first-parent slot color', () => {
    const C = constants();
    const r = run(`window.GitGraph.computeLanes([
      {hash:'m',parents:['x','y']},
      {hash:'x',parents:['b']},
      {hash:'y',parents:['b']},
      {hash:'b',parents:[]}
    ])`);
    // 首行 m 无 refs：第一父 x 取色板第 1 色，第二父 y 取第 2 色
    assert.deepEqual(r.rows[0].outputSwimlanes.map((s) => s.color),
      [C.PALETTE[0], C.PALETTE[1]]);
    // merge 圆色 = 圆心槽位色（第一父方向），而非被并入分支色
    assert.equal(r.rows[0].circleColor, C.PALETTE[0]);
  });
});

describe('buildGraphSvg', () => {
  it('sizes to rows and lane count', () => {
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([{hash:'a',parents:['b']},{hash:'b',parents:[]}]);
      return window.GitGraph.buildGraphSvg(lanes);
    })()`);
    const C = constants();
    assert.ok(out.svg.startsWith('<svg'));
    // 总高 = 顶部半行（圆心居中于首行）+ rows*ROW_H；逐行几何每行画到行底
    assert.equal(out.height, C.ROW_H / 2 + 2 * C.ROW_H);
    assert.equal(out.width, 16 + 2 * C.LANE_W); // PAD_X*2 + (laneCount+1)*LANE_W
  });

  it('HEAD renders a hollow ring; merge renders a double ring', () => {
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([
        {hash:'h',parents:['m'],refs:[{type:'head',name:'main'}]},
        {hash:'m',parents:['a','b']},
        {hash:'a',parents:[]},
        {hash:'b',parents:[]}
      ]);
      return window.GitGraph.buildGraphSvg(lanes);
    })()`);
    // HEAD：r7 外环 + r4 底色中心孔
    assert.ok(out.svg.includes('r="7"'), 'HEAD outer ring');
    assert.ok(out.svg.includes('r="4"'), 'HEAD core hole');
    // merge：r6 外环 + r3 内环（双环）
    assert.ok(out.svg.includes('r="6"'), 'merge outer ring');
    assert.ok(out.svg.includes('r="3"'), 'merge inner ring');
    assert.ok(out.svg.includes('git-dot-merge'));
  });

  it('no dashed strokes anywhere (no truncation lines, no ahead rings)', () => {
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([{hash:'h',parents:['GONE']}]);
      return window.GitGraph.buildGraphSvg(lanes);
    })()`);
    assert.ok(!out.svg.includes('stroke-dasharray'));
    // 窗口外父 = 普通竖线延伸（git-edge）
    assert.ok(out.svg.includes('git-edge'));
  });

  it('merge fork arc and duplicate-slot merge arc both render', () => {
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([
        {hash:'m',parents:['x','y']},
        {hash:'x',parents:['b']},
        {hash:'y',parents:['b']},
        {hash:'b',parents:[]}
      ]);
      return window.GitGraph.buildGraphSvg(lanes);
    })()`);
    // y 行：重复槽位的合并弧（行顶 A 弧 + 横线）；m 行：第二父分叉弧
    const arcs = out.svg.match(/<path[^>]*git-edge[^>]*>/g) || [];
    assert.ok(arcs.length >= 2, 'merge and fork arcs exist');
    assert.ok(out.svg.includes('A 12 12'), 'arc radius equals lane width');
  });

  it('rowTops shifts rows down to leave room for expanded details', () => {
    const { ROW_H } = constants();
    const top3 = 14 + ROW_H * 2 + 40;
    const out = run(`(function(){
      const commits = [
        {hash:'a',parents:['b']},
        {hash:'b',parents:['c']},
        {hash:'c',parents:[]}
      ];
      const lanes = window.GitGraph.computeLanes(commits);
      const tops = [14, 14 + ${ROW_H}, ${top3}];
      return window.GitGraph.buildGraphSvg(lanes, tops);
    })()`);
    // 第三行圆心 y = rowTops[2] + ROW_H/2
    assert.ok(out.svg.includes('cy="' + (top3 + ROW_H / 2) + '"'), 'third node shifted down');
    assert.equal(out.height, top3 + ROW_H);
  });

  it('expanded row: lower vline spans through the detail region to the next row top', () => {
    const { ROW_H } = constants();
    const nextTop = ROW_H + 40; // 行 0 下方有 40px 详情，行 1 行顶被推到 66
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([
        {hash:'a',parents:['b']},
        {hash:'b',parents:[]}
      ]);
      return window.GitGraph.buildGraphSvg(lanes, [0, ${nextTop}]);
    })()`);
    // 圆心仍对齐 26px 文本行中心，不下沉到展开区中央
    assert.ok(out.svg.includes('cy="' + ROW_H / 2 + '"'), 'dot stays on the text line');
    // 行 0 的下竖线贯通详情区，一直画到行 1 行顶（无缝衔接）
    assert.ok(out.svg.includes('V ' + nextTop), 'lower vline reaches next row top');
    assert.equal(out.height, nextTop + ROW_H);
  });

  it('expanded merge row: fork arc lands inside the standard pitch, then a vline continues down', () => {
    const { ROW_H } = constants();
    const nextTop = ROW_H + 40;
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([
        {hash:'m',parents:['x','y']},
        {hash:'x',parents:[]}
      ]);
      return window.GitGraph.buildGraphSvg(lanes, [0, ${nextTop}]);
    })()`);
    // 弧仍在标准行距内落地（半径不随行距拉伸），落地后竖直贯通
    assert.ok(out.svg.includes('A 12 12 0 0 1 32 ' + ROW_H), 'arc lands at standard pitch');
    assert.ok(out.svg.includes('M 32 ' + ROW_H + ' V ' + nextTop), 'continuation vline through detail region');
  });

  it('rowWidth follows each row’s own swimlane count (per-row text offset)', () => {
    const { LANE_W } = constants();
    const r = run(`(function(){
      const lanes = window.GitGraph.computeLanes([
        {hash:'a',parents:['b']},
        {hash:'m',parents:['x','y']},
        {hash:'x',parents:['b']},
        {hash:'y',parents:['b']},
        {hash:'b',parents:[]}
      ]);
      return [0,1,2,3,4].map((row) => window.GitGraph.rowWidth(lanes, row));
    })()`);
    // m 不在入列槽位中：b 穿透保留，x/y 追加 → 泳道数 3
    assert.deepEqual(r, [
      16 + 2 * LANE_W,
      16 + 4 * LANE_W,
      16 + 4 * LANE_W,
      16 + 4 * LANE_W,
      16 + 4 * LANE_W,
    ]);
  });

  it('outgoing mark: dashed node sits in the top band; main line joins the first row dot', () => {
    const { ROW_H, LANE_W } = constants();
    const cx = 8 + LANE_W; // xOf(0)
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([
        {hash:'a',parents:['b']},{hash:'b',parents:[]}
      ]);
      return window.GitGraph.buildGraphSvg(lanes, [${ROW_H}, ${ROW_H * 2}], {outgoing:true});
    })()`);
    assert.ok(out.svg.includes('stroke-dasharray:4,2'), 'dashed ring rendered');
    assert.ok(out.svg.includes('cy="' + ROW_H / 2 + '"'), 'node centered in the separator band');
    assert.ok(out.svg.includes('M ' + cx + ' ' + ROW_H / 2 + ' V ' + ROW_H),
      'main line runs from the node down to the first row top');
  });

  it('no outgoing mark: nothing drawn above the first row', () => {
    const out = run(`(function(){
      const lanes = window.GitGraph.computeLanes([{hash:'a',parents:['b']}]);
      return window.GitGraph.buildGraphSvg(lanes, [0, 26]);
    })()`);
    assert.ok(!out.svg.includes('git-dot-outgoing'));
    assert.ok(!out.svg.includes('stroke-dasharray'));
  });
});
