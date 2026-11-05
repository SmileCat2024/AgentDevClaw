/**
 * IM 前端新形状（ADR-0042 里程碑 2）的契约测试。
 *
 * 里程碑 1 把服务端数据面换成了「线路绑定线程 + 门户渠道 = 接线员线路的
 * carrier」，但前端仍是旧会话模型。那套错配造成的具体故障（实测确认）：
 *   1. 保存配置会清空 operatorThreadId 与所有线路 boundTarget —— 前端 draft
 *      根本没有这两个字段，PUT 上去后服务端归一化按缺失处理；
 *   2. 线路目标下拉选不了任何对话 —— 前端读已不再返回的 connectableSessions；
 *   3. 绑定线路必然 400 —— 前端传 sessionId，服务端要求 agentId + threadId。
 *
 * 本文件锁定新形状的三条承诺：
 *   - bundle 归一必须原样保住 operatorThreadId 与 boundTarget（保真）；
 *   - 门户渠道只能从接线员线路推导（不再有 selectedChannel）；
 *   - 线路目标值是 (agentId, threadId) 的可逆编码。
 *
 * 用真实源码在 vm 沙箱里执行（classic script 形态），依赖面用最小 stub 提供。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * 加载 im-ui.js。它是 classic script，顶层函数互相引用（imPortalCarrierOf →
 * isOperatorLine → imOperatorThreadIdOf），整文件加载比抽片段更接近生产。
 */
function loadIMUI() {
  // imWorkspaceState / imWorkspaceRequest 在 app-core.js 里以顶层 let 声明，
  // 不会自动成为 vm context 属性，这里显式提供同形对象。
  const imWorkspaceState = {
    data: null, draft: null, loading: false, saving: false,
    error: '', routableTargets: null, routableTargetsRequest: null,
  };
  const ctx = createFrontendSandbox({
    imWorkspaceState,
    imWorkspaceRequest: null,
    qqbotConfigState: { data: null, draft: null, loading: false, error: '', sourcePath: '', savedAt: null },
    qqbotConfigRequest: null,
    // im-ui 在模块体里不主动发请求，但若干函数引用这些宿主能力
    renderCurrentMainView() {},
    getCurrentAgentRecord() { return null; },
    localizeWorkspaceValue(v, fallback) { return typeof v === 'string' ? v : (fallback || ''); },
    t(key) { return key; },
    formatWorkspaceDate(v) { return String(v || ''); },
    markActionLoading() {},
    updateQueueIndicator() {},
  });
  ctx.loadSource('public/src/modules/im-ui.js');
  return ctx;
}

/** 一个形状接近真实 /protoclaw/im_workspace_bundle 的载荷。 */
function makeBundle() {
  return {
    workspaceConfig: {
      operatorThreadId: 'wt-operator-1',
      receptionistSessionId: 'session-legacy-1',
      channels: {
        qq: { label: 'QQ 主号', role: '', note: '' },
        weixin: { label: '微信', role: '', note: '' },
        feishu: { label: '飞书', role: '', note: '' },
        wecom: { label: '企业微信', role: '', note: '' },
        rokid: { label: 'Rokid 眼镜', role: '', note: '' },
      },
      lines: [
        {
          id: 'line1',
          label: '通道 1',
          carrier: 'qq',
          // 接线员线路：门户渠道就是这条的 carrier
          boundTarget: { agentId: 'qqbot', threadId: 'wt-operator-1' },
        },
        {
          id: 'line2',
          label: '通道 2',
          carrier: 'feishu',
          boundTarget: { agentId: 'programming-helper', threadId: 'wt-ph-1' },
        },
      ],
    },
    operatorThread: {
      threadId: 'wt-operator-1',
      headSessionId: 'session-head-1',
      title: 'IM 接线员',
      status: 'open',
    },
    sessions: [{ id: 'session-a', title: 'A', updatedAt: null }],
    qqConfig: { appId: 'app', clientSecret: 'secret' },
  };
}

test('bundle 归一保真：operatorThreadId 与 boundTarget 一字节不丢', () => {
  const ctx = loadIMUI();
  const bundle = ctx.run(`normalizeIMWorkspaceBundleData(${JSON.stringify(makeBundle())})`);

  // 保存行为的前提：这两项必须在 draft 里存在且与源一致
  assert.equal(bundle.workspaceConfig.operatorThreadId, 'wt-operator-1');
  assert.equal(bundle.workspaceConfig.receptionistSessionId, 'session-legacy-1',
    '升级迁移需要原样透传旧会话引用');

  // vm 沙箱里创建的对象原型来自沙箱 realm，deepEqual 前先落到本 realm
  assert.deepEqual({ ...bundle.workspaceConfig.lines[0].boundTarget },
    { agentId: 'qqbot', threadId: 'wt-operator-1' });
  assert.deepEqual({ ...bundle.workspaceConfig.lines[1].boundTarget },
    { agentId: 'programming-helper', threadId: 'wt-ph-1' });
});

test('bundle 归一：已退役字段不再出现在新形状里', () => {
  const ctx = loadIMUI();
  const raw = makeBundle();
  // 旧服务端 / 旧缓存可能仍带这些字段，归一必须丢弃而不是透传
  raw.workspaceConfig.selectedChannel = 'qq';
  raw.workspaceConfig.lines[0].boundSession = { agentId: 'programming-helper', sessionId: 'session-a' };
  raw.connectableSessions = [{ id: 'session-a', title: 'A' }];
  raw.receptionistSession = { id: 'session-a', title: 'A' };

  const bundle = ctx.run(`normalizeIMWorkspaceBundleData(${JSON.stringify(raw)})`);
  assert.equal('selectedChannel' in bundle.workspaceConfig, false);
  assert.equal('boundSession' in bundle.workspaceConfig.lines[0], false);
  assert.equal('connectableSessions' in bundle, false);
  assert.equal('receptionistSession' in bundle, false);
  // 旧 boundSession 存在时绑定仍是 boundTarget，不会被旧字段顶替
  assert.deepEqual({ ...bundle.workspaceConfig.lines[0].boundTarget },
    { agentId: 'qqbot', threadId: 'wt-operator-1' });
});

test('boundTarget 不完整（只有一半）视为未绑定', () => {
  const ctx = loadIMUI();
  const raw = makeBundle();
  raw.workspaceConfig.lines[1].boundTarget = { agentId: 'programming-helper', threadId: '' };
  const bundle = ctx.run(`normalizeIMWorkspaceBundleData(${JSON.stringify(raw)})`);
  assert.equal(bundle.workspaceConfig.lines[1].boundTarget, null,
    '服务端要求 agentId + threadId 成对，前端不得把半截寻址当作已绑定');
});

test('门户渠道只从接线员线路的 carrier 推导', () => {
  const ctx = loadIMUI();
  const bundle = ctx.run(`normalizeIMWorkspaceBundleData(${JSON.stringify(makeBundle())})`);
  ctx.imWorkspaceState.data = bundle;

  assert.equal(ctx.run('imPortalCarrierOf(imWorkspaceState.data)'), 'qq',
    'line1 绑定接线员线程且 carrier=qq，门户渠道应为 qq');
});

test('门户渠道：接线员线路未选渠道时为空（不是回退默认 qq）', () => {
  const ctx = loadIMUI();
  const raw = makeBundle();
  raw.workspaceConfig.lines[0].carrier = '';
  // line2 有 carrier，但它绑的不是接线员线程，不能冒充门户渠道
  const bundle = ctx.run(`normalizeIMWorkspaceBundleData(${JSON.stringify(raw)})`);
  ctx.imWorkspaceState.data = bundle;

  assert.equal(ctx.run('imPortalCarrierOf(imWorkspaceState.data)'), '',
    '门户未接线必须显示为空，旧实现会回退成 qq 造成假在线');
});

test('门户渠道：没有 operatorThreadId 时一律为空', () => {
  const ctx = loadIMUI();
  const raw = makeBundle();
  raw.workspaceConfig.operatorThreadId = '';
  const bundle = ctx.run(`normalizeIMWorkspaceBundleData(${JSON.stringify(raw)})`);
  ctx.imWorkspaceState.data = bundle;

  assert.equal(ctx.run('imPortalCarrierOf(imWorkspaceState.data)'), '',
    '没有接线员线程引用就不存在「接线员线路」，任何 carrier 都不算门户渠道');
});

test('isOperatorLine 按 operatorThreadId 判定，而非按 agentId', () => {
  const ctx = loadIMUI();
  const bundle = ctx.run(`normalizeIMWorkspaceBundleData(${JSON.stringify(makeBundle())})`);
  ctx.imWorkspaceState.data = bundle;

  assert.equal(ctx.run('isOperatorLine(imWorkspaceState.data, imWorkspaceState.data.workspaceConfig.lines[0])'), true);
  assert.equal(ctx.run('isOperatorLine(imWorkspaceState.data, imWorkspaceState.data.workspaceConfig.lines[1])'), false);
});

test('线路目标值编码可逆（agentId::threadId）', () => {
  const ctx = loadIMUI();
  const encoded = ctx.run(`imLineTargetValue({ agentId: 'programming-helper', threadId: 'wt-ab12' })`);
  assert.equal(encoded, 'programming-helper::wt-ab12');

  const decoded = ctx.run(`imParseLineTargetValue(${JSON.stringify(encoded)})`);
  assert.deepEqual({ ...decoded }, { agentId: 'programming-helper', threadId: 'wt-ab12' });

  // 空值 = 未连接
  assert.equal(ctx.run(`imLineTargetValue(null)`), '');
  assert.deepEqual({ ...ctx.run(`imParseLineTargetValue('')`) }, { agentId: '', threadId: '' });
  // 形状不对的值不得被当成合法目标（避免把垃圾串发给服务端）
  assert.deepEqual({ ...ctx.run(`imParseLineTargetValue('not-a-target')`) }, { agentId: '', threadId: '' });
});

test('operatorThread 投影：悬空引用（服务端返回 null）保持 null', () => {
  const ctx = loadIMUI();
  const raw = makeBundle();
  raw.operatorThread = null;
  const bundle = ctx.run(`normalizeIMWorkspaceBundleData(${JSON.stringify(raw)})`);
  assert.equal(bundle.operatorThread, null,
    '尚未建立接线员线程是正常状态，不能被伪造成一个空线程对象');
  // 但引用本身仍在（服务端解析悬空 ≠ 引用丢失），保存不得清掉它
  assert.equal(bundle.workspaceConfig.operatorThreadId, 'wt-operator-1');
});

test('可绑定目标清单：按工作空间分组，过滤空线程', () => {
  const ctx = loadIMUI();
  const payload = {
    workspaces: [
      {
        agentId: 'coder',
        agentName: 'Coder',
        threads: [
          { threadId: 'wt-c1', agentId: 'coder', title: '线程一', status: 'open', execStatus: 'running', updatedAt: 100 },
          { threadId: '', title: '坏数据' },
        ],
      },
      { agentId: 'empty', agentName: 'Empty', threads: [] },
    ],
    lines: [],
  };
  const targets = ctx.run(`normalizeIMRoutableTargets(${JSON.stringify(payload)})`);
  assert.equal(targets.length, 1, '没有线程的工作空间不占条目');
  assert.equal(targets[0].agentId, 'coder');
  assert.equal(targets[0].threads.length, 1);
  assert.equal(targets[0].threads[0].threadId, 'wt-c1');
  assert.equal(targets[0].threads[0].execStatus, 'running');
});
