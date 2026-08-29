/**
 * msg-metrics-bench.mjs — 消息轮询增量探测（probe + tail）合成压测（ADR-0012 / 工单 09）
 *
 * 用途：验收 ADR-0012 的确定性部分。在进程内启动真实 ViewerWorker（HTTP + UDS
 * 全部真实监听），本脚本同时扮演两个真实角色：
 *   - agent 进程：经 UDS 按 DebugHubIPCMessage 协议推 register-agent / push-messages
 *   - 前端轮询循环：经 HTTP 按 t08 消费逻辑探测 overview → 按分类取增量 → 拼接校验
 * 覆盖链路：UDS 行协议 → changeKind 分类 → HTTP 路由与 query 解析 → JSON 响应
 * → 前端分支与拼接。唯一未覆盖的是浏览器内 JS 本身（由 t08 前端单测覆盖）。
 *
 * 驱动序列：baseline(初始 2000 条) → tail×20(流式追加末条) → append×10(尾部新增)
 * → rewrite×1(rollback 式中段替换，count 与末条签名均不变) → unchanged×1(全等重建)。
 *
 * 计量口径（对齐 t08 前端）：
 *   - actualBytes  = 每周期 /messages 响应体字节数（HTTP 实际字节），未发请求为 0
 *   - fakeFullBytes = probe 随响应下发的假想全量字节数（服务端逐条 stringify 之和）
 *   - savedRatio   = max(0, 1 - actual/fakeFull)；未变化周期零请求（actual=0）
 *   - rewrite 周期前端走全量，响应体含 {agentId, messages} 包装字符，字节口径下
 *     actual ≥ fakeFull，故以 |ratio-1| ≤ 0.1% 且 savedRatio=0 断言"全量无节省"
 *
 * 断言（任一失败退出码非零）：
 *   - tail 期每步 actual/fakeFull < 5%；append 期 < 30%；rewrite 期 = 100%(±0.1%)
 *   - 三种 changeKind 各被触发 ≥1 次（每周期分类还须与驱动语义严格一致）
 *   - 全程 downgraded 恒 false；每周期 fakeFullBytes 与客户端独立全量计算一致
 *
 * 运行：node scripts/experiments/msg-metrics-bench.mjs
 */

import { connect as netConnect } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { ViewerWorker } from '@agentdevjs/viewer';

// ── 可调参数 ────────────────────────────────────────────────────────────────

const AGENT_ID = 'msg-metrics-bench-agent';
const MESSAGE_COUNT = 2000;      // 初始 transcript 条数（~2MB）
const TAIL_STEPS = 20;           // 流式输出期：连续末条改写
const APPEND_STEPS = 10;         // 追加期：连续尾部新增
const POLL_INTERVAL_MS = 5;      // probe 就绪轮询间隔
const POLL_TIMEOUT_MS = 5000;

// ── fixture：确定性大 transcript（全 ASCII，字符口径 = 字节口径） ────────────

function fill(len, seed) {
  const line = `ln-${String(seed).padStart(6, '0')} the quick brown fox jumps over the lazy dog 0123456789 `;
  let s = '';
  while (s.length < len) s += line;
  return s.slice(0, len);
}

/** 按 i 的模式构造一条消息：混合 user / assistant / toolCall / toolResult，
 *  每 25 条含一个 4200 字符的长 assistant 流式块，平均 ~1KB/条 → ~2MB。 */
function makeBaseMessage(i) {
  const mod = i % 25;
  if (mod === 0) {
    return { role: 'user', content: `[user #${i}] please review ` + fill(200, i) };
  }
  if (mod === 5) {
    return {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call_${i}`, name: 'shell', arguments: { command: fill(240, i) } }],
    };
  }
  if (mod === 6) {
    return { role: 'tool', name: 'shell', toolCallId: `call_${i - 1}`, content: fill(300, i) };
  }
  if (mod === 12) {
    return { role: 'assistant', content: `[stream #${i}] ` + fill(4200, i) };
  }
  return { role: 'assistant', content: `[reply #${i}] ` + fill(1000, i) };
}

function bytesOfMessages(messages) {
  // 与服务端 _totalBytes / fakeFullBytes 同口径：逐条 JSON.stringify 字符长度
  let total = 0;
  for (const m of messages) total += JSON.stringify(m).length;
  return total;
}

// ── 宿主：进程内启动真实 ViewerWorker（HTTP + UDS） ─────────────────────────

function startWorker() {
  const udsPath = `/tmp/agentdev-msg-metrics-bench-${process.pid}-${Date.now()}.sock`;
  const worker = new ViewerWorker(0, false, udsPath);
  return worker.start().then(() => {
    // port 0 → 随机端口；server 为 TS private 字段，运行时即普通属性
    const port = worker.server.address().port;
    return { worker, udsPath, port };
  });
}

/** UDS 客户端：模拟 agent 进程，按 DebugHubIPCMessage 行协议推送 */
function connectUds(udsPath) {
  return new Promise((resolve, reject) => {
    const socket = netConnect(udsPath);
    socket.setEncoding('utf8');
    socket.on('connect', () => resolve(socket));
    socket.on('error', reject);
  });
}

function udsSend(socket, msg) {
  socket.write(JSON.stringify(msg) + '\n');
}

// ── 前端轮询模拟：overview 探测 → 按分类取增量 → 拼接校验 → 计量 ─────────────

async function fetchOverview(port, agentId) {
  const res = await fetch(`http://localhost:${port}/api/agents/${agentId}/overview`);
  if (!res.ok) throw new Error(`overview HTTP ${res.status}`);
  return res.json();
}

async function fetchMessages(port, agentId, query) {
  const res = await fetch(`http://localhost:${port}/api/agents/${agentId}/messages${query}`);
  if (!res.ok) throw new Error(`messages${query || ' (full)'} HTTP ${res.status}`);
  const body = await res.arrayBuffer();
  return { bytes: body.byteLength, data: JSON.parse(new TextDecoder().decode(body)) };
}

async function waitForProbe(port, agentId, expect) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let overview = null;
  for (;;) {
    overview = await fetchOverview(port, agentId);
    const probe = overview._messagesProbe;
    const ok = probe
      && probe.count === expect.count
      && probe.changeKind === expect.changeKind
      && probe.fakeFullBytes === expect.fakeFullBytes;
    if (ok) return probe;
    if (Date.now() > deadline) {
      throw new Error(
        `probe 未就绪（期望 count=${expect.count} kind=${expect.changeKind} fake=${expect.fakeFullBytes}，`
        + `实际 ${JSON.stringify(probe)}）——推送未被 worker 按预期分类`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * 执行一个前端轮询周期（复刻 t08 poll 循环的三分支与降级校验）。
 * 返回 { known, actualBytes, requests, changeKind, branch, downgraded }。
 */
async function pollCycle(port, agentId, known, probe) {
  let actualBytes = 0;
  let requests = 0;
  let downgraded = false;
  let messages;
  const branch = probe === null ? 'no-probe'
    : probe.changeKind === null ? 'none'
    : probe.count < known.length || (probe.count > 0 && known.length === 0) ? 'full'
    : probe.changeKind;

  if (branch === 'full' || branch === 'no-probe' || branch === 'rewrite') {
    // 首次加载 / probe 缺省 / count 回退 / rewrite → 全量拉
    if (branch === 'full' && probe.count < known.length) downgraded = true;
    const r = await fetchMessages(port, agentId, '');
    actualBytes += r.bytes;
    requests += 1;
    messages = r.data.messages || [];
  } else if (branch === 'none') {
    messages = known; // 未变化：零请求
  } else if (branch === 'append') {
    const since = known.length;
    const r = await fetchMessages(port, agentId, `?since=${since}`);
    const delta = Array.isArray(r.data.messages) ? r.data.messages : [];
    if (delta.length === probe.count - since) {
      messages = [...known.slice(0, since), ...delta];
    } else {
      downgraded = true; // 校验失败 → 降级全量重建基线
      const full = await fetchMessages(port, agentId, '');
      actualBytes += full.bytes;
      requests += 1;
      messages = full.data.messages || [];
    }
    actualBytes += r.bytes;
    requests += 1;
  } else if (branch === 'tail') {
    const r = await fetchMessages(port, agentId, '?tail=1');
    const tail = Array.isArray(r.data.messages) ? r.data.messages : [];
    if (tail.length === 1 && probe.count === known.length && known.length > 0) {
      messages = [...known.slice(0, -1), tail[0]];
    } else {
      downgraded = true;
      const full = await fetchMessages(port, agentId, '');
      actualBytes += full.bytes;
      requests += 1;
      messages = full.data.messages || [];
    }
    actualBytes += r.bytes;
    requests += 1;
  } else {
    throw new Error(`未知 branch: ${branch}`);
  }
  return { known: messages, actualBytes, requests, changeKind: probe ? probe.changeKind : null, branch, downgraded };
}

// ── 驱动与断言 ───────────────────────────────────────────────────────────────

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const pct = (x) => `${(x * 100).toFixed(2)}%`;

async function main() {
  const failures = [];
  const expectCond = (cond, msg) => { if (!cond) failures.push(msg); };

  const base = Array.from({ length: MESSAGE_COUNT }, (_, i) => makeBaseMessage(i));
  let known = [];
  let cur = base;
  console.log(
    `fixture: ${cur.length} 条消息，transcript ${fmt(bytesOfMessages(cur))} 字符`
    + `（含长 assistant 流式块 ${cur.filter((m) => m.content.length > 4000).length} 条）\n`,
  );

  const rows = [];
  const kindCounts = { append: 0, tail: 0, rewrite: 0 };
  let downgradedSeen = false;

  /** 推送一步 → 等 probe → 跑前端周期 → 记录 */
  async function drive(phase, step, messages, expectKind) {
    udsSend(udsSocket, { type: 'push-messages', agentId: AGENT_ID, messages });
    const probe = await waitForProbe(port, AGENT_ID, {
      count: messages.length,
      changeKind: expectKind,
      fakeFullBytes: bytesOfMessages(messages),
    });
    const cycle = await pollCycle(port, AGENT_ID, known, probe);
    known = cycle.known;

    expectCond(probe.changeKind === expectKind,
      `[${phase} #${step}] probe.changeKind=${probe.changeKind}，期望 ${expectKind}`);
    expectCond(probe.fakeFullBytes === bytesOfMessages(messages),
      `[${phase} #${step}] fakeFullBytes=${probe.fakeFullBytes}，与独立全量计算 ${bytesOfMessages(messages)} 不一致`);
    expectCond(known.length === probe.count,
      `[${phase} #${step}] 拼接后 ${known.length} 条 ≠ probe.count=${probe.count}`);
    expectCond(!cycle.downgraded, `[${phase} #${step}] downgraded=true（分类/校验失败触发降级）`);
    if (cycle.downgraded) downgradedSeen = true;
    if (kindCounts[cycle.changeKind] !== undefined) kindCounts[cycle.changeKind] += 1;

    const ratio = cycle.actualBytes > 0 ? cycle.actualBytes / probe.fakeFullBytes : 0;
    const saved = probe.fakeFullBytes > 0 ? Math.max(0, 1 - ratio) : null;
    rows.push({
      phase, step,
      changeKind: cycle.changeKind,
      branch: cycle.branch,
      actualBytes: cycle.actualBytes,
      fakeFullBytes: probe.fakeFullBytes,
      ratio, saved,
      downgraded: cycle.downgraded,
      requests: cycle.requests,
    });
    return { probe, cycle };
  }

  /** 阶段终局：客户端拼接数组与服务端推送数组逐字节一致 */
  function assertPhaseConsistency(phase, messages) {
    expectCond(JSON.stringify(known) === JSON.stringify(messages),
      `[${phase}] 阶段终局一致性失败：客户端拼接数组与服务端 transcript 不一致`);
  }

  const { worker, udsPath, port } = await startWorker();
  let udsSocket;
  try {
    udsSocket = await connectUds(udsPath);
    udsSend(udsSocket, { type: 'register-agent', agentId: AGENT_ID, name: 'Msg Metrics Bench' });

    // ── baseline：初始 2000 条（前端首轮：probe 可用但拼接基线缺失 → 全量） ──
    await drive('baseline', 1, cur, 'append');
    expectCond(rows[0].branch === 'full', `[baseline] 首轮应走全量分支，实际 ${rows[0].branch}`);
    assertPhaseConsistency('baseline', cur);

    // ── 流式输出期：tail×20（末条流式追加，长度严格递增） ──────────────────
    for (let i = 1; i <= TAIL_STEPS; i++) {
      const last = cur[cur.length - 1];
      const streamed = { ...last, content: last.content + ` +chunk-${i}-` + fill(100 + i, 7000 + i) };
      cur = [...cur.slice(0, -1), streamed];
      await drive('tail', i, cur, 'tail');
    }
    assertPhaseConsistency('tail', cur);

    // ── 追加期：append×10（尾部新增 ~1KB 消息） ────────────────────────────
    for (let i = 1; i <= APPEND_STEPS; i++) {
      cur = [...cur, { role: 'user', content: `[append #${i}] follow-up ` + fill(950, 9000 + i) }];
      await drive('append', i, cur, 'append');
    }
    assertPhaseConsistency('append', cur);

    // ── rewrite×1：rollback 式中段替换（count 与末条签名均不变——分类盲区修正） ──
    {
      const idx = Math.floor(cur.length / 2);
      cur = [...cur];
      cur[idx] = { ...cur[idx], content: '[rollback-replaced] ' + fill(1200, 999999) };
      await drive('rewrite', 1, cur, 'rewrite');
      expectCond(rows[rows.length - 1].branch === 'rewrite',
        `[rewrite] 应走全量分支，实际 ${rows[rows.length - 1].branch}`);
      assertPhaseConsistency('rewrite', cur);
    }

    // ── unchanged×1：全等重建推送 → changeKind=null → 零请求（actual=0） ────
    {
      const before = rows.length;
      await drive('unchanged', 1, cur.map((m) => ({ ...m })), null);
      const row = rows[rows.length - 1];
      expectCond(row.changeKind === null && row.requests === 0 && row.actualBytes === 0,
        `[unchanged] 未变化周期应零请求（actual=0），实际 requests=${row.requests} actual=${row.actualBytes}`);
      expectCond(rows.length === before + 1, '[unchanged] 周期未记录');
    }
  } finally {
    try { if (udsSocket) udsSocket.end(); } catch {}
    await worker.stop().catch(() => {});
    if (existsSync(udsPath)) { try { unlinkSync(udsPath); } catch {} }
  }

  // ── 汇总表 ────────────────────────────────────────────────────────────────
  console.log(
    'phase     | step | changeKind | branch   | actualBytes | fakeFullBytes | ratio    | saved    | downgraded | reqs',
  );
  console.log('-'.repeat(116));
  for (const r of rows) {
    console.log(
      `${r.phase.padEnd(9)} | ${String(r.step).padStart(4)} | ${String(r.changeKind ?? 'null').padEnd(10)} `
      + `| ${r.branch.padEnd(8)} | ${fmt(r.actualBytes).padStart(11)} | ${fmt(r.fakeFullBytes).padStart(13)} `
      + `| ${pct(r.ratio).padStart(8)} | ${(r.saved === null ? 'n/a' : pct(r.saved)).padStart(8)} `
      + `| ${String(r.downgraded).padEnd(10)} | ${r.requests}`,
    );
  }

  console.log('\n阶段聚合：');
  const phases = ['baseline', 'tail', 'append', 'rewrite', 'unchanged'];
  for (const phase of phases) {
    const group = rows.filter((r) => r.phase === phase);
    const actual = group.reduce((s, r) => s + r.actualBytes, 0);
    const fakeFull = group.reduce((s, r) => s + r.fakeFullBytes, 0);
    const saved = fakeFull > 0 ? Math.max(0, 1 - actual / fakeFull) : null;
    console.log(
      `${phase.padEnd(9)} ×${String(group.length).padStart(2)}  actual=${fmt(actual).padStart(12)}  `
      + `fakeFull=${fmt(fakeFull).padStart(12)}  ratio=${pct(fakeFull > 0 ? actual / fakeFull : 0).padStart(8)}  `
      + `saved=${saved === null ? 'n/a' : pct(saved)}`,
    );
  }

  // ── 断言判定（工单 09 验收口径） ──────────────────────────────────────────
  const tailRows = rows.filter((r) => r.phase === 'tail');
  const appendRows = rows.filter((r) => r.phase === 'append');
  const rewriteRows = rows.filter((r) => r.phase === 'rewrite');

  for (const r of tailRows) {
    expectCond(r.ratio < 0.05, `[断言] tail #${r.step} ratio ${pct(r.ratio)} ≥ 5%（actual=${r.actualBytes} fakeFull=${r.fakeFullBytes}）`);
  }
  for (const r of appendRows) {
    expectCond(r.ratio < 0.30, `[断言] append #${r.step} ratio ${pct(r.ratio)} ≥ 30%（actual=${r.actualBytes} fakeFull=${r.fakeFullBytes}）`);
  }
  for (const r of rewriteRows) {
    // 全量响应体含 {agentId, messages} 包装与数组逗号（O(n) 开销），字节口径下
    // actual 略大于 fakeFull；"=100%"的语义是走全量分支、零增量节省（savedRatio 夹 0）
    expectCond(r.saved === 0 && r.actualBytes >= r.fakeFullBytes && r.ratio - 1 <= 0.005,
      `[断言] rewrite #${r.step} ratio ${pct(r.ratio)} ≠ 100%（±0.5%）或 savedRatio=${r.saved} ≠ 0`);
  }
  expectCond(kindCounts.tail >= 1, `[断言] changeKind=tail 未被触发`);
  expectCond(kindCounts.append >= 1, `[断言] changeKind=append 未被触发`);
  expectCond(kindCounts.rewrite >= 1, `[断言] changeKind=rewrite 未被触发`);
  expectCond(!downgradedSeen, `[断言] 全程出现 downgraded=true`);
  expectCond(rows.every((r) => r.fakeFullBytes > 0), `[断言] 存在 fakeFullBytes=0 的周期`);

  console.log(
    `\nchangeKind 观察计数：append=${kindCounts.append} tail=${kindCounts.tail} rewrite=${kindCounts.rewrite}；`
    + `downgraded 全程 ${downgradedSeen ? 'true（异常）' : 'false'}`,
  );

  if (failures.length > 0) {
    console.error(`\nFAIL：${failures.length} 项断言未通过`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`\nPASS：全部断言通过（${rows.length} 个轮询周期）`);
  }
}

main().catch((err) => {
  console.error('bench 异常终止：', err);
  process.exit(1);
});
