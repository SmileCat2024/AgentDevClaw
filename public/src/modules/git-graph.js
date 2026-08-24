/**
 * git-graph.js — 提交历史泳道算法与 SVG 构建（纯函数，无 DOM 依赖）
 *
 * computeLanes：把 git log --topo-order 输出（新→旧，含 parents）分配到
 * 泳道，产出节点 lane 与连线（直线/合并曲线/截断线），供渲染层绘制。
 *
 * 算法为经典槽位泳道模型（参考 gitgraph.js / gitx 的 lane 思路）：
 *   - 每条泳道任一时刻最多追踪一个"下一个待绘制提交"的哈希
 *   - 节点到来时消费掉追踪自己的泳道；第一父提交优先继承当前泳道，
 *     其余父提交开新泳道（形成分叉线）；若父提交已被其他泳道追踪，
 *     则画合并曲线而不重复占用
 *   - 前提：parents 与 hash 必须同为 12 位短哈希（服务端已统一截断），
 *     长度不一致会导致 rowOf 匹配全部失败、边全部退化为截断线
 *
 * buildGraphSvg：纵向 SVG，视觉对齐 VS Code Git Graph——
 *   - lane 色为固定色板（不随主题切换，深浅底均保证可读）
 *   - 普通提交：实心小圆；merge 提交：空心圆（露出面板底色遮断穿线）
 *   - HEAD：加大空心环 + 中心实心点（靶心形制）
 *   - 合并/分叉：三次 Bézier，起点竖直出发、终点竖直接入，无尖锐折角
 *   - 绘制顺序：先全部连线，再全部节点（线从节点下方穿过）
 *
 * 模块无 DOM 依赖，window 只作挂载点（测试沙箱可直接提取纯函数）。
 */
(function () {
  'use strict';

  const ROW_H = 26;      // 每行高度（与 CSS .git-history-row 严格对齐）
  const LANE_W = 12;     // 泳道列宽
  const PAD_X = 8;       // 左内边距
  const PAD_TOP = 13;    // 首行圆心 y = ROW_H / 2
  const DOT_R = 4;       // 普通节点半径
  const HEAD_R = 6;      // HEAD 节点外环半径
  const EDGE_W = 1.5;    // 连线线宽

  /** VS Code Git Graph 风格 lane 色板（固定色，不随主题变） */
  const PALETTE = ['#4DA3F5', '#F0B000', '#E91E78', '#42B9B2', '#C56B00', '#8E7CC3'];

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
      let mergeInLane = null;
      parents.forEach(function (p, j) {
        let toLane;
        if (tracking.has(p)) {
          // 父提交已被其他泳道追踪：画合并曲线
          toLane = tracking.get(p);
          edges.push({ row: row, fromLane: lane, toLane: toLane, toRow: rowOf.has(p) ? rowOf.get(p) : null });
        } else {
          if (j === 0) {
            toLane = lane; // 第一父提交继承当前泳道
          } else {
            toLane = firstFreeLane(tracking, laneCount);
            if (toLane === laneCount) laneCount++;
          }
          tracking.set(p, toLane);
          edges.push({ row: row, fromLane: lane, toLane: toLane, toRow: rowOf.has(p) ? rowOf.get(p) : null });
        }
        // merge 提交的"被合并进来"分支色 = 非第一父所在泳道
        if (j > 0 && mergeInLane === null) mergeInLane = toLane;
      });

      nodes.push({ hash: c.hash, lane: lane, mergeInLane: mergeInLane });
    });

    return {
      commits: commits.map(function (c, i) {
        return Object.assign({}, c, { lane: nodes[i].lane, mergeInLane: nodes[i].mergeInLane });
      }),
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
    return PALETTE[lane % PALETTE.length];
  }

  function xOf(lane) { return PAD_X + lane * LANE_W + DOT_R; }
  function yOf(row) { return PAD_TOP + row * ROW_H; }

  /**
   * 构建 SVG 字符串（只含连线与节点圆；文本与分支胶囊由 HTML 层叠加，
   * 便于省略号与悬停交互）。
   * @param {{commits:Array, edges:Array, laneCount:number}} lanes computeLanes 结果
   * @param {number} headRow HEAD 所在行
   * @param {Set<string>} [aheadSet] 未推送提交哈希集合——命中者画虚线空心圈
   *   （VS Code「传出的更改」形制：实线=已推送，虚线=仅本地）
   * @param {Array<number>} [rowTops] 每行圆心的纵向绝对 y（已累加展开详情偏移）。
   *   缺省退化为等距行（不展开时）。展开提交详情后必须传入，否则泳道不跟随
   *   文字列下移而错位。
   */
  function buildGraphSvg(lanes, headRow, aheadSet, rowTops) {
    const rows = lanes.commits.length;
    const width = PAD_X * 2 + Math.max(1, lanes.laneCount) * LANE_W;
    const height = rowTops ? (rowTops[rows - 1] + DOT_R) : rows * ROW_H;
    if (rows === 0) return { width: 0, height: 0, svg: '' };
    const Y = (row) => (Array.isArray(rowTops) && rowTops[row] != null ? rowTops[row] : yOf(row));

    const edgeParts = [];
    const dotParts = [];

    // ── 先画全部连线（节点随后覆盖在线上） ──
    lanes.edges.forEach(function (e) {
      const y1 = Y(e.row);
      if (e.toRow === null) {
        // 父提交在窗口外：淡出截断线
        edgeParts.push('<line class="git-edge git-edge-trunc" x1="' + xOf(e.fromLane) + '" y1="' + y1 + '" x2="' + xOf(e.fromLane) + '" y2="' + (height - 4) + '" stroke="' + laneColor(e.toLane) + '" stroke-width="' + EDGE_W + '"/>');
        return;
      }
      const y2 = Y(e.toRow);
      if (e.fromLane === e.toLane) {
        edgeParts.push('<line class="git-edge" x1="' + xOf(e.fromLane) + '" y1="' + y1 + '" x2="' + xOf(e.toLane) + '" y2="' + y2 + '" stroke="' + laneColor(e.fromLane) + '" stroke-width="' + EDGE_W + '"/>');
      } else {
        // 合并/分叉：三次 Bézier——起点竖直出发，中段平滑横移，终点竖直接入
        const k = Math.min(ROW_H * 0.6, (y2 - y1) / 2);
        edgeParts.push('<path class="git-edge git-edge-merge" d="M ' + xOf(e.fromLane) + ' ' + y1
          + ' C ' + xOf(e.fromLane) + ' ' + (y1 + k) + ', ' + xOf(e.toLane) + ' ' + (y2 - k) + ', ' + xOf(e.toLane) + ' ' + y2
          + '" fill="none" stroke="' + laneColor(e.fromLane) + '" stroke-width="' + EDGE_W + '"/>');
      }
    });

    // ── 再画节点：普通实心 / merge 空心 / HEAD 靶心 / 未推送虚线圈 ──
    lanes.commits.forEach(function (c, row) {
      const x = xOf(c.lane);
      const y = Y(row);
      const color = isMerge(c) && c.mergeInLane != null ? laneColor(c.mergeInLane) : laneColor(c.lane);
      const isAhead = aheadSet instanceof Set && aheadSet.has(c.hash);
      if (row === headRow) {
        // HEAD：加大空心环 + 中心实心点（◎ 靶心形制）；未推送时外环虚线
        dotParts.push('<circle class="git-dot git-dot-head' + (isAhead ? ' git-dot-ahead' : '') + '" cx="' + x + '" cy="' + y + '" r="' + HEAD_R + '" fill="var(--git-node-bg, #1E1E1E)" stroke="' + color + '" stroke-width="2"' + (isAhead ? ' stroke-dasharray="2.5 2.5"' : '') + '/>');
        dotParts.push('<circle class="git-dot git-dot-head-core" cx="' + x + '" cy="' + y + '" r="' + (DOT_R - 1.5) + '" fill="' + color + '"/>');
      } else if (isAhead && !isMerge(c)) {
        // 未推送提交：虚线空心圈（露出面板底色遮断穿线）
        dotParts.push('<circle class="git-dot git-dot-ahead" cx="' + x + '" cy="' + y + '" r="' + (DOT_R + 0.5) + '" fill="var(--git-node-bg, #1E1E1E)" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="2.5 2.5"/>');
      } else if (isMerge(c)) {
        // merge 提交：空心圆，内部为面板底色（遮断从下方穿过的线）；色取被并入分支
        dotParts.push('<circle class="git-dot git-dot-merge" cx="' + x + '" cy="' + y + '" r="' + (DOT_R + 0.5) + '" fill="var(--git-node-bg, #1E1E1E)" stroke="' + color + '" stroke-width="2"/>');
      } else {
        dotParts.push('<circle class="git-dot" cx="' + x + '" cy="' + y + '" r="' + DOT_R + '" fill="' + color + '"/>');
      }
    });

    return {
      width: width,
      height: height,
      svg: '<svg class="git-graph-svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' + edgeParts.join('') + dotParts.join('') + '</svg>',
    };
  }

  function isMerge(c) {
    return (c.parents || []).length > 1;
  }

  window.GitGraph = {
    computeLanes: computeLanes,
    buildGraphSvg: buildGraphSvg,
    constants: { ROW_H: ROW_H, LANE_W: LANE_W, PALETTE: PALETTE },
  };
})();
