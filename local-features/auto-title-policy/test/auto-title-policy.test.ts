/**
 * auto-title-policy 策略契约测试（ADR-0041）
 *
 * 这一层声明的是「应用如何决定标题」：触发时机、去重、用户接管后的行为，
 * 以及失败不残留状态。它不验证服务端如何生成标题——那是能力层的契约。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutoTitlePolicyFeature,
  ENGINEERING_TITLE_INSTRUCTIONS,
  shouldGenerateTitle,
} from '../src/index.js';

function createLogger(): any {
  const entries: Array<{ level: string; args: unknown[] }> = [];
  const push = (level: string) => (...args: unknown[]) => { entries.push({ level, args }); };
  const logger: any = { entries, trace: push('trace'), debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') };
  logger.child = () => logger;
  return logger;
}

/** 可手动投递事件的假总线，记录订阅/退订次数。 */
function createBus() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    listeners,
    subscribe(fn: (event: unknown) => void) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    emit(event: unknown) {
      for (const fn of listeners) fn(event);
    },
  };
}

function createFeature(overrides: Record<string, unknown> = {}) {
  const calls = [];
  const feature = new AutoTitlePolicyFeature({
    agentId: 'programming-helper',
    serverOrigin: 'http://127.0.0.1:1420',
    fetchImpl: async (url: string, options: { body: string }) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ok: true, title: '修复标题触发时机' }) };
    },
    ...overrides,
  } as any);
  return { feature, calls };
}

describe('shouldGenerateTitle', () => {
  it('only considers successfully delivered turns, not suspended ones', () => {
    const state: any = { generatedAt: {} };
    // 挂起的回合虽然落定（ADR-0019），工作尚未交付；此时起名会描述半成品。
    assert.equal(shouldGenerateTitle({ eventType: 'turn.completed', suspended: true, sessionId: 's1' }, state), false);
    assert.equal(shouldGenerateTitle({ eventType: 'turn.completed', sessionId: 's1' }, state), true);
  });

  it('ignores non-terminal and non-completed events', () => {
    const state: any = { generatedAt: {} };
    for (const type of ['turn.started', 'turn.failed', 'turn.cancelled', '']) {
      assert.equal(shouldGenerateTitle({ eventType: type, sessionId: 's1' }, state), false, type);
    }
  });

  it('titles each session at most once per recorded generation', () => {
    const state: any = { generatedAt: {} };
    assert.equal(shouldGenerateTitle({ eventType: 'turn.completed', sessionId: 's1' }, state), true);
    state.generatedAt.s1 = Date.now();
    assert.equal(shouldGenerateTitle({ eventType: 'turn.completed', sessionId: 's1' }, state), false);
    // 另一个会话是独立个体，不能互相抑制。
    assert.equal(shouldGenerateTitle({ eventType: 'turn.completed', sessionId: 's2' }, state), true);
  });
});

describe('AutoTitlePolicyFeature', () => {
  it('requests generation once after the first delivered turn', async () => {
    const { feature, calls } = createFeature();
    await feature.onInitiate({ logger: createLogger() } as any);
    const bus = createBus();
    feature.setTurnEventBus(bus);

    bus.emit({ type: 'turn.completed', sessionId: 'session-a' });
    bus.emit({ type: 'turn.completed', sessionId: 'session-a' });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.length, 1, '同一会话的重复交付不得重复起名');
    assert.equal(calls[0].url, 'http://127.0.0.1:1420/protoclaw/generate_session_title');
    assert.equal(calls[0].body.agentId, 'programming-helper');
    assert.equal(calls[0].body.sessionId, 'session-a');
  });

  it('sends its own title instructions instead of relying on server defaults', async () => {
    const { feature, calls } = createFeature();
    await feature.onInitiate({ logger: createLogger() } as any);
    const bus = createBus();
    feature.setTurnEventBus(bus);

    bus.emit({ type: 'turn.completed', sessionId: 'session-b' });
    await new Promise((r) => setTimeout(r, 0));

    // 策略属于应用：规则必须由本应用给出，否则又会退回 OS 的统一风格。
    assert.equal(calls[0].body.params.instructions, ENGINEERING_TITLE_INSTRUCTIONS);
    assert.equal(calls[0].body.allowUserOverride, false);
  });

  it('lets the application override instructions and model role', async () => {
    const { feature, calls } = createFeature({ instructions: '只写一句结论', modelRole: 'fast' });
    await feature.onInitiate({ logger: createLogger() } as any);
    const bus = createBus();
    feature.setTurnEventBus(bus);

    bus.emit({ type: 'turn.completed', sessionId: 'session-c' });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls[0].body.params.instructions, '只写一句结论');
    assert.equal(calls[0].body.params.modelRole, 'fast');
  });

  it('retries after a failed request instead of recording a permanent skip', async () => {
    let attempt = 0;
    const { feature } = createFeature({
      fetchImpl: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom');
        return { ok: true, json: async () => ({ ok: true, title: 't' }) };
      },
    } as any);
    const logger = createLogger();
    await feature.onInitiate({ logger } as any);
    const bus = createBus();
    feature.setTurnEventBus(bus);

    bus.emit({ type: 'turn.completed', sessionId: 'session-d' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(attempt, 1);
    assert.equal(logger.entries.some((e) => e.level === 'warn'), true);

    // 失败不得让会话永久失去起名机会。
    bus.emit({ type: 'turn.completed', sessionId: 'session-d' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(attempt, 2);
  });

  it('treats a server-side skip as settled rather than retrying', async () => {
    let attempt = 0;
    const skipLogger = createLogger();
    const feature = new AutoTitlePolicyFeature({
      agentId: 'programming-helper',
      serverOrigin: 'http://127.0.0.1:1420',
      fetchImpl: async () => {
        attempt += 1;
        return { ok: true, json: async () => ({ ok: true, skipped: 'user_owned_title' }) };
      },
    } as any);
    await feature.onInitiate({ logger: skipLogger } as any);
    const bus = createBus();
    feature.setTurnEventBus(bus);

    bus.emit({ type: 'turn.completed', sessionId: 'session-e' });
    await new Promise((r) => setTimeout(r, 0));
    bus.emit({ type: 'turn.completed', sessionId: 'session-e' });
    await new Promise((r) => setTimeout(r, 0));

    // 用户已改名的会话保持用户的选择，不应反复请求。
    assert.equal(attempt, 1);
    assert.equal(skipLogger.entries.some((e) => e.level === 'info'), true);
  });

  it('keeps the generation record across snapshot restore', async () => {
    const { feature } = createFeature();
    await feature.onInitiate({ logger: createLogger() } as any);
    const bus = createBus();
    feature.setTurnEventBus(bus);
    bus.emit({ type: 'turn.completed', sessionId: 'session-f' });
    await new Promise((r) => setTimeout(r, 0));

    const snapshot: any = feature.captureState();
    const revived = createFeature().feature;
    revived.restoreState(snapshot);

    // runtime 重启后不能把已起名的会话当成新会话再生成一次。
    assert.equal(
      shouldGenerateTitle({ eventType: 'turn.completed', sessionId: 'session-f' }, snapshot),
      false,
    );
  });

  it('stops receiving events after dispose', async () => {
    const { feature, calls } = createFeature();
    await feature.onInitiate({ logger: createLogger() } as any);
    const bus = createBus();
    feature.setTurnEventBus(bus);
    feature.dispose();

    bus.emit({ type: 'turn.completed', sessionId: 'session-g' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.length, 0);
    assert.equal(bus.listeners.size, 0);
  });
});
