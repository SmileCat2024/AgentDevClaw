import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'path';
import { Agent, Context, Decision } from '@agentdevjs/core';
import { StylizedOutput } from '../dist/index.js';

const SIGNATURE = '我确认本回复已逐句遵循测试风格的全部要求。';

// 长签名（对齐内置「清晰表达」的真实形态）：预算 = max(2, floor(长度 × 5%)) = 5。
// 笔误侧变体距离 1–2（远低于预算）；拒绝侧变体距离 ≥ 11（远超预算），
// 两侧在长度 ±3 的误差下判定不变，用例不依赖精确长度。
const LONG_SIGNATURE = '我确认本回复已按<清晰表达>复核：回答对准读者当前的问题与所需认识；背景足够，名称和指代清楚；内容的性质、来源与确定程度没有混淆，关键关系与意义已讲明；结论直接，依据、限制及场景所需信息完整，详略合宜；变化已交代，读者无需自行拼接理解。';
const LONG_TYPO_SYNONYM = LONG_SIGNATURE.replace('关键关系与意义已讲明', '关键关系和意义已讲明'); // 与→和，距离 1
const LONG_TYPO_WORD = LONG_SIGNATURE.replace('已讲明', '已说明'); // 两字词替换，距离 2
const LONG_TYPO_PUNCT = LONG_SIGNATURE.replace('：', ':').replace('；', ';'); // 全半角标点 ×2，距离 2
const LONG_MISSING_CLAUSE = LONG_SIGNATURE.replace('结论直接，依据、限制及场景所需信息完整，详略合宜；', ''); // 漏分句，距离 25
const LONG_PARAPHRASE = '我确认这次回答已经按照清晰表达风格的各项要求认真复核过，读者应当可以不费力地理解全部内容。'; // 意译改写
const LONG_APPENDED = LONG_SIGNATURE + '（以上为我的确认签名）'; // 附加解释短语，距离 11

function createLongStyleFeature(options = {}) {
  const feature = new StylizedOutput({ workspaceDir, ...options });
  feature.setActiveStyle('long-style');
  return feature;
}

let workspaceDir;

function createFeature() {
  const feature = new StylizedOutput({ workspaceDir });
  feature.setActiveStyle('test-style');
  return feature;
}

/** 构造 StepFinish 门禁上下文 */
function createGateContext({ toolCallsCount = 0 } = {}) {
  const added = [];
  const ctx = {
    toolCallsCount,
    hasActiveSubAgents: false,
    hasPendingMessages: false,
    hasPendingWakeups: false,
    waitCalled: false,
    context: { add: (msg) => added.push(msg) },
  };
  return { ctx, added };
}

before(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'stylized-output-test-'));
  mkdirSync(join(workspaceDir, '.agentdev', 'output-style'), { recursive: true });
  writeFileSync(
    join(workspaceDir, '.agentdev', 'output-style', 'test-style.md'),
    [
      '---',
      'name: test-style',
      'description: 测试风格',
      `signature: ${SIGNATURE}`,
      '---',
      '',
      '正文规则。',
      '',
    ].join('\n'),
    'utf-8',
  );
  // 长签名风格（≈118 字符）：预算 = max(2, floor(长度 × 5%)) = 5，
  // 覆盖"笔误放行、漏句/改写拒绝"的真实量级（对齐内置「清晰表达」签名形态）。
  writeFileSync(
    join(workspaceDir, '.agentdev', 'output-style', 'long-style.md'),
    [
      '---',
      'name: long-style',
      'description: 长签名测试风格',
      `signature: ${LONG_SIGNATURE}`,
      '---',
      '',
      '正文规则。',
      '',
    ].join('\n'),
    'utf-8',
  );
});

after(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe('StylizedOutput 签名工具', () => {
  it('签名匹配 → 记录本轮已签名并返回 ok', async () => {
    const feature = createFeature();
    const payload = await feature.signTool.execute({ signature: SIGNATURE });

    assert.equal(payload.ok, true);
    assert.equal(payload.signed, true);
    assert.equal(payload.style, 'test-style');
    assert.equal(feature.signedForReply, true);
    assert.match(payload.note, /不必复述全文，用简短几句与用户自然交接/);
  });

  it('签名内部空白差异被规范化后匹配', async () => {
    const feature = createFeature();
    const payload = await feature.signTool.execute({ signature: `  ${SIGNATURE}  ` });

    assert.equal(payload.ok, true);
    assert.equal(feature.signedForReply, true);
  });

  it('签名不匹配 → 拒绝且不记录签名', async () => {
    const feature = createFeature();
    const payload = await feature.signTool.execute({ signature: '错误的签名' });

    assert.equal(payload.ok, false);
    assert.equal(feature.signedForReply, false);
  });

  it('signature 参数为空 → 拒绝', async () => {
    const feature = createFeature();
    const payload = await feature.signTool.execute({ signature: '   ' });

    assert.equal(payload.ok, false);
    assert.equal(feature.signedForReply, false);
  });

  it('未启用风格 → 明确拒绝，无需签名', async () => {
    const feature = new StylizedOutput({ workspaceDir });
    const payload = await feature.signTool.execute({ signature: SIGNATURE });

    assert.equal(payload.ok, false);
    assert.match(payload.error, /未启用任何输出风格/);
  });
});

describe('StylizedOutput 签名笔误宽恕', () => {
  it('近义单字替换（与→和，本次事故形态）→ 放行并记为已签名', async () => {
    const feature = createLongStyleFeature();

    const payload = await feature.signTool.execute({ signature: LONG_TYPO_SYNONYM });

    assert.equal(payload.ok, true);
    assert.equal(payload.signed, true);
    assert.equal(feature.signedForReply, true);
  });

  it('两字词替换与全半角标点差异 → 放行', async () => {
    for (const typo of [LONG_TYPO_WORD, LONG_TYPO_PUNCT]) {
      const feature = createLongStyleFeature();
      const payload = await feature.signTool.execute({ signature: typo });
      assert.equal(payload.ok, true, `应放行笔误：${typo.slice(0, 20)}…`);
      assert.equal(feature.signedForReply, true);
    }
  });

  it('宽恕通过对外静默：返回与精确通过完全一致', async () => {
    const exact = await createLongStyleFeature().signTool.execute({ signature: LONG_SIGNATURE });
    const forgiven = await createLongStyleFeature().signTool.execute({ signature: LONG_TYPO_SYNONYM });

    assert.deepEqual(forgiven, exact);
  });

  it('审计留痕分化：宽恕通过记 warn（含距离），精确通过记 info', async () => {
    const logs = [];
    const spy = {
      info: (message, data) => logs.push({ level: 'info', message, data }),
      warn: (message, data) => logs.push({ level: 'warn', message, data }),
    };
    const exactFeature = createLongStyleFeature();
    exactFeature.logger = spy;
    await exactFeature.signTool.execute({ signature: LONG_SIGNATURE });
    const forgivenFeature = createLongStyleFeature();
    forgivenFeature.logger = spy;
    await forgivenFeature.signTool.execute({ signature: LONG_TYPO_SYNONYM });

    assert.equal(logs.filter((entry) => entry.level === 'info' && /验证通过/.test(entry.message)).length, 1);
    const warns = logs.filter((entry) => entry.level === 'warn' && /笔误宽恕/.test(entry.message));
    assert.equal(warns.length, 1);
    assert.equal(warns[0].data.distance, 1);
    assert.equal(warns[0].data.style, 'long-style');
  });

  it('漏分句 / 意译改写 / 附加解释短语 → 拒绝，提示差异量级与容忍上限，且不记签名', async () => {
    for (const rewritten of [LONG_MISSING_CLAUSE, LONG_PARAPHRASE, LONG_APPENDED]) {
      const feature = createLongStyleFeature();
      const payload = await feature.signTool.execute({ signature: rewritten });
      assert.equal(payload.ok, false, `应拒绝改写：${rewritten.slice(0, 20)}…`);
      assert.equal(payload.signed, false);
      assert.match(payload.error, /超出笔误容忍上限/);
      assert.equal(feature.signedForReply, false);
    }
  });

  it('短签名按基数 2 宽恕：单字替换通过，距离 4 的改写仍拒绝', async () => {
    const singleTypo = SIGNATURE.replace('遵循', '遵照'); // 距离 1
    const multiDiff = SIGNATURE.replace('遵循', '贯彻执行'); // 距离 4 > 基数 2

    const pass = await createFeature().signTool.execute({ signature: singleTypo });
    assert.equal(pass.ok, true);

    const feature = createFeature();
    const reject = await feature.signTool.execute({ signature: multiDiff });
    assert.equal(reject.ok, false);
    assert.equal(feature.signedForReply, false);
  });

  it('signatureTolerance=0 → 严格逐字回退：笔误被拒并提示容忍已关闭，精确匹配仍通过', async () => {
    const feature = createLongStyleFeature({ signatureTolerance: 0 });
    assert.equal(feature.getStatus().signatureTolerance, 0);

    const rejected = await feature.signTool.execute({ signature: LONG_TYPO_SYNONYM });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /笔误容忍已关闭/);

    const exact = await feature.signTool.execute({ signature: LONG_SIGNATURE });
    assert.equal(exact.ok, true);
    assert.equal(feature.signedForReply, true);
  });

  it('signatureTolerance 配置贯通：options → status，capability 与 featureConfig 通道写入生效', async () => {
    const feature = createLongStyleFeature({ signatureTolerance: 3 });
    assert.equal(feature.getStatus().signatureTolerance, 3);

    feature.setSignatureTolerance(99); // 越界钳制到 10
    assert.equal(feature.getStatus().signatureTolerance, 10);

    const capability = feature.getCapabilities().find((cap) => cap.name === 'configure');
    await capability.execute({ signatureTolerance: 0 });
    assert.equal(feature.getStatus().signatureTolerance, 0);
    const rejected = await feature.signTool.execute({ signature: LONG_TYPO_SYNONYM });
    assert.equal(rejected.ok, false);

    const viaConfig = new StylizedOutput({ workspaceDir });
    await viaConfig.onInitiate({ logger: undefined, featureConfig: { signatureTolerance: 0 }, config: {} });
    assert.equal(viaConfig.getStatus().signatureTolerance, 0);
  });
});

describe('StylizedOutput 签名门禁（StepFinish guard）', () => {
  it('带工具调用的步不干预', async () => {
    const feature = createFeature();
    await feature.signTool.execute({ signature: SIGNATURE });
    const { ctx } = createGateContext({ toolCallsCount: 2 });

    const decision = await feature.decideSignatureGate(ctx);

    assert.equal(decision, Decision.Continue);
    assert.equal(feature.lastAction, 'signed');
  });

  it('已签名的自然结束步放行', async () => {
    const feature = createFeature();
    await feature.signTool.execute({ signature: SIGNATURE });
    const { ctx, added } = createGateContext({ toolCallsCount: 0 });

    const decision = await feature.decideSignatureGate(ctx);

    assert.equal(decision, Decision.Continue);
    assert.equal(added.length, 0);
  });

  it('未签名试图自然结束 → 拦截并注入补签要求', async () => {
    const feature = createFeature();
    const { ctx, added } = createGateContext({ toolCallsCount: 0 });

    const decision = await feature.decideSignatureGate(ctx);

    assert.equal(decision, Decision.Approve);
    assert.equal(feature.lastAction, 'blocked');
    assert.equal(feature.blockedCount, 1);
    assert.equal(added.length, 1);
    assert.match(added[0].content, /签名门禁/);
    assert.match(added[0].content, /当前已启用输出风格「test-style」/);
    assert.match(added[0].content, /符合则直接签名/);
    assert.match(added[0].content, /必要补充或局部重新表述，无需全文重写/);
    assert.match(added[0].content, /show_output_style（不传参数/);
    assert.doesNotMatch(added[0].content, /更正后重新输出|不会再给你补写正文的机会|自动结束/);
  });

  it('连续拦截达到上限后放行结束', async () => {
    const feature = createFeature();
    feature.setMaxSignatureBlocks(2);

    for (let i = 0; i < 2; i++) {
      const { ctx } = createGateContext({ toolCallsCount: 0 });
      const decision = await feature.decideSignatureGate(ctx);
      assert.equal(decision, Decision.Approve);
    }

    const { ctx } = createGateContext({ toolCallsCount: 0 });
    const decision = await feature.decideSignatureGate(ctx);
    assert.equal(decision, Decision.Continue);
    assert.equal(feature.lastAction, 'released');
  });

  it('CallStart 重置签名状态，上一轮签名对本轮无效', async () => {
    const feature = createFeature();
    await feature.signTool.execute({ signature: SIGNATURE });
    assert.equal(feature.signedForReply, true);

    await feature.syncStyleState({});

    assert.equal(feature.signedForReply, false);
    const { ctx } = createGateContext({ toolCallsCount: 0 });
    const decision = await feature.decideSignatureGate(ctx);
    assert.equal(decision, Decision.Approve);
  });
});

describe('StylizedOutput 补签收尾', () => {
  it('拦截后可以查阅风格，签名失败不结束，成功才正常结束', async () => {
    const feature = createFeature();
    await feature.decideSignatureGate(createGateContext().ctx);
    await feature.showTool.execute({});
    assert.equal(await feature.decideSignatureGate(createGateContext({ toolCallsCount: 1 }).ctx), Decision.Continue);

    await feature.signTool.execute({ signature: '错误签名' });
    assert.equal(await feature.decideSignatureGate(createGateContext({ toolCallsCount: 1 }).ctx), Decision.Continue);
    const payload = await feature.signTool.execute({ signature: SIGNATURE });
    assert.equal(payload.ok, true);
    assert.doesNotMatch(payload.note, /直接输出面向用户的最终回复/);
    assert.equal(await feature.decideSignatureGate(createGateContext({ toolCallsCount: 1 }).ctx), Decision.Deny);
    assert.equal(feature.blockedCount, 0);
    assert.equal(feature.lastAction, 'signed');
    assert.equal(await feature.decideSignatureGate(createGateContext({ toolCallsCount: 1 }).ctx), Decision.Continue);
  });

  for (const flag of ['hasActiveSubAgents', 'hasPendingMessages', 'waitCalled']) {
    it(`${flag} 活跃时，补签不覆盖原有控制流程`, async () => {
      const feature = createFeature();
      await feature.decideSignatureGate(createGateContext().ctx);
      await feature.signTool.execute({ signature: SIGNATURE });
      const { ctx } = createGateContext({ toolCallsCount: 1 });
      ctx[flag] = true;
      assert.equal(await feature.decideSignatureGate(ctx), Decision.Continue);
    });
  }

  it('新 CallStart、风格重选或风格清除均撤销补签自动结束条件', async () => {
    for (const reset of [feature => feature.syncStyleState({}), feature => feature.setActiveStyle('test-style'), feature => feature.setActiveStyle(null)]) {
      const feature = createFeature();
      await feature.decideSignatureGate(createGateContext().ctx);
      await reset(feature);
      await feature.signTool.execute({ signature: SIGNATURE });
      assert.equal(await feature.decideSignatureGate(createGateContext({ toolCallsCount: 1 }).ctx), Decision.Continue);
    }
  });

  it('同次 call 的新用户输入清除签名及补签条件，系统提醒不清除', async () => {
    const feature = createFeature();
    const context = new Context();
    context.addUserMessage('原任务', 1);
    await feature.ensureStyleInjection({ context });
    await feature.decideSignatureGate({ ...createGateContext().ctx, context });
    context.addSystemMessage('机器提醒', 1);
    await feature.ensureStyleInjection({ context });
    assert.equal(feature.blockedCount, 1);
    await feature.signTool.execute({ signature: SIGNATURE });

    context.addUserMessage('排队插话', 1);
    await feature.ensureStyleInjection({ context });
    assert.equal(feature.blockedCount, 0);
    assert.equal(feature.signedForReply, false);
    await feature.signTool.execute({ signature: SIGNATURE });
    assert.equal(await feature.decideSignatureGate(createGateContext({ toolCallsCount: 1 }).ctx), Decision.Continue);
  });

  it('快照恢复保留同一输入的补签条件，新输入仍使其失效', async () => {
    const original = createFeature();
    const context = new Context();
    context.addUserMessage('原任务', 1);
    await original.ensureStyleInjection({ context });
    await original.decideSignatureGate({ ...createGateContext().ctx, context });
    const snapshot = original.captureState();
    const restored = createFeature();
    restored.restoreState(snapshot);
    await restored.ensureStyleInjection({ context });
    await restored.signTool.execute({ signature: SIGNATURE });
    assert.equal(await restored.decideSignatureGate(createGateContext({ toolCallsCount: 1 }).ctx), Decision.Deny);

    restored.restoreState(snapshot);
    context.addUserMessage('新任务', 2);
    await restored.ensureStyleInjection({ context });
    assert.equal(restored.blockedCount, 0);
  });
});

describe('StylizedOutput 框架收尾集成', () => {
  function createAgent(t, responses) {
    const requests = [];
    const queuedInputs = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.match(String(url), /\/dequeue-input$/);
      return { ok: true, json: async () => ({ input: queuedInputs.shift() ?? null }) };
    });
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    const agent = new Agent({ maxTurns: 10, llm: { chat: async messages => {
      requests.push(structuredClone(messages));
      assert.ok(responses.length > 0, '不应为补签收尾额外请求模型');
      const next = responses.shift();
      return typeof next === 'function' ? next() : next;
    } } }).use(feature);
    t.after(() => agent.dispose());
    return { agent, feature, requests, queuedInputs };
  }

  const sign = (signature = SIGNATURE, content = '') => ({
    content,
    toolCalls: [{ id: 'signature', name: 'sign_output_style', arguments: { signature } }],
  });

  it('已有最终输出后补签即完成，工具结果和原文均留在上下文', async t => {
    const { agent, requests } = createAgent(t, [{ content: '完整最终回复' }, sign()]);
    await agent.onCall('任务');
    assert.equal(requests.length, 2);
    assert.equal(agent.getLastCallOutcome().status, 'completed');
    const messages = agent.getContext().getAll();
    assert.ok(messages.some(message => message.role === 'assistant' && message.content === '完整最终回复'));
    assert.equal(messages.at(-1).role, 'tool');
    const toolResult = JSON.parse(messages.at(-1).content);
    assert.equal(toolResult.success, true);
    assert.equal(JSON.parse(toolResult.result).signed, true);
  });

  it('未拦截的普通签名仍允许模型输出最终回复', async t => {
    const { agent, requests } = createAgent(t, [sign(), { content: '签名后的正常最终回复' }]);
    assert.equal(await agent.onCall('任务'), '签名后的正常最终回复');
    assert.equal(requests.length, 2);
  });

  it('允许先重读风格、失败重试和局部改述，成功补签后不再请求模型', async t => {
    const { agent, requests } = createAgent(t, [
      { content: '已有回复' },
      { content: '', toolCalls: [{ id: 'read-style', name: 'show_output_style', arguments: {} }] },
      sign('错误签名'),
      sign(SIGNATURE, '局部更正说明'),
    ]);
    assert.equal(await agent.onCall('任务'), '局部更正说明');
    assert.equal(requests.length, 4);
    assert.equal(agent.getLastCallOutcome().status, 'completed');
  });

  it('补签收尾时排队的新用户输入仍被处理，旧补签条件不会截断新回复', async t => {
    const responses = [{ content: '旧任务回复' }];
    const { agent, requests, queuedInputs } = createAgent(t, responses);
    responses.push(() => {
      queuedInputs.push({ text: '新任务', sourceRef: 'queued-user' });
      return sign();
    }, sign(), { content: '新任务回复' });
    assert.equal(await agent.onCall('原任务'), '新任务回复');
    assert.equal(requests.length, 4);
    assert.ok(requests[2].some(message => message.role === 'user' && message.content === '新任务'));
    assert.deepEqual(agent.getLastCallOutcome().consumedSourceRefs, ['queued-user']);
  });

  it('成功补签后仍保留后台 pending work 并由框架判定 suspended', async t => {
    const { agent, requests } = createAgent(t, [{ content: '任务已交给后台' }, sign()]);
    agent.registerPendingWorkProvider('test-background', () => [{ source: 'test-background', id: 'job-1' }]);
    await agent.onCall('任务');
    assert.equal(requests.length, 2);
    assert.equal(agent.getLastCallOutcome().reason, 'suspended');
    assert.equal(agent.collectPendingWakeups().length, 1);
  });

  it('同批混用签名与其他工具时不会误判成功补签或执行其他工具', async t => {
    let executions = 0;
    const mixed = sign();
    mixed.toolCalls.push({ id: 'other', name: 'other', arguments: {} });
    const { agent, requests } = createAgent(t, [{ content: '最终回复' }, mixed, sign()]);
    agent.tools.register({ name: 'other', description: 'test', parameters: {}, execute: async () => { executions++; } });
    await agent.onCall('任务');
    assert.equal(requests.length, 3);
    assert.equal(executions, 0);
    assert.equal(agent.getLastCallOutcome().status, 'completed');
  });
});

describe('StylizedOutput 内置风格与默认回填', () => {
  it('内嵌风格与工作区风格合并发现', async () => {
    const feature = new StylizedOutput({ workspaceDir });
    await feature.syncStyleState({});
    const names = feature.getStyles().map((style) => style.name);

    assert.ok(names.includes('test-style'), '工作区风格应被发现');
    assert.ok(names.includes('清晰表达'), 'feature 内嵌风格应被发现');
  });

  it('工作区与内嵌风格重名时工作区版本优先', async () => {
    const styleDir = join(workspaceDir, '.agentdev', 'output-style');
    writeFileSync(
      join(styleDir, 'override.md'),
      [
        '---',
        'name: 清晰表达',
        'description: 工作区覆盖版',
        'signature: 工作区覆盖版签名',
        '---',
        '',
      ].join('\n'),
      'utf-8',
    );
    try {
      const feature = new StylizedOutput({ workspaceDir, defaultStyle: '清晰表达' });
      await feature.syncStyleState({});

      assert.equal(feature.getActiveStyle().signature, '工作区覆盖版签名');
    } finally {
      rmSync(join(styleDir, 'override.md'), { force: true });
    }
  });

  it('defaultStyle：未选择时扫描后自动回填', async () => {
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    assert.equal(feature.getStatus().activeStyle, null);

    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, 'test-style');
  });

  it('defaultStyle 不在清单中 → 保持未选择', async () => {
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: '不存在的风格' });
    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, null);
  });

  it('显式清除后默认风格不再回填', async () => {
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    await feature.syncStyleState({});
    assert.equal(feature.getStatus().activeStyle, 'test-style');

    feature.setActiveStyle(null);
    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, null);
  });

  it('显式选择其他风格后默认不干预', async () => {
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: '清晰表达' });
    feature.setActiveStyle('test-style');

    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, 'test-style');
  });

  it('activeStyleCleared 随快照往返', async () => {
    const source = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    await source.syncStyleState({});
    source.setActiveStyle(null);
    assert.equal(source.captureState().activeStyleCleared, true);

    const restored = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });
    restored.restoreState(source.captureState());
    await restored.syncStyleState({});

    assert.equal(restored.getStatus().activeStyle, null, '恢复显式清除态后不应回填默认');
  });

  it('旧快照（无 activeStyleCleared 字段）恢复后默认回填生效', async () => {
    const legacySnapshot = { activeStyleName: null, signedForReply: false, blockedCount: 0, lastAction: 'idle' };
    const feature = new StylizedOutput({ workspaceDir, defaultStyle: 'test-style' });

    feature.restoreState(legacySnapshot);
    await feature.syncStyleState({});

    assert.equal(feature.getStatus().activeStyle, 'test-style');
  });

  it('onInitiate featureConfig.defaultStyle 声明默认风格', async () => {
    const feature = new StylizedOutput({ workspaceDir });
    await feature.onInitiate({ logger: undefined, featureConfig: { defaultStyle: 'test-style' }, config: {} });

    assert.equal(feature.getStatus().defaultStyle, 'test-style');
    assert.equal(feature.getStatus().activeStyle, 'test-style');
  });

  it('manifest：单一 section，defaultStyle 为下拉且选项来自内置风格，signatureTolerance 进设置', () => {
    const manifest = new StylizedOutput({ workspaceDir }).getFeatureManifest();
    const sections = manifest.settings.sections;
    const prop = manifest.settings.properties.defaultStyle;

    assert.equal(sections.length, 1);
    assert.deepEqual(sections[0].properties, ['defaultStyle', 'maxSignatureBlocks', 'signatureTolerance']);
    assert.equal(prop.type, 'select');
    const values = prop.options.map((option) => option.value);
    assert.ok(values.includes(''), '应含「不启用默认」空选项');
    assert.ok(values.includes('清晰表达'), '内置风格应出现在选项中');

    const tolerance = manifest.settings.properties.signatureTolerance;
    assert.equal(tolerance.type, 'number');
    assert.equal(tolerance.default, 5);
    assert.equal(tolerance.min, 0);
    assert.equal(tolerance.max, 10);
  });
});
