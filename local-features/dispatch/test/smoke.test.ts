/**
 * ClawDispatchFeature smoke test
 *
 * 验证双模式注入状态机的核心路径：
 * 1. 活跃 call 期间 → buffer → StepStart 注入 → CallFinish piggyback
 * 2. 空闲 → arbiter fallback
 * 3. CallFinish 时 leftover → arbiter fallback
 * 4. StepStart 空 buffer → no-op
 */

import { ClawDispatchFeature } from '../src/index.js';

async function main(): Promise<void> {
  // ── Mock fetch ──
  const fetchCalls: Array<{ url: string; method: string; body: any }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: any, init?: any) => {
    const urlStr = typeof input === 'string' ? input : String(input);
    let body: any = null;
    if (init?.body) {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    fetchCalls.push({ url: urlStr, method: init?.method || 'GET', body });
    return { status: 200, ok: true, json: async () => ({ ok: true }) } as any;
  }) as typeof fetch;

  const countResponds = () => fetchCalls.filter(c => c.url.includes('/dispatch/respond')).length;
  const lastRespond = () => {
    const responds = fetchCalls.filter(c => c.url.includes('/dispatch/respond'));
    return responds[responds.length - 1];
  };

  try {
    // ═══════════════════════════════════════════════
    // Test 1: 活跃 call 期间 → buffer → StepStart 注入 → CallFinish piggyback
    // ═══════════════════════════════════════════════
    {
      const feature = new ClawDispatchFeature();
      const ctxAdds: any[] = [];
      const mockCtx = {
        context: { add: (msg: any) => ctxAdds.push(msg) },
        step: 1,
      };

      // Call start
      await (feature as any).onCallStartHook();
      if ((feature as any).callActive !== true) {
        throw new Error('T1: callActive should be true after CallStart');
      }

      // 消息到达 → 应缓存
      await (feature as any).handleMessage(
        { id: 'msg-1', text: 'Hello from dispatch' },
        'http://127.0.0.1:1420',
      );
      if ((feature as any).pendingBuffer.length !== 1) {
        throw new Error(`T1: expected 1 buffered, got ${(feature as any).pendingBuffer.length}`);
      }

      // StepStart → 注入
      await (feature as any).onStepStartHook(mockCtx);
      if (ctxAdds.length !== 1) {
        throw new Error(`T1: expected 1 context.add, got ${ctxAdds.length}`);
      }
      if (!ctxAdds[0].content.includes('<system-reminder>')) {
        throw new Error('T1: expected system-reminder wrapper');
      }
      if (!ctxAdds[0].content.includes('Hello from dispatch')) {
        throw new Error('T1: injected content mismatch');
      }
      if ((feature as any).pendingBuffer.length !== 0) {
        throw new Error('T1: buffer should be empty after StepStart injection');
      }
      if ((feature as any).injectedThisCall.length !== 1) {
        throw new Error(`T1: expected 1 injectedThisCall, got ${(feature as any).injectedThisCall.length}`);
      }

      // CallFinish → piggyback respond
      const before = countResponds();
      await (feature as any).onCallFinishHook({ response: 'Final answer' });
      if (countResponds() !== before + 1) {
        throw new Error(`T1: expected 1 piggyback respond, got ${countResponds() - before}`);
      }
      if (lastRespond().body.response !== 'Final answer') {
        throw new Error(`T1: piggyback response mismatch: ${lastRespond().body.response}`);
      }
      if ((feature as any).callActive !== false) {
        throw new Error('T1: callActive should be false after CallFinish');
      }
      if ((feature as any).injectedThisCall.length !== 0) {
        throw new Error('T1: injectedThisCall should be cleared after CallFinish');
      }

      console.log('[PASS] T1: Step-level injection + piggyback');
    }

    // ═══════════════════════════════════════════════
    // Test 2: 空闲时 → arbiter fallback
    // ═══════════════════════════════════════════════
    {
      const feature = new ClawDispatchFeature();
      let enqueueCalled = false;

      (feature as any).arbiterRef = {
        enqueue: (req: any) => {
          enqueueCalled = true;
          return { id: 'entry-1' };
        },
        waitForCompletion: async () => {
          return { status: 'completed', result: 'Arbiter result', error: null };
        },
      };

      // callActive 默认 false → 应走 arbiter
      const before = countResponds();
      await (feature as any).handleMessage(
        { id: 'msg-2', text: 'Idle dispatch' },
        'http://127.0.0.1:1420',
      );

      if (!enqueueCalled) {
        throw new Error('T2: expected arbiter.enqueue to be called');
      }
      if (countResponds() !== before + 1) {
        throw new Error(`T2: expected 1 respond, got ${countResponds() - before}`);
      }
      if (lastRespond().body.response !== 'Arbiter result') {
        throw new Error(`T2: expected arbiter result, got ${lastRespond().body.response}`);
      }

      console.log('[PASS] T2: Idle → arbiter fallback');
    }

    // ═══════════════════════════════════════════════
    // Test 3: CallFinish 时 leftover → arbiter fallback
    // ═══════════════════════════════════════════════
    {
      const feature = new ClawDispatchFeature();
      let arbiterCount = 0;

      (feature as any).arbiterRef = {
        enqueue: () => {
          arbiterCount++;
          return { id: `entry-${arbiterCount}` };
        },
        waitForCompletion: async () => {
          return { status: 'completed', result: 'ok', error: null };
        },
      };

      // Call start → buffer 2 条消息（不走 StepStart）
      await (feature as any).onCallStartHook();
      await (feature as any).handleMessage(
        { id: 'left-1', text: 'Leftover 1' },
        'http://127.0.0.1:1420',
      );
      await (feature as any).handleMessage(
        { id: 'left-2', text: 'Leftover 2' },
        'http://127.0.0.1:1420',
      );
      if ((feature as any).pendingBuffer.length !== 2) {
        throw new Error(`T3: expected 2 buffered, got ${(feature as any).pendingBuffer.length}`);
      }

      // CallFinish → leftover fallback 到 arbiter（异步）
      arbiterCount = 0;
      await (feature as any).onCallFinishHook({ response: 'Done' });

      // 等待异步 leftover dispatch 完成
      await new Promise(resolve => setTimeout(resolve, 200));

      if (arbiterCount !== 2) {
        throw new Error(`T3: expected 2 arbiter calls for leftovers, got ${arbiterCount}`);
      }

      console.log('[PASS] T3: Leftover fallback at CallFinish');
    }

    // ═══════════════════════════════════════════════
    // Test 4: StepStart 空 buffer → no-op
    // ═══════════════════════════════════════════════
    {
      const feature = new ClawDispatchFeature();
      const ctxAdds: any[] = [];
      const mockCtx = {
        context: { add: (msg: any) => ctxAdds.push(msg) },
        step: 1,
      };

      await (feature as any).onCallStartHook();
      await (feature as any).onStepStartHook(mockCtx);

      if (ctxAdds.length !== 0) {
        throw new Error(`T4: expected 0 context.add for empty buffer, got ${ctxAdds.length}`);
      }

      console.log('[PASS] T4: StepStart empty buffer no-op');
    }

    // ═══════════════════════════════════════════════
    // Test 5: 多条消息合并注入
    // ═══════════════════════════════════════════════
    {
      const feature = new ClawDispatchFeature();
      const ctxAdds: any[] = [];
      const mockCtx = {
        context: { add: (msg: any) => ctxAdds.push(msg) },
        step: 2,
      };

      await (feature as any).onCallStartHook();
      await (feature as any).handleMessage(
        { id: 'multi-1', text: 'First' },
        'http://127.0.0.1:1420',
      );
      await (feature as any).handleMessage(
        { id: 'multi-2', text: 'Second' },
        'http://127.0.0.1:1420',
      );

      // 一次 StepStart 注入所有 buffer
      await (feature as any).onStepStartHook(mockCtx);

      if (ctxAdds.length !== 1) {
        throw new Error(`T5: expected 1 merged context.add, got ${ctxAdds.length}`);
      }
      if (!ctxAdds[0].content.includes('First') || !ctxAdds[0].content.includes('Second')) {
        throw new Error('T5: merged content should contain both messages');
      }
      if ((feature as any).injectedThisCall.length !== 2) {
        throw new Error(`T5: expected 2 injectedThisCall, got ${(feature as any).injectedThisCall.length}`);
      }

      // CallFinish → 2 个 piggyback respond
      const before = countResponds();
      await (feature as any).onCallFinishHook({ response: 'Merged answer' });
      if (countResponds() !== before + 2) {
        throw new Error(`T5: expected 2 piggyback responds, got ${countResponds() - before}`);
      }

      console.log('[PASS] T5: Multiple messages merged injection');
    }

    console.log('\n✅ All dispatch smoke tests passed.');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
