/**
 * IM 工具渲染模板的字段契约测试（ADR-0042 里程碑 2 收尾）。
 *
 * 背景：里程碑 1 把 IM 线路绑定从「会话」换成「线程」，服务端与工具返回值
 * 都改了字段，但三个聊天渲染模板（templates/*.render.ts，走 ViewerWorker
 * 模板管线，不属 public/）仍读旧字段。后果是图文不一致：
 *
 *   - im-overview 读 line.boundSession（实为 boundThread）→ 已连接的线路
 *     恒定显示「空闲」，且看不到绑到哪条线程；
 *   - im-browse 读 sessionId / sessionTitle / savedAt（实为 threadId /
 *     title / updatedAt）→ 标题恒为「(无标题会话)」、threadId 整行消失、
 *     最后活动显示「?」，底部提示还教用户传已不存在的 sessionId；
 *   - im-line 的 call 卡判 args.sessionId（实为 threadId）→ 调用卡只剩
 *     lineId，看不出要绑到哪条线程。
 *
 * 这类脱节不会被任何功能测试发现（工具本身用的是正确字段），只在用户看到
 * 的卡片上出错。本文件用「真实服务端返回形状」驱动真实模板产物，锁定三件事：
 * 绑定事实正确显示、目标线程可辨认、不再出现旧字段缺失的兜底文案。
 *
 * 测试对象是构建产物 dist/templates/*.render.js（构建后即为运行时加载的
 * 模块），因此断言的是真实会被执行的那份代码。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import imOverview from '../local-features/dist/templates/im-overview.render.js';
import imBrowse from '../local-features/dist/templates/im-browse.render.js';
import imLine from '../local-features/dist/templates/im-line.render.js';

/** /protoclaw/im_routable_targets 的线路投影（server/routes/im.js 实际返回形状）。 */
function makeLine({ id = 'line1', name = '通道 1', carrier = 'qq', boundThread = null } = {}) {
  return { id, name, carrier, boundThread };
}

function makeBoundThread({ agentId = 'coder', threadId = 'wt-abcd', title = '重构鉴权' } = {}) {
  return { agentId, threadId, threadTitle: title, status: 'open', updatedAt: Date.now() - 120_000 };
}

// ── im_overview ─────────────────────────────────────────────────────

test('im_overview：绑定线程的线路显示「已连接」，并给出线程标题与 threadId', () => {
  const html = imOverview.result({
    text: '',
    lines: [makeLine({ boundThread: makeBoundThread() })],
  }, true);

  assert.match(html, /已连接/, '绑定事实必须显示为已连接（旧模板恒显示空闲）');
  assert.match(html, /重构鉴权/, '应显示线程标题');
  assert.match(html, /wt-abcd/, 'threadId 应可辨认，便于随后复用');
  assert.doesNotMatch(html, />空闲</, '已连接的线路不得显示空闲');
});

test('im_overview：未绑定的线路显示「空闲」，不渲染线程信息', () => {
  const html = imOverview.result({ text: '', lines: [makeLine()] }, true);

  assert.match(html, />空闲</);
  assert.doesNotMatch(html, /已连接/);
});

test('im_overview：boundThread 缺 threadId 视为未绑定（半截数据不冒充已连接）', () => {
  // 服务端只在 bound.threadId 存在时才产出 boundThread；这里防的是归一化
  // 或投影变更后漏掉 threadId 的情况——不能因为对象存在就报「已连接」。
  const html = imOverview.result({
    text: '',
    lines: [makeLine({ boundThread: { agentId: 'coder' } })],
  }, true);

  assert.match(html, />空闲</);
  assert.doesNotMatch(html, /已连接/);
});

test('im_overview：空线路列表给出明确提示，不输出空容器', () => {
  const html = imOverview.result({ text: '', lines: [] }, true);
  assert.match(html, /当前没有配置任何 IM 线路/);
});

// ── im_browse ───────────────────────────────────────────────────────

/** im_browse 的 sessions[] 元素（工具返回的线程投影，agent.js flatSessions）。 */
function makeBrowseThread(overrides = {}) {
  return {
    agentId: 'coder',
    agentName: 'Coder',
    threadId: 'wt-xyz',
    title: '给登录加限流',
    headSessionId: 'session-123-abc',
    status: 'open',
    modelName: 'GLM-5.3',
    execStatus: 'idle',
    updatedAt: Date.now() - 300_000,
    ...overrides,
  };
}

test('im_browse：线程标题与 threadId 都出现在卡片里', () => {
  const html = imBrowse.result({ text: '', sessions: [makeBrowseThread()] }, true);

  assert.match(html, /给登录加限流/, '应显示线程标题');
  assert.match(html, /wt-xyz/, 'threadId 应单独一行便于复制');
  assert.doesNotMatch(html, /\(无标题会话\)/, '不得再出现旧字段缺失的兜底文案');
  assert.doesNotMatch(html, /最后活动 \?/, 'updatedAt 必须被读取');
});

test('im_browse：接线提示教用户传 threadId，不是已退役的 sessionId', () => {
  const html = imBrowse.result({ text: '', sessions: [makeBrowseThread()] }, true);

  // 提示文案会直接指导后续调用，说错就等于让模型发出必然 400 的参数
  assert.match(html, /threadId/);
  assert.doesNotMatch(html, /agentId \+ sessionId/);
});

test('im_browse：空线程列表提示可连接目标为空', () => {
  const html = imBrowse.result({ text: '', sessions: [] }, true);
  assert.match(html, /当前没有可连接的线程/);
});

test('im_browse：按工作空间分组，同一 agentId 的线程落在同一组', () => {
  const html = imBrowse.result({
    text: '',
    sessions: [
      makeBrowseThread({ threadId: 'wt-1', title: '线程一' }),
      makeBrowseThread({ threadId: 'wt-2', title: '线程二' }),
      makeBrowseThread({ threadId: 'wt-3', title: '别的空间', agentId: 'programming-helper', agentName: '编程小助手' }),
    ],
  }, true);

  const groupCount = (html.match(/tool-search-path/g) || []).length;
  assert.equal(groupCount, 2, '两个工作空间应分为两组');
});

// ── im_line ─────────────────────────────────────────────────────────

test('im_line：call 卡显示 lineId 与目标 agentId / threadId', () => {
  const html = imLine.call({ lineId: 'line1', agentId: 'coder', threadId: 'wt-abc' });

  assert.match(html, /line1/);
  assert.match(html, /coder/, '调用卡应显示目标工作空间');
  assert.match(html, /wt-abc/, '调用卡应显示目标线程（旧模板只显示 lineId）');
});

test('im_line：只给 lineId（disconnect）时卡片不虚构目标', () => {
  const html = imLine.call({ lineId: 'line2' });

  assert.match(html, /line2/);
  assert.doesNotMatch(html, /→/);
});

test('im_line：连接回执显示已连接 chip 与正文', () => {
  const html = imLine.result({
    text: ' 线路「通道 1」已连接到线程 wt-abc（coder）。\n（操作时间: 2026-11-05 22:00:00）',
    success: true,
  }, true);

  assert.match(html, /已连接/);
  assert.match(html, /wt-abc/);
  assert.doesNotMatch(html, /操作时间/, '时间戳行是冗余，聊天卡不重复');
});
