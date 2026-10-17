/**
 * MemoRemindersFeature 测试（node:test）
 *
 * mock.timers 驱动 + 注入 dataFile / fetchImpl，覆盖：
 * 1. schema 校验（fire_at 偏移 / recurrence / weekdays / delivery）
 * 2. 工具面 CRUD（create 落盘 / list / complete 幂等 / delete）
 * 3. 循环重算（daily / weekly / monthly 下次 fire_at，含月末 clamp）
 * 4. 到点投递（direct 弹通知 / agent 唤醒线程 / 悬空与失败降级直弹）
 * 5. 到点后条目去留（once 标 fired、daily 重算写回后再臂、删除不复活）
 *
 * 等待模型：机制件回调链含真实 fs IO，mock.timers.tick 只同步触发「已安排」
 * 的 timer，链式重臂（回调 → void arm() → fs 读 → 新 timer）在 tick 返回后
 * 才落地。因此：
 * - `await feature.onInitiate()`（内部 await trigger.arm()）已等待首轮完整
 *   回调链（含过期即发的投递与落盘），断言无需额外等待；
 * - tick 之后用 waitFor(条件) 轮询（真实 setTimeout 让渡，mock 前捕获），
 *   禁止用 setImmediate 盲等（它不等 fs 线程池，时灵时不灵）。
 */

import { describe, it, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import { join } from 'path';
import {
  MemoRemindersFeature,
  computeNextFireAt,
  normalizeFireAt,
  normalizeWeekdays,
  type ReminderEntry,
} from '../src/index.js';

/** mock 前捕获的真实 setTimeout（waitFor 的时间让渡通道）。 */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

const tmpRoot = await fs.mkdtemp(join(os.tmpdir(), 'memo-reminders-test-'));

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** 轮询等待条件成立（真实 fs 回调链落地的等待窗口），不成立耗尽轮次。 */
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  rounds = 150,
  intervalMs = 2,
): Promise<void> {
  for (let i = 0; i < rounds && !(await cond()); i++) {
    await new Promise((resolve) => realSetTimeout(resolve, intervalMs));
  }
}

/** 小步推进 mock 时钟直到条件成立（链式重臂：每步醒来等链路落地再推进）。 */
async function tickUntil(
  stepMs: number,
  maxSteps: number,
  cond: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < maxSteps && !(await cond()); i++) {
    mock.timers.tick(stepMs);
    await waitFor(cond, 10);
  }
  await waitFor(cond, 10);
}

function makeFeature(name: string, fetchImpl?: typeof fetch): MemoRemindersFeature {
  return new MemoRemindersFeature({
    dataFile: join(tmpRoot, `${name}.json`),
    agentId: 'memo',
    sessionId: 'session-test',
    serverOrigin: 'http://server.test',
    fetchImpl,
  });
}

async function seedReminder(file: string, entry: Partial<ReminderEntry>): Promise<ReminderEntry> {
  const full: ReminderEntry = {
    id: 'r1',
    content: '开会',
    fire_at: new Date().toISOString(),
    recurrence: 'once',
    delivery: 'direct',
    status: 'scheduled',
    createdAt: new Date().toISOString(),
    ...entry,
  };
  await fs.writeFile(file, JSON.stringify({ items: [full] }), 'utf8');
  return full;
}

interface FetchCall {
  url: string;
  method: string;
  body: any;
}

interface FetchRoute {
  match: (url: string) => boolean;
  status?: number;
  json?: unknown;
}

function makeFetch(routes: FetchRoute[] = []): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: any, init?: any) => {
    const urlText = String(url);
    calls.push({
      url: urlText,
      method: String(init?.method || 'GET'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const route = routes.find((entry) => entry.match(urlText));
    const status = route?.status ?? 200;
    const json = route?.json ?? { ok: true, delivered: true };
    return { ok: status >= 200 && status < 300, status, json: async () => json } as any;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function toolByName(feature: MemoRemindersFeature, name: string) {
  const tool = feature.getTools().find((entry) => entry.name === name);
  assert.ok(tool, `tool ${name} should be registered`);
  return tool;
}

// ── schema 校验 ─────────────────────────────────────────────────────

describe('memo_create_reminder schema 校验', () => {
  it('拒绝空 content', async () => {
    const feature = makeFeature('schema-empty-content');
    const create = toolByName(feature, 'memo_create_reminder');
    const result: any = await create.execute({ content: '  ', fire_at: '2026-10-18T09:00:00+08:00', recurrence: 'once', delivery: 'direct' });
    assert.ok(result.error);
  });

  it('fire_at 必须带时区偏移（裸本地时间与缺时区均拒绝）', async () => {
    assert.equal(normalizeFireAt('2026-10-18T09:00:00'), null);
    assert.equal(normalizeFireAt('2026-10-18'), null);
    assert.equal(normalizeFireAt('not-a-date'), null);
    assert.ok(normalizeFireAt('2026-10-18T09:00:00+08:00'));
    assert.ok(normalizeFireAt('2026-10-18T09:00:00+0800'));
    assert.ok(normalizeFireAt('2026-10-18T01:00:00Z'));
  });

  it('recurrence / delivery 枚举外的值拒绝', async () => {
    const feature = makeFeature('schema-enum');
    const create = toolByName(feature, 'memo_create_reminder');
    const badRecurrence: any = await create.execute({ content: 'x', fire_at: '2026-10-18T09:00:00+08:00', recurrence: 'cron', delivery: 'direct' });
    assert.match(badRecurrence.error, /recurrence/);
    const badDelivery: any = await create.execute({ content: 'x', fire_at: '2026-10-18T09:00:00+08:00', recurrence: 'once', delivery: 'push' });
    assert.match(badDelivery.error, /delivery/);
    const missingDelivery: any = await create.execute({ content: 'x', fire_at: '2026-10-18T09:00:00+08:00', recurrence: 'once' });
    assert.match(missingDelivery.error, /delivery/);
  });

  it('weekly 必须携带合法 weekdays（0-6、无重复）', async () => {
    assert.equal(normalizeWeekdays(undefined), null);
    assert.equal(normalizeWeekdays([]), null);
    assert.equal(normalizeWeekdays([7]), null);
    assert.equal(normalizeWeekdays([1.5]), null);
    assert.equal(normalizeWeekdays([1, 1]), null);
    assert.deepEqual(normalizeWeekdays([1, 3]), [1, 3]);
    const feature = makeFeature('schema-weekly');
    const create = toolByName(feature, 'memo_create_reminder');
    try {
      const missing: any = await create.execute({ content: 'x', fire_at: '2026-10-18T09:00:00+08:00', recurrence: 'weekly', delivery: 'direct' });
      assert.match(missing.error, /weekdays/);
      const bad: any = await create.execute({ content: 'x', fire_at: '2026-10-18T09:00:00+08:00', recurrence: 'weekly', weekdays: [9], delivery: 'direct' });
      assert.match(bad.error, /weekdays/);
      const good: any = await create.execute({ content: '例会', fire_at: '2026-10-19T09:00:00+08:00', recurrence: 'weekly', weekdays: [1], delivery: 'direct' });
      assert.equal(good.ok, true);
      assert.deepEqual(good.reminder.weekdays, [1]);
    } finally {
      // create 成功路径会臂真实未来 timer，不 dispose 会撑住测试进程
      feature.dispose();
    }
  });
});

// ── 工具面 CRUD ─────────────────────────────────────────────────────

describe('工具面 CRUD', () => {
  it('create 落盘并返回条目（文件为 { items: [...] } 原子写形态）', async () => {
    const feature = makeFeature('crud-create');
    const create = toolByName(feature, 'memo_create_reminder');
    try {
      const result: any = await create.execute({ content: '买牛奶', fire_at: '2026-10-18T09:00:00+08:00', recurrence: 'once', delivery: 'direct' });
      assert.equal(result.ok, true);
      assert.equal(result.reminder.status, 'scheduled');
      const doc = JSON.parse(await fs.readFile(join(tmpRoot, 'crud-create.json'), 'utf8'));
      assert.equal(doc.items.length, 1);
      assert.equal(doc.items[0].content, '买牛奶');
      assert.ok(doc.items[0].id);
    } finally {
      // create 成功路径会臂真实未来 timer，不 dispose 会撑住测试进程
      feature.dispose();
    }
  });

  it('list 返回全部条目与摘要文本', async () => {
    const file = join(tmpRoot, 'crud-list.json');
    await seedReminder(file, { id: 'a', content: '第一条' });
    const feature = makeFeature('crud-list');
    const list = toolByName(feature, 'memo_list_reminders');
    const result: any = await list.execute({});
    assert.equal(result.reminders.length, 1);
    assert.match(result.text, /第一条/);
    assert.match(result.text, /id=a/);
  });

  it('complete 标 fired；重复完成幂等；不存在报错', async () => {
    const file = join(tmpRoot, 'crud-complete.json');
    await seedReminder(file, { id: 'a' });
    const feature = makeFeature('crud-complete');
    const complete = toolByName(feature, 'memo_complete_reminder');
    const first: any = await complete.execute({ id: 'a' });
    assert.equal(first.ok, true);
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(doc.items[0].status, 'fired');
    const second: any = await complete.execute({ id: 'a' });
    assert.equal(second.ok, true);
    assert.ok(second.note);
    const missing: any = await complete.execute({ id: 'ghost' });
    assert.match(missing.error, /不存在/);
  });

  it('delete 移除条目；不存在报错', async () => {
    const file = join(tmpRoot, 'crud-delete.json');
    await seedReminder(file, { id: 'a' });
    const feature = makeFeature('crud-delete');
    const remove = toolByName(feature, 'memo_delete_reminder');
    const result: any = await remove.execute({ id: 'a' });
    assert.equal(result.ok, true);
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(doc.items.length, 0);
    const missing: any = await remove.execute({ id: 'ghost' });
    assert.match(missing.error, /不存在/);
  });
});

// ── 循环重算 ────────────────────────────────────────────────────────

describe('computeNextFireAt 循环重算', () => {
  // 期望值全部用本地日历字段构造，与运行环境时区无关（不做 DST 特判）。
  function localFields(baseIso: string): { h: number; m: number; s: number } {
    const base = new Date(baseIso);
    return { h: base.getHours(), m: base.getMinutes(), s: base.getSeconds() };
  }

  it('daily：错过 1 小时 → 明天同时刻（不落在已过去的今天）', () => {
    const baseIso = '2026-05-11T09:00:00+08:00'; // 5 月，无 DST 风险窗口
    const base = new Date(baseIso).getTime();
    const next = computeNextFireAt('daily', baseIso, undefined, base + 60 * 60 * 1000);
    assert.ok(next);
    const expect = new Date(baseIso);
    expect.setDate(expect.getDate() + 1);
    assert.equal(new Date(next!).getTime(), expect.getTime());
  });

  it('daily：错过多个周期 → 严格未来的最近一天', () => {
    const baseIso = '2026-06-01T08:00:00+08:00';
    const base = new Date(baseIso).getTime();
    const next = computeNextFireAt('daily', baseIso, undefined, base + 3 * 24 * 60 * 60 * 1000);
    assert.ok(next);
    const expect = new Date(baseIso);
    expect.setDate(expect.getDate() + 4);
    assert.equal(new Date(next!).getTime(), expect.getTime());
  });

  it('weekly：命中 weekdays 集合的下一个匹配日', () => {
    const baseIso = '2026-07-06T10:30:00+08:00';
    const base = new Date(baseIso);
    const next = computeNextFireAt('weekly', baseIso, [base.getDay()], base.getTime() + 60_000);
    assert.ok(next);
    const expect = new Date(baseIso);
    expect.setDate(expect.getDate() + 7);
    assert.equal(new Date(next!).getTime(), expect.getTime());
  });

  it('monthly：31 号在 2 月 clamp 到月末', () => {
    const baseIso = '2026-01-31T09:00:00+08:00';
    const base = new Date(baseIso).getTime();
    const next = computeNextFireAt('monthly', baseIso, undefined, base + 60 * 60 * 1000);
    assert.ok(next);
    const got = new Date(next!);
    const { h, m, s } = localFields(baseIso);
    const expect = new Date(2026, 1, 28, h, m, s); // 2026 非闰年
    assert.equal(got.getTime(), expect.getTime());
  });

  it('monthly：错过当月 → 下月同日', () => {
    const baseIso = '2026-03-15T07:00:00+08:00';
    const base = new Date(baseIso).getTime();
    const next = computeNextFireAt('monthly', baseIso, undefined, base + 2 * 60_000);
    assert.ok(next);
    const got = new Date(next!);
    const { h, m, s } = localFields(baseIso);
    const expect = new Date(2026, 3, 15, h, m, s);
    assert.equal(got.getTime(), expect.getTime());
  });

  it('非法数据返回 null', () => {
    assert.equal(computeNextFireAt('weekly', '2026-01-01T00:00:00Z', [], Date.now()), null);
    assert.equal(computeNextFireAt('daily', 'not-a-date', undefined, Date.now()), null);
  });
});

// ── 到点投递 ────────────────────────────────────────────────────────

describe('到点投递', () => {
  const T0 = 1_770_000_000_000; // 固定时钟起点（2026-02-02 前后，无 DST 依赖）

  it('direct 到点：POST /protoclaw/app_notifications（agentId=memo、type=reminder），条目标 fired', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
    const file = join(tmpRoot, 'due-direct.json');
    await seedReminder(file, { id: 'd1', fire_at: new Date(T0 + 1_000).toISOString(), delivery: 'direct' });
    const { calls, fetchImpl } = makeFetch();
    const feature = makeFeature('due-direct', fetchImpl);
    try {
      await feature.onInitiate({ logger: fakeLogger() } as any);
      assert.equal(calls.length, 0);
      mock.timers.tick(2_000);
      const posted = () => calls.find((call) => call.url === 'http://server.test/protoclaw/app_notifications');
      await waitFor(async () => {
        if (!posted()) return false;
        const doc = JSON.parse(await fs.readFile(file, 'utf8'));
        return doc.items[0]?.status === 'fired';
      });
      assert.ok(posted(), 'should post to app_notifications');
      assert.equal(posted()!.body.agentId, 'memo');
      assert.equal(posted()!.body.type, 'reminder');
      assert.equal(posted()!.body.title, 'Memo 提醒');
      assert.equal(posted()!.body.body, '开会');
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(doc.items[0].status, 'fired');
    } finally {
      feature.dispose();
      mock.timers.reset();
    }
  });

  it('direct 过期补发：文案标注「错过了预定时间」', async () => {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    const file = join(tmpRoot, 'due-overdue.json');
    await seedReminder(file, { id: 'd2', fire_at: new Date(T0 - 2 * 60 * 60 * 1000).toISOString(), delivery: 'direct' });
    const { calls, fetchImpl } = makeFetch();
    const feature = makeFeature('due-overdue', fetchImpl);
    try {
      // onInitiate 内部 await trigger.arm()：过期条目的投递与落盘已完整落定
      await feature.onInitiate({ logger: fakeLogger() } as any);
      const posted = calls.find((call) => call.url.endsWith('/protoclaw/app_notifications'));
      assert.ok(posted);
      assert.match(posted.body.body, /错过了预定时间/);
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(doc.items[0].status, 'fired');
    } finally {
      feature.dispose();
      mock.timers.reset();
    }
  });

  it('agent 到点：解析活动线程并唤醒（kind=reminder），不弹直弹通知', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
    const file = join(tmpRoot, 'due-agent.json');
    await seedReminder(file, { id: 'a1', fire_at: new Date(T0 + 1_000).toISOString(), delivery: 'agent' });
    const { calls, fetchImpl } = makeFetch([
      {
        match: (url) => url.endsWith('/protoclaw/memo-app/state'),
        json: { ok: true, activeThread: { threadId: 'th-1' } },
      },
      { match: (url) => url.includes('/protoclaw/threads/th-1/input'), json: { ok: true } },
    ]);
    const feature = makeFeature('due-agent', fetchImpl);
    try {
      await feature.onInitiate({ logger: fakeLogger() } as any);
      mock.timers.tick(2_000);
      await waitFor(async () => {
        const doc = JSON.parse(await fs.readFile(file, 'utf8'));
        return doc.items[0]?.status === 'fired';
      });
      const state = calls.find((call) => call.url.endsWith('/protoclaw/memo-app/state'));
      const wake = calls.find((call) => call.url.includes('/protoclaw/threads/th-1/input'));
      assert.ok(state, 'should resolve active thread');
      assert.ok(wake, 'should wake the thread');
      assert.equal(wake.body.kind, 'reminder');
      assert.match(wake.body.text, /开会/);
      assert.ok(!calls.some((call) => call.url.endsWith('/protoclaw/app_notifications')), 'no fallback toast');
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(doc.items[0].status, 'fired');
    } finally {
      feature.dispose();
      mock.timers.reset();
    }
  });

  it('活动线程悬空：agent 降级直弹登记文案', async () => {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    const file = join(tmpRoot, 'due-agent-orphan.json');
    await seedReminder(file, { id: 'a2', fire_at: new Date(T0 - 1_000).toISOString(), delivery: 'agent' });
    const { calls, fetchImpl } = makeFetch([
      { match: (url) => url.endsWith('/protoclaw/memo-app/state'), json: { ok: true, activeThread: null } },
    ]);
    const feature = makeFeature('due-agent-orphan', fetchImpl);
    try {
      await feature.onInitiate({ logger: fakeLogger() } as any);
      const posted = calls.find((call) => call.url.endsWith('/protoclaw/app_notifications'));
      assert.ok(posted, 'should fall back to direct notification');
      assert.equal(posted.body.body, '开会');
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(doc.items[0].status, 'fired');
    } finally {
      feature.dispose();
      mock.timers.reset();
    }
  });

  it('agent 唤醒失败（input 端点 500）：同样降级直弹', async () => {
    mock.timers.enable({ apis: ['Date'], now: T0 });
    const file = join(tmpRoot, 'due-agent-wake-fail.json');
    await seedReminder(file, { id: 'a3', fire_at: new Date(T0 - 1_000).toISOString(), delivery: 'agent' });
    const { calls, fetchImpl } = makeFetch([
      { match: (url) => url.endsWith('/protoclaw/memo-app/state'), json: { ok: true, activeThread: { threadId: 'th-2' } } },
      { match: (url) => url.includes('/protoclaw/threads/th-2/input'), status: 503 },
    ]);
    const feature = makeFeature('due-agent-wake-fail', fetchImpl);
    try {
      await feature.onInitiate({ logger: fakeLogger() } as any);
      assert.ok(calls.some((call) => call.url.endsWith('/protoclaw/app_notifications')));
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(doc.items[0].status, 'fired');
    } finally {
      feature.dispose();
      mock.timers.reset();
    }
  });

  it('daily 循环：触发后 fire_at 重算写回、status 保持 scheduled，再臂后再次触发', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
    const file = join(tmpRoot, 'due-daily.json');
    const fireAt = new Date(T0 + 1_000).toISOString();
    await seedReminder(file, { id: 'loop', fire_at: fireAt, recurrence: 'daily', delivery: 'direct' });
    const { fetchImpl } = makeFetch();
    const feature = makeFeature('due-daily', fetchImpl);
    try {
      await feature.onInitiate({ logger: fakeLogger() } as any);
      mock.timers.tick(2_000);
      const expect = new Date(fireAt);
      expect.setDate(expect.getDate() + 1);
      await waitFor(async () => {
        const doc = JSON.parse(await fs.readFile(file, 'utf8'));
        return new Date(doc.items[0].fire_at).getTime() === expect.getTime();
      });
      let doc = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(doc.items[0].status, 'scheduled');
      assert.equal(new Date(doc.items[0].fire_at).getTime(), expect.getTime());
      // 推进到重算后的下一次触发（1 天步进跨过粗步进段，waitFor 让链式重臂跟进）
      const expect2 = new Date(fireAt);
      expect2.setDate(expect2.getDate() + 2);
      await tickUntil(24 * 60 * 60 * 1000, 4, async () => {
        const current = JSON.parse(await fs.readFile(file, 'utf8'));
        return new Date(current.items[0].fire_at).getTime() >= expect2.getTime();
      });
      doc = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(new Date(doc.items[0].fire_at).getTime(), expect2.getTime());
    } finally {
      feature.dispose();
      mock.timers.reset();
    }
  });

  it('到点前被删除的条目：机制件重读后不再触发（无幽灵投递，不复活条目）', async () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: T0 });
    const file = join(tmpRoot, 'due-deleted.json');
    await seedReminder(file, { id: 'gone', fire_at: new Date(T0 + 1_000).toISOString(), delivery: 'direct' });
    const { calls, fetchImpl } = makeFetch();
    const feature = makeFeature('due-deleted', fetchImpl);
    try {
      await feature.onInitiate({ logger: fakeLogger() } as any);
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      doc.items = [];
      await fs.writeFile(file, JSON.stringify(doc), 'utf8');
      mock.timers.tick(2_000);
      // 到点重臂重读：条目已删除 → 无投递、文件保持空
      await waitFor(() => false, 8);
      assert.ok(!calls.some((call) => call.url.endsWith('/protoclaw/app_notifications')), 'deleted reminder must not fire');
      const after = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.equal(after.items.length, 0);
    } finally {
      feature.dispose();
      mock.timers.reset();
    }
  });
});

function fakeLogger() {
  return {
    info: () => {},
    warn: (..._args: unknown[]) => {},
    error: () => {},
    debug: () => {},
  };
}
