/**
 * git-graph.js — 提交历史泳道算法与 SVG 构建（纯函数，无 DOM 依赖）
 *
 * 复刻 VS Code 内置源代码管理图形视图的逻辑（上游实现：
 * microsoft/vscode src/vs/workbench/contrib/scm/browser/scmHistory.ts），
 * 包含其泳道模型、逐行几何与视觉形制：
 *
 * 泳道模型（computeLanes）：
 *   - 泳道不是"编号复用"而是"逐行传递的槽位数组"，每个槽位 { id, color }
 *     表示该线正在追踪的下一个提交。当前提交消费它在入列中的全部槽位，
 *     第一父继承首个被消费槽位的位置与颜色；其余父无条件追加到出列末尾，
 *     各自分配颜色（父提交带 refs 命中配色表则用该色，否则轮转色板）。
 *   - 槽位位置只由插入顺序决定，无中间回收：已存在的线位置恒定，主线
 *     恒在第 0 列，视觉稳定。重复槽位（merge 的第二父已被追踪时再追加）
 *     存在周期恰好一行，渲染为合并弧。
 *   - 父提交不在窗口内时槽位保留到最后（线自然终止），没有"截断线"概念。
 *
 * 逐行几何（buildGraphSvg）：
 *   - 每行只在行高内绘制，横向位移由固定半径圆弧完成，永无跨行长斜线：
 *       竖线 |            槽位未变位
 *       折线 |~,_|~       槽位左移（6px 竖直 → r5 弧 → 横线 → r5 弧 → 竖直）
 *       合并弧 /—         入列中的重复槽位汇入圆（行顶 r=泳道宽 圆弧 + 横线）
 *       分叉弧 —\         圆水平引出横线，行末 r=泳道宽 圆弧下行入新列
 *   - 行的下缘 = 下一行的行顶（rowTops 由面板实测 DOM 传入）：行距因
 *     「传出的更改」分隔行、展开详情等流式内容变大时，该行竖线与分叉弧
 *     自动向下贯通到下一行行顶，永不断裂（VS Code 逐行 SVG 覆盖整行高度
 *     的等价实现）。
 *   - rowWidth：每行图形列宽按该行自身泳道数计算（VS Code 同款），文本列
 *     以此为偏移——浅行靠左，深行随泳道右移。
 *   - marks.outgoing：顶部「传出的更改」节点（VS Code outgoing-changes
 *     节点）——虚线环画在主线泳道上，主线自节点下行衔接首行圆。
 *   - 节点形制：普通提交 r5 实心（底色描边遮断穿线）；merge r6+r3 双环；
 *     HEAD r7 外环 + r4 底色孔。线宽 1、linecap round、全强度不透明。
 *
 * 颜色：沿用 VS Code 的 refs 着色叙事——当前分支=主色、上游跟踪分支=副色
 * （主线在越过 origin/main 后由蓝转紫，表达"本地领先段 vs 已推送段"），
 * 其余分支线轮转五色色板。merge 圆继承圆心处槽位色（即第一父方向）。
 *
 * 模块无 DOM 依赖，window 只作挂载点（测试沙箱可直接提取纯函数）。
 */
(function () {
  'use strict';

  const ROW_H = 26;      // 每行高度（与 CSS .git-history-row 严格对齐）
  const LANE_W = 12;     // 泳道列宽
  const PAD_X = 8;       // 左右内边距
  const PAD_TOP = 13;    // 缺省首行圆心 y = ROW_H / 2
  const CURVE_R = 5;     // 变位折线的圆弧半径
  const ARC_R = LANE_W;  // 合并/分叉弧半径（VS Code 用整条泳道宽）
  const EDGE_W = 1;      // 连线线宽
  const NODE_R = 5;      // 普通节点半径
  const MERGE_R = 6;     // merge 节点外环半径
  const MERGE_INNER_R = 3; // merge 节点内环半径
  const HEAD_R = 7;      // HEAD 外环半径
  const HEAD_CORE_R = 4; // HEAD 中心孔半径
  const STROKE_W = 2;    // 节点底色描边宽

  const CURRENT_COLOR = '#4DA3F5';  // 当前分支主色（VS Code historyItemRefColor 位）
  const REMOTE_COLOR = '#B66DFF';   // 上游跟踪分支副色（VS Code chartsPurple）

  /** 分支线轮转色板（VS Code scmGraph.foreground1-5） */
  const PALETTE = ['#FFB000', '#DC267F', '#994F00', '#40B0A6', '#B66DFF'];

  /**
   * 计算泳道槽位（VS Code toISCMHistoryItemViewModelArray 的等价实现）。
   * @param {Array<{hash:string, parents:string[], refs?:Array<{type:string,name:string}>}>} commits 新→旧
   * @param {{currentBranch?:string, trackingBranch?:string}} [options]
   *   refs 配色表：命中 currentBranch → 主色，trackingBranch → 副色
   * @returns {{ rows: Array<{hash:string, parents:string[], kind:string,
   *            inputSwimlanes:Array<{id:string,color:string}>,
   *            outputSwimlanes:Array<{id:string,color:string}>,
   *            circleIndex:number, circleColor:string, isMerge:boolean}>,
   *            laneCount:number }}
   */
  function computeLanes(commits, options) {
    const colorMap = {};
    if (options && options.currentBranch) colorMap[options.currentBranch] = CURRENT_COLOR;
    if (options && options.trackingBranch) colorMap[options.trackingBranch] = REMOTE_COLOR;

    const byId = new Map();
    commits.forEach(function (c) { byId.set(c.hash, c); });
    // 提交的 refs 命中配色表则用该色（VS Code getLabelColorIdentifier）
    function labelColor(item) {
      const refs = (item && Array.isArray(item.refs)) ? item.refs : [];
      for (let i = 0; i < refs.length; i++) {
        const color = colorMap[refs[i].name];
        if (color) return color;
      }
      return undefined;
    }

    let colorIndex = -1;
    function nextColor() {
      colorIndex = (colorIndex + 1) % PALETTE.length;
      return PALETTE[colorIndex];
    }

    const rows = [];
    commits.forEach(function (item, row) {
      const inputSwimlanes = (rows.length > 0 ? rows[rows.length - 1].outputSwimlanes : [])
        .map(function (n) { return { id: n.id, color: n.color }; });
      const outputSwimlanes = [];
      const parents = Array.isArray(item.parents) ? item.parents : [];
      let firstParentAdded = false;

      // 第一父：继承当前提交槽位的位置与颜色（label 色优先）
      if (parents.length > 0) {
        inputSwimlanes.forEach(function (node) {
          if (node.id === item.hash) {
            if (!firstParentAdded) {
              outputSwimlanes.push({ id: parents[0], color: labelColor(item) || node.color });
              firstParentAdded = true;
            }
            return; // 其余同 id 槽位（重复追踪）被消费、不再保留
          }
          outputSwimlanes.push({ id: node.id, color: node.color });
        });
      }

      // 其余父：无条件追加到末尾，色取父提交 refs 色，否则轮转
      for (let i = firstParentAdded ? 1 : 0; i < parents.length; i++) {
        let color;
        if (i === 0) {
          color = labelColor(item);
        } else {
          color = labelColor(byId.get(parents[i]));
        }
        if (!color) color = nextColor();
        outputSwimlanes.push({ id: parents[i], color: color });
      }

      const inputIndex = inputSwimlanes.findIndex(function (n) { return n.id === item.hash; });
      const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
      const circleColor = circleIndex < outputSwimlanes.length ? outputSwimlanes[circleIndex].color
        : circleIndex < inputSwimlanes.length ? inputSwimlanes[circleIndex].color
        : CURRENT_COLOR;

      const isHead = (Array.isArray(item.refs) ? item.refs : [])
        .some(function (r) { return r && r.type === 'head'; });

      rows.push({
        hash: item.hash,
        parents: parents,
        kind: isHead ? 'HEAD' : 'node',
        inputSwimlanes: inputSwimlanes,
        outputSwimlanes: outputSwimlanes,
        circleIndex: circleIndex,
        circleColor: circleColor,
        isMerge: parents.length > 1,
      });
    });

    let laneCount = 0;
    rows.forEach(function (r) {
      laneCount = Math.max(laneCount, r.inputSwimlanes.length, r.outputSwimlanes.length);
    });

    return { rows: rows, laneCount: laneCount };
  }

  function xOf(lane) { return PAD_X + LANE_W * (lane + 1); }

  /** 从数组尾部向前找 id 匹配的槽位下标（VS Code findLastIdx） */
  function findLastIndex(swimlanes, id) {
    for (let i = swimlanes.length - 1; i >= 0; i--) {
      if (swimlanes[i].id === id) return i;
    }
    return -1;
  }

  /**
   * 构建 SVG 字符串：逐行绘制（VS Code renderSCMHistoryItemGraph 的等价
   * 实现，行间以 translate 衔接），节点圆与文本列分离的结构保持不变。
   * @param {{rows:Array, laneCount:number}} lanes computeLanes 结果
   * @param {Array<number>} [rowTops] 每行行顶的纵向绝对 y（面板实测 DOM，
   *   已累加分隔行 / 展开详情等流式内容高度）。缺省退化为等距行。行 i 的
   *   下缘 = 行 i+1 的行顶，展开行的竖线自动贯通详情区。
   * @param {{outgoing?:boolean}} [marks] 顶部「传出的更改」节点：在首行
   *   上方的分隔行带内画虚线环（主线泳道上），主线自节点下行衔接首行圆。
   */
  function buildGraphSvg(lanes, rowTops, marks) {
    const rows = lanes.rows;
    if (!rows.length) return { width: 0, height: 0, svg: '' };

    const laneCount = Math.max(1, lanes.laneCount);
    const width = PAD_X * 2 + (laneCount + 1) * LANE_W;
    const HALF = ROW_H / 2;
    const topOf = function (row) {
      return (Array.isArray(rowTops) && rowTops[row] != null) ? rowTops[row] : PAD_TOP + row * ROW_H;
    };
    // 行的下缘 = 下一行的行顶（异常数据退化为一个行高），末行延伸一个行高
    const spanOf = function (row) {
      const top = topOf(row);
      const next = (row + 1 < rows.length) ? topOf(row + 1) : top + ROW_H;
      return next > top ? next - top : ROW_H;
    };
    const height = topOf(rows.length - 1) + ROW_H;

    const nodeBg = 'var(--git-node-bg, #1E1E1E)';
    const parts = [];

    rows.forEach(function (r, row) {
      const y0 = topOf(row);
      const H = spanOf(row);
      const input = r.inputSwimlanes;
      const output = r.outputSwimlanes;
      const ci = r.circleIndex;

      const path = function (d, color) {
        parts.push('<path class="git-edge" d="' + d + '" fill="none" stroke="' + color
          + '" stroke-width="' + EDGE_W + '" stroke-linecap="round"/>');
      };
      const vline = function (lane, ya, yb, color) {
        path('M ' + xOf(lane) + ' ' + (y0 + ya) + ' V ' + (y0 + yb), color);
      };

      // ── 入列槽位：竖线 / 变位折线 / 合并弧 ──
      let outIdx = 0;
      input.forEach(function (node, i) {
        if (node.id === r.hash) {
          if (i !== ci) {
            // 重复槽位 = 合并：行顶圆弧横移 + 横线汇入圆
            path('M ' + xOf(i) + ' ' + y0
              + ' A ' + ARC_R + ' ' + ARC_R + ' 0 0 1 ' + (xOf(i) - LANE_W) + ' ' + (y0 + HALF)
              + ' H ' + xOf(ci), node.color);
          }
          if (i === ci) outIdx++;
          return;
        }
        if (outIdx < output.length && node.id === output[outIdx].id) {
          if (i === outIdx) {
            vline(i, 0, H, node.color);
          } else {
            // 槽位左移：竖直 → r5 弧 → 横线 → r5 弧 → 竖直
            path('M ' + xOf(i) + ' ' + y0
              + ' V ' + (y0 + HALF - CURVE_R)
              + ' A ' + CURVE_R + ' ' + CURVE_R + ' 0 0 1 ' + (xOf(i) - CURVE_R) + ' ' + (y0 + HALF)
              + ' H ' + (xOf(outIdx) + CURVE_R)
              + ' A ' + CURVE_R + ' ' + CURVE_R + ' 0 0 0 ' + xOf(outIdx) + ' ' + (y0 + HALF + CURVE_R)
              + ' V ' + (y0 + H), node.color);
          }
          outIdx++;
        }
      });

      // ── 剩余父（本行新追加的槽位）：圆水平引出 + 行末圆弧下行 ──
      // 弧始终在标准行距内落地（半径恒定不随行距拉伸）；行距被展开详情
      // 撑大时，落地之后以竖线贯通到下一行行顶。
      for (let pi = 1; pi < r.parents.length; pi++) {
        const p = findLastIndex(output, r.parents[pi]);
        if (p === -1) continue;
        const px = PAD_X + LANE_W * p;
        const landY = y0 + Math.min(H, ROW_H);
        path('M ' + px + ' ' + (y0 + HALF)
          + ' A ' + ARC_R + ' ' + ARC_R + ' 0 0 1 ' + (PAD_X + LANE_W * (p + 1)) + ' ' + landY
          + ' M ' + px + ' ' + (y0 + HALF)
          + ' H ' + xOf(ci), output[p].color);
        if (H > ROW_H) vline(p, ROW_H, H, output[p].color);
      }

      // ── 圆的上/下竖线 ──
      if (ci < input.length) vline(ci, 0, HALF, input[ci].color);
      if (r.parents.length > 0) vline(ci, HALF, H, r.circleColor);

      // ── 节点：HEAD 空心环 / merge 双环 / 普通实心（底色描边遮断穿线）──
      const cx = xOf(ci);
      const cy = y0 + HALF;
      const circle = function (rad, fill, stroke, strokeW) {
        parts.push('<circle class="git-dot' + (r.kind === 'HEAD' ? ' git-dot-head' : '')
          + (r.isMerge ? ' git-dot-merge' : '') + '" cx="' + cx + '" cy="' + cy
          + '" r="' + rad + '" fill="' + fill + '"'
          + (stroke ? ' style="stroke:' + stroke + ';stroke-width:' + strokeW + '"' : '')
          + '/>');
      };
      if (r.kind === 'HEAD') {
        circle(HEAD_R, r.circleColor, nodeBg, STROKE_W);
        circle(HEAD_CORE_R, nodeBg, null, 0);
      } else if (r.isMerge) {
        circle(MERGE_R, r.circleColor, nodeBg, STROKE_W);
        circle(MERGE_INNER_R, r.circleColor, nodeBg, STROKE_W);
      } else {
        circle(NODE_R, r.circleColor, nodeBg, STROKE_W);
      }
    });

    // ── 「传出的更改」节点（VS Code outgoing-changes 行）──
    // 分隔行带 [0, 首行行顶] 内：虚线环画在主线泳道上，主线自节点下行，
    // 与首行的上竖线在首行行顶处无缝衔接。
    if (marks && marks.outgoing) {
      const bandBottom = topOf(0);
      if (bandBottom >= 2) {
        const cy = bandBottom / 2;
        const cx = xOf(0);
        parts.push('<path class="git-edge" d="M ' + cx + ' ' + cy + ' V ' + bandBottom
          + '" fill="none" stroke="' + CURRENT_COLOR + '" stroke-width="' + EDGE_W + '" stroke-linecap="round"/>');
        parts.push('<circle class="git-dot" cx="' + cx + '" cy="' + cy + '" r="' + HEAD_R
          + '" fill="' + CURRENT_COLOR + '" style="stroke:' + nodeBg + ';stroke-width:' + STROKE_W + '"/>');
        parts.push('<circle class="git-dot-outgoing" cx="' + cx + '" cy="' + cy + '" r="5" fill="none" style="stroke:'
          + CURRENT_COLOR + ';stroke-width:1;stroke-dasharray:4,2"/>');
      }
    }

    return {
      width: width,
      height: height,
      svg: '<svg class="git-graph-svg" width="' + width + '" height="' + height
        + '" viewBox="0 0 ' + width + ' ' + height + '">' + parts.join('') + '</svg>',
    };
  }

  /**
   * 每行图形列宽（VS Code：SVG 宽度按该行自身泳道数计算，文本紧随其后）。
   * 面板将其作为该行文本列的 padding-left：浅行文本靠左，深行随泳道右移。
   */
  function rowWidth(lanes, row) {
    const r = lanes.rows[row];
    if (!r) return PAD_X * 2 + LANE_W;
    const n = Math.max(r.inputSwimlanes.length, r.outputSwimlanes.length, 1);
    return PAD_X * 2 + (n + 1) * LANE_W;
  }

  window.GitGraph = {
    computeLanes: computeLanes,
    buildGraphSvg: buildGraphSvg,
    rowWidth: rowWidth,
    constants: {
      ROW_H: ROW_H,
      LANE_W: LANE_W,
      PALETTE: PALETTE,
      CURRENT_COLOR: CURRENT_COLOR,
      REMOTE_COLOR: REMOTE_COLOR,
    },
  };
})();
