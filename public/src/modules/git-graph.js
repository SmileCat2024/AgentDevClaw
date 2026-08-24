/**
 * git-graph.js — 提交历史泳道算法与 SVG 构建（纯函数，无 DOM 依赖）
 *
 * computeLanes：把 git log 输出（新→旧，含 parents）分配到泳道，
 * 产出节点 lane 与连线（直线/合并曲线/截断线），供渲染层直接绘制。
 *
 * 算法为经典槽位泳道模型（参考 gitgraph.js / gitx 的 lane 思路）：
 *   - 每条泳道任一时刻最多追踪一个"下一个待绘制提交"的哈希
 *   - 节点到来时消费掉追踪自己的泳道；第一父提交优先继承当前泳道，
 *     其余父提交开新泳道（形成分叉线）；若父提交已被其他泳道追踪，
 *     则画合并曲线而不重复占用
 *
 * buildGraphSvg：把结果画成纵向 SVG。行高/列宽为常量，节点圆 + 连线
 * 用 lane 色板（CSS 变量 --git-c0..5，深浅主题在 layout.css 定义）。
 *
 * 模块无 DOM 依赖，window 只作挂载点（测试沙箱可直接提取纯函数）。
 */
(function () {
  'use strict';

  const ROW_H = 26;      // 每行高度（与 CSS .git-history-row 严格对齐）
  const LANE_W = 14;     // 泳道列宽
  const PAD_X = 8;       // 左内边距
  const PAD_TOP = 13;    // 首行圆心 y
  const DOT_R = 4;       // 节点半径

  /**
   * 计算泳道分配。
   * @param {Array<{hash:string, parents:string[]}>} commits 新→旧
   * @returns {{ commits: Array<(typeof commits)[0] & {lane:number}>,
   *            edges: Array<{row:number, fromLane:number, toLane:number,
   *                            toRow:number|null}>,
   *            laneCount:number }}
   *   edges.toRow === null 表示父提交在截断窗口外（画截断线）。
   */
  function computeLanes(commits) {
    const tracking = new Map(); // parentHash -> lane（该泳道正在追踪的提交）
    let laneCount = 0;
    const rowOf = new Map();    // hash -> row（第二遍补 toRow 用）
    const nodes = [];
    const edges = [];

    commits.forEach(function (c, row) {
      rowOf.set(c.hash, row);
    });

    commits.forEach(function (c, row) {
      let lane;
      if (tracking.has(c.hash)) {
        lane = tracking.get(c.hash);
        tracking.delete(c.hash);
      } else {
        lane = firstFreeLane(tracking, laneCount);
        if (lane === laneCount) laneCount++;
      }

      const parents = Array.isArray(c.parents) ? c.parents : [];
      parents.forEach(function (p, j) {
        if (tracking.has(p)) {
          // 父提交已被其他泳道追踪：画合并曲线
          edges.push({ row: row, fromLane: lane, toLane: tracking.get(p), toRow: rowOf.has(p) ? rowOf.get(p) : null });
        } else {
          let target;
          if (j === 0) {
            target = lane; // 第一父提交继承当前泳道
          } else {
            target = firstFreeLane(tracking, laneCount);
            if (target === laneCount) laneCount++;
          }
          tracking.set(p, target);
          edges.push({ row: row, fromLane: lane, toLane: target, toRow: rowOf.has(p) ? rowOf.get(p) : null });
        }
      });

      nodes.push({ hash: c.hash, lane: lane });
    });

    return {
      commits: commits.map(function (c, i) { return Object.assign({}, c, { lane: nodes[i].lane }); }),
      edges: edges,
      laneCount: laneCount,
    };
  }

  /** 返回 laneCount 内第一个空闲泳道号（无空闲则返回 laneCount，由调用方扩容） */
  function firstFreeLane(tracking, laneCount) {
    const used = new Set(tracking.values());
    for (let i = 0; i < laneCount; i++) {
      if (!used.has(i)) return i;
    }
    return laneCount;
  }

  function laneColor(lane) {
    return 'var(--git-c' + (lane % 6) + ')';
  }

  function xOf(lane) { return PAD_X + lane * LANE_W + DOT_R; }
  function yOf(row) { return PAD_TOP + row * ROW_H; }

  /**
   * 构建 SVG 字符串（只含连线与节点圆；文本与分支胶囊由 HTML 层叠加，
   * 便于省略号与悬停交互）。
   * @param {{commits:Array, edges:Array, laneCount:number}} lanes computeLanes 结果
   * @param {number} headRow HEAD 所在行
   */
  function buildGraphSvg(lanes, headRow) {
    const rows = lanes.commits.length;
    const width = PAD_X * 2 + Math.max(1, lanes.laneCount) * LANE_W;
    const height = rows * ROW_H;
    if (rows === 0) return { width: 0, height: 0, svg: '' };

    const parts = [];
    // 连线在节点下层
    lanes.edges.forEach(function (e) {
      const x1 = xOf(e.fromLane);
      const y1 = yOf(e.row);
      if (e.toRow === null) {
        // 父提交在窗口外：淡出截断线
        parts.push('<line class="git-edge git-edge-trunc" x1="' + x1 + '" y1="' + y1 + '" x2="' + x1 + '" y2="' + (height - 4) + '" stroke="' + laneColor(e.toLane) + '"/>');
        return;
      }
      const x2 = xOf(e.toLane);
      const y2 = yOf(e.toRow);
      if (e.fromLane === e.toLane) {
        parts.push('<line class="git-edge" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + laneColor(e.fromLane) + '"/>');
      } else {
        // 合并/分叉：二次贝塞尔，控制点取中点 y，形成平滑 S 曲线
        const my = (y1 + y2) / 2;
        parts.push('<path class="git-edge git-edge-merge" d="M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + my + ', ' + x2 + ' ' + my + ', ' + x2 + ' ' + y2 + '" fill="none" stroke="' + laneColor(e.fromLane) + '"/>');
      }
    });

    // 节点圆（HEAD 双环高亮）
    lanes.commits.forEach(function (c, row) {
      const x = xOf(c.lane);
      const y = yOf(row);
      if (row === headRow) {
        parts.push('<circle class="git-dot git-dot-head-ring" cx="' + x + '" cy="' + y + '" r="' + (DOT_R + 3) + '" fill="none" stroke="' + laneColor(c.lane) + '"/>');
      }
      parts.push('<circle class="git-dot" cx="' + x + '" cy="' + y + '" r="' + DOT_R + '" fill="' + laneColor(c.lane) + '"/>');
    });

    return {
      width: width,
      height: height,
      svg: '<svg class="git-graph-svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' + parts.join('') + '</svg>',
    };
  }

  window.GitGraph = {
    computeLanes: computeLanes,
    buildGraphSvg: buildGraphSvg,
    constants: { ROW_H: ROW_H, LANE_W: LANE_W },
  };
})();
