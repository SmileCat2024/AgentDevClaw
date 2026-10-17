/**
 * ScheduledTrigger 测试（node:test）
 *
 * mock.timers 驱动（禁真实 sleep >500ms），临时目录真实文件 IO：
 * 1. 过期即发：fire_at 已过的条目 arm 后立即回调（overdue 标注）
 * 2. 精确触发：未来条目推进到点后触发（overdue=false）
 * 3. 循环重臂：业务在回调里写回新 fire_at，机制件重读后再触发
 * 4. status 非 scheduled 的条目永不触发（跨重启「已投递不重发」）
 * 5. 同一 (id, fire_at) 进程内只触发一次
 * 6. 长臂粗步进：远期条目分段推进到点
 * 7. 文件不存在 / 数据损坏时 arm 不报错
 *
 * 等待模型：机制件回调链含真实 fs IO，而 mock.timers.tick 只同步触发
 * 「已安排」的 timer——链式重臂（回调 → void arm() → fs 读 → 新 timer）
 * 在 tick 返回后才经真实事件循环落地。因此：
 * - `await trigger.arm()` 已等待首轮完整回调链（含过期即发的 onDue），
 *   断言无需额外等待；
 * - tick 之后用 waitFor(条件) 轮询（真实 setTimeout 让渡，mock 前捕获），
 *   禁止用 setImmediate 盲等（它不等 fs 线程池，时灵时不灵）。
 */

import { describe, it, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import { join } from 'path';
import { ScheduledTrigger, PRECISE_WINDOW_MS, ARM_CHUNK_MS } from '../src/index.js';

/** mock 前捕获的真实 setTimeout（waitFor 的时间让渡通道）。 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'scheduled-trigger-test-'));

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function makeFile(name: string): string {
  return join(tmpRoot, `${name}.json`);
}

interface DueRecord {
  id: string;
  overdue: boolean;
}

function makeTrigger(file: string, onDue: (item: any) => Promise<void>): ScheduledTrigger {
  return new ScheduledTrigger({ dataFile: file, onDue: (item) => onDue(item) });
}

async function writeDoc(file: string, items: unknown[]): Promise<void> {
  await fs.writeFile(file, JSON.stringify({ items }), 'utf8');
}

/** 轮询等待条件成立（真实 fs 回调链落地的等待窗口），不成立耗尽轮次。 */
async function waitFor(cond: () => boolean, rounds = 150, intervalMs = 2): Promise<void> {
  for (let i = 0; i < rounds && !cond(); i++) {
    await new Promise((resolve) => realSetTimeout(resolve, intervalMs));
  }
}

/** 小步推进 mock 时钟直到条件成立（链式重臂：每步醒来等链路落地再推进）。 */
async function tickUntil(stepMs: number, maxSteps: number, cond: () => boolean): Promise<void> {
  for (let i = 0; i < maxSteps && !cond(); i++) {
    mock.timers.tick(stepMs);
    await waitFor(cond, 10);
  }
  await waitFor(cond, 10);
}

describe('ScheduledTrigger', () => {
  it('过期条目 arm 后立即回调，overdue=true 并携带过期毫秒', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const t0 = Date.now();
    const file = makeFile('overdue');
    await writeDoc(file, [{ id: 'a', fire_at: new Date(t0 - 60_000).toISOString(), status: 'scheduled' }]);
    const dues: DueRecord[] = [];
    const trigger = makeTrigger(file, async () => {
      dues.push({ id: 'a', overdue: true });
    });
    try {
      // arm() 等待首轮完整回调链：过期条目在此期间已触发
      await trigger.arm();
      assert.equal(dues.length, 1);
      assert.equal(dues[0].id, 'a');
    } finally {
      trigger.dispose();
      mock.timers.reset();
    }
  });

  it('未到条目推进到点后精确触发，overdue=false', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const t0 = Date.now();
    const file = makeFile('precise');
    await writeDoc(file, [
      { id: 'near', fire_at: new Date(t0 + 5_000).toISOString(), status: 'scheduled' },
    ]);
    const dues: DueRecord[] = [];
    const trigger = makeTrigger(file, async () => {
      dues.push({ id: 'near', overdue: false });
    });
    try {
      await trigger.arm();
      assert.equal(dues.length, 0);
      mock.timers.tick(5_000);
      await waitFor(() => dues.length === 1);
      assert.equal(dues.length, 1);
      assert.equal(dues[0].id, 'near');
    } finally {
      trigger.dispose();
      mock.timers.reset();
    }
  });

  it('循环条目：回调写回新 fire_at 后机制件重臂并再次触发', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const t0 = Date.now();
    const file = makeFile('recurring');
    await writeDoc(file, [{ id: 'loop', fire_at: new Date(t0 + 1_000).toISOString(), status: 'scheduled' }]);
    const firedAt: number[] = [];
    const trigger = makeTrigger(file, async (item) => {
      firedAt.push(Date.now());
      if (firedAt.length === 1) {
        // 业务重算下次 fire_at 写回（+1h）
        const doc = JSON.parse(await fs.readFile(file, 'utf8'));
        doc.items[0].fire_at = new Date(t0 + 60 * 60 * 1000).toISOString();
        await fs.writeFile(file, JSON.stringify(doc), 'utf8');
      }
    });
    try {
      await trigger.arm();
      mock.timers.tick(2_000);
      await waitFor(() => firedAt.length >= 1);
      assert.equal(firedAt.length, 1);
      // 重臂后的新 timer（+1h 时刻）：大步推进到第二次触发（粗步进段 + 精确窗）
      await tickUntil(10 * 60_000, 12, () => firedAt.length >= 2);
      assert.equal(firedAt.length, 2);
    } finally {
      trigger.dispose();
      mock.timers.reset();
    }
  });

  it('status=fired 的条目永不触发', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const t0 = Date.now();
    const file = makeFile('done');
    await writeDoc(file, [
      { id: 'done', fire_at: new Date(t0 - 5_000).toISOString(), status: 'fired' },
      { id: 'live', fire_at: new Date(t0 - 5_000).toISOString(), status: 'scheduled' },
    ]);
    const ids: string[] = [];
    const trigger = makeTrigger(file, async (item) => {
      ids.push(item.id);
    });
    try {
      await trigger.arm();
      assert.deepEqual(ids, ['live']);
    } finally {
      trigger.dispose();
      mock.timers.reset();
    }
  });

  it('同一 (id, fire_at) 进程内只触发一次（业务写回同一时刻不重复触发）', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const t0 = Date.now();
    const file = makeFile('dedupe');
    const fireAt = new Date(t0 - 5_000).toISOString();
    await writeDoc(file, [{ id: 'x', fire_at: fireAt, status: 'scheduled' }]);
    let count = 0;
    const trigger = makeTrigger(file, async () => {
      count += 1;
    });
    try {
      await trigger.arm();
      // 回调后自动重臂（过期补偿语义）：同 key 不应再次触发
      await trigger.arm();
      assert.equal(count, 1);
    } finally {
      trigger.dispose();
      mock.timers.reset();
    }
  });

  it('远期条目经粗步进分段推进到点（防超长 timer 漂移路径）', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const t0 = Date.now();
    const file = makeFile('chunked');
    // 3 个整周之外的时刻：必然经历多段粗步进
    await writeDoc(file, [
      { id: 'far', fire_at: new Date(t0 + ARM_CHUNK_MS * 3 + PRECISE_WINDOW_MS + 1_000).toISOString(), status: 'scheduled' },
    ]);
    const dues: string[] = [];
    const trigger = makeTrigger(file, async (item) => {
      dues.push(item.id);
    });
    try {
      await trigger.arm();
      assert.equal(dues.length, 0);
      // 逐段粗步进：每段醒来只推进，不提前触发
      await mock_step(ARM_CHUNK_MS);
      assert.equal(dues.length, 0);
      await mock_step(ARM_CHUNK_MS);
      assert.equal(dues.length, 0);
      await mock_step(ARM_CHUNK_MS);
      assert.equal(dues.length, 0);
      // 进入精确窗口的剩余 1s：一步到点触发
      mock.timers.tick(PRECISE_WINDOW_MS + 2_000);
      await waitFor(() => dues.length > 0);
      assert.deepEqual(dues, ['far']);
    } finally {
      trigger.dispose();
      mock.timers.reset();
    }
  });

  /** 单步推进 + 让机制件链路落地（粗步进段间无回调，纯推进）。 */
  async function mock_step(ms: number): Promise<void> {
    mock.timers.tick(ms);
    await new Promise((resolve) => realSetTimeout(resolve, 2));
  }

  it('文件不存在与数据损坏时 arm 不报错且不触发', async () => {
    mock.timers.enable({ apis: ['Date'] });
    const missing = makeFile('missing');
    const broken = makeFile('broken');
    await fs.writeFile(broken, '{ not json', 'utf8');
    const triggerA = makeTrigger(missing, async () => assert.fail('should not fire'));
    const triggerB = makeTrigger(broken, async () => assert.fail('should not fire'));
    try {
      await triggerA.arm();
      await triggerB.arm();
    } finally {
      triggerA.dispose();
      triggerB.dispose();
      mock.timers.reset();
    }
  });

  it('dispose 后定时器不再触发（测试收尾不挂句柄）', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'] });
    const t0 = Date.now();
    const file = makeFile('dispose');
    await writeDoc(file, [{ id: 'late', fire_at: new Date(t0 + 1_000).toISOString(), status: 'scheduled' }]);
    let count = 0;
    const trigger = makeTrigger(file, async () => {
      count += 1;
    });
    await trigger.arm();
    trigger.dispose();
    mock.timers.tick(5_000);
    await waitFor(() => false, 5);
    assert.equal(count, 0);
    mock.timers.reset();
  });
});
