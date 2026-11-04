/**
 * 会话标题能力（ADR-0041 决策 3）
 *
 * 行为契约：
 * 1. 生成参数化：不传 params 时使用与改造前一致的缺省值；传入的提示词
 *    规则、模型角色、上下文范围原样下发到执行端。
 * 2. 用户接管的标题不被后台生成覆盖；调用方显式要求时可以。
 * 3. 生成写入来源为 app（titleState=auto），用户改名写入来源为 user。
 * 4. 生成失败不抛异常、不写入，返回结构化失败原因。
 * 5. 校验统一：包裹引号、句末标点、多行、超长都按同一规则归一。
 *
 * 依赖全部注入，不启动子进程、不读真实数据目录。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSessionTitleService,
  normalizeTitleParams,
  validateTitleText,
  canOverwriteTitle,
  DEFAULT_TITLE_PARAMS,
  TITLE_SOURCE,
} from '../server/shared/session-title-service.js';

/** 造一个内存索引，模拟 updateSessionIndex 的读改写语义。 */
function makeStore(sessions) {
  const state = { sessions: sessions.map((s) => ({ ...s })) };
  return {
    state,
    async findRecord(agentId, sessionId) {
      const found = state.sessions.find((s) => s.id === sessionId);
      return found ? { ...found } : null;
    },
    async updateIndex(agentId, mutator) {
      const next = mutator({ sessions: state.sessions.map((s) => ({ ...s })) });
      if (next?.sessions) state.sessions = next.sessions;
      return { ...next, sessions: state.sessions };
    },
  };
}

function makeService(sessions, { generation } = {}) {
  const store = makeStore(sessions);
  const calls = [];
  const service = createSessionTitleService({
    findRecord: store.findRecord,
    updateIndex: store.updateIndex,
    async runGeneration(request) {
      calls.push(request);
      if (generation) return generation(request);
      return { title: '生成的标题' };
    },
  });
  return { service, store, calls };
}

describe('标题能力：生成参数', () => {
  test('不传参数时下发与改造前一致的缺省值', async () => {
    const { service, calls } = makeService([{ id: 's1', title: '新对话1', titleState: 'placeholder' }]);
    const result = await service.generateSessionTitle({ agentId: 'a', sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, normalizeTitleParams(undefined));
    assert.equal(calls[0].params.modelRole, DEFAULT_TITLE_PARAMS.modelRole);
    assert.equal(calls[0].params.contextRange.recentMessages, 32);
  });

  test('调用方提供的规则、模型与上下文范围原样下发', async () => {
    const { service, calls } = makeService([{ id: 's1', title: '新对话1', titleState: 'placeholder' }]);
    await service.generateSessionTitle({
      agentId: 'a',
      sessionId: 's1',
      params: {
        modelRole: 'worker',
        instructions: '标题只写技术栈名称',
        contextRange: { recentMessages: 6, includeFirstUserMessage: false },
      },
    });
    assert.equal(calls[0].params.modelRole, 'worker');
    assert.equal(calls[0].params.instructions, '标题只写技术栈名称');
    assert.equal(calls[0].params.contextRange.recentMessages, 6);
    assert.equal(calls[0].params.contextRange.includeFirstUserMessage, false);
  });

  test('非法参数逐项回落缺省值而不是回落到空', async () => {
    const normalized = normalizeTitleParams({
      modelRole: '   ',
      contextRange: { recentMessages: -5 },
    });
    assert.equal(normalized.modelRole, 'system', '空角色必须回落，不能变成空模型角色');
    assert.equal(normalized.contextRange.recentMessages, 32, '非法条数回落缺省而不是 0');
  });
});

describe('标题能力：用户接管保护', () => {
  test('用户改过名的会话，后台生成被跳过且不调用模型', async () => {
    const { service, store, calls } = makeService([
      { id: 's1', title: '用户起的名字', titleState: 'user' },
    ]);
    const result = await service.generateSessionTitle({ agentId: 'a', sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, 'user_owned_title');
    assert.equal(result.title, '用户起的名字');
    assert.equal(calls.length, 0, '跳过必须发生在调用模型之前');
    assert.equal(store.state.sessions[0].title, '用户起的名字');
  });

  test('调用方显式要求时可以覆盖用户标题', async () => {
    const { service, store } = makeService([
      { id: 's1', title: '用户起的名字', titleState: 'user' },
    ]);
    const result = await service.generateSessionTitle({
      agentId: 'a',
      sessionId: 's1',
      allowUserOverride: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, undefined);
    assert.equal(store.state.sessions[0].title, '生成的标题');
  });

  test('生成期间用户改名，迟到结果被丢弃并回报实际生效标题', async () => {
    // 模拟：生成开始时会话可覆盖，落盘前用户改名为 user。
    const store = makeStore([{ id: 's1', title: '新对话1', titleState: 'placeholder' }]);
    const service = createSessionTitleService({
      findRecord: store.findRecord,
      async updateIndex(agentId, mutator) {
        // 在索引事务内部，把状态改成用户接管，模拟并发改名已落盘。
        store.state.sessions[0].title = '用户刚改的名字';
        store.state.sessions[0].titleState = 'user';
        const next = mutator({ sessions: store.state.sessions.map((s) => ({ ...s })) });
        return { ...next, sessions: next.sessions };
      },
      async runGeneration() {
        return { title: '迟到的生成标题' };
      },
    });

    const result = await service.generateSessionTitle({ agentId: 'a', sessionId: 's1' });
    assert.equal(result.ok, true);
    assert.equal(result.title, '用户刚改的名字',
      '必须回报实际落盘的标题，不能让调用方乐观写入未保存的值');
    assert.equal(store.state.sessions[0].title, '用户刚改的名字', '用户标题不得被迟到结果覆盖');
  });
});

describe('标题能力：来源标记', () => {
  test('生成写入标记为 auto，用户改名标记为 user', async () => {
    const { service, store } = makeService([
      { id: 's1', title: '新对话1', titleState: 'placeholder' },
      { id: 's2', title: '新对话2', titleState: 'placeholder' },
    ]);

    await service.generateSessionTitle({ agentId: 'a', sessionId: 's1' });
    assert.equal(store.state.sessions.find((s) => s.id === 's1').titleState, 'auto');

    await service.writeSessionTitle({
      agentId: 'a', sessionId: 's2', title: '手动名字', source: TITLE_SOURCE.USER,
    });
    assert.equal(store.state.sessions.find((s) => s.id === 's2').titleState, 'user');
  });

  test('直接写入不经过模型', async () => {
    const { service, calls, store } = makeService([
      { id: 's1', title: '新对话1', titleState: 'placeholder' },
    ]);
    const result = await service.writeSessionTitle({
      agentId: 'a', sessionId: 's1', title: '应用自己算好的标题',
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 0, '直接写入不得触发模型调用');
    assert.equal(store.state.sessions[0].title, '应用自己算好的标题');
    assert.equal(store.state.sessions[0].titleState, 'auto');
  });
});

describe('标题能力：失败与校验', () => {
  test('生成失败返回结构化原因，不写入会话', async () => {
    const { service, store } = makeService(
      [{ id: 's1', title: '新对话1', titleState: 'placeholder' }],
      { generation: () => { throw new Error('model unreachable'); } },
    );
    const result = await service.generateSessionTitle({ agentId: 'a', sessionId: 's1' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'model unreachable');
    assert.equal(store.state.sessions[0].title, '新对话1', '失败不得留下部分写入');
  });

  test('会话不存在时明确失败', async () => {
    const { service } = makeService([]);
    const result = await service.generateSessionTitle({ agentId: 'a', sessionId: 'missing' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'session_not_found');
  });

  test('校验统一处理引号、句末标点、多行与超长', () => {
    assert.equal(validateTitleText('“修复登录循环”').title, '修复登录循环');
    assert.equal(validateTitleText('重构支付回调。').title, '重构支付回调');
    // 多行合并为单行空格分隔：与改造前 sanitizeGeneratedTitle 逐项一致
    // （换行先被 \s+ 压成空格，随后的首段切分自然无换行可切）。
    assert.equal(validateTitleText('第一行\n第二行').title, '第一行 第二行');
    assert.equal(validateTitleText('  ').ok, false);
    assert.equal(validateTitleText(null).ok, false);
    assert.equal(validateTitleText('a'.repeat(200)).title.length, 60);
    assert.equal(validateTitleText('含无效\ufffd字符').ok, false,
      '编码损坏的标题必须在入口拒绝，不能入库成脏数据');
  });

  test('不传参数时默认允许覆盖占位与自动标题，拒绝用户标题', () => {
    assert.equal(canOverwriteTitle({ titleState: 'placeholder' }), true);
    assert.equal(canOverwriteTitle({ titleState: 'auto' }), true);
    assert.equal(canOverwriteTitle({ titleState: 'user' }), false);
    assert.equal(canOverwriteTitle({ titleState: 'user' }, { allowUserOverride: true }), true);
    // 来源未知（改造前记录）：不是用户接管，可被应用策略更新。
    assert.equal(canOverwriteTitle({}), true);
    assert.equal(canOverwriteTitle(null), false);
  });
});
