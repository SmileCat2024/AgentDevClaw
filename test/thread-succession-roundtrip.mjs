/**
 * ADR-0047 阶段 5 验收：真实宿主往返（隔离实例联测，opt-in，不进默认套件）。
 *
 * 用真实 server.js 进程 + 真实 runtime + 真实 Viewer 持久队列走线程指令恢复
 * 链路，验证两件事：
 *
 * A. 身份对齐路径（锚点先于 spawn）：runtime 停止后锚定线程，再经 commands
 *    端点的唤醒闸拉起——spawn 时 session 已是 head，注册身份与 fencing 对齐，
 *    指令 #1 应正常投递并启动轮次（消费证据落板）。
 * B. successor 探测（生产形状：READY 门要求 successor 在换头提交前拉起）：
 *    successor runtime 在换头前 spawn（此时不是 head、不在链上）→ 不携带
 *    线程身份注册；换头提交后向新 head 投递（reissue 再投）——探测 viewer
 *    侧 command identity fencing 是否拒绝无身份会话。
 *
 * 模型端点是脚本自起的黑洞 TCP（接受连接不应答）：轮次模型调用挂起，保证
 * 指令 #2「已投递、无消费引用」——unresolved 分类的确定性前提。隔离四要素
 * 见 claw-test-isolation 技能；宿主注入的 AGENTDEV_ / PROTOCLAW_ / CLAW_ 前缀
 * 环境变量先净化再显式注入。
 *
 * 运行：node test/thread-succession-roundtrip.mjs
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = 'programming-helper';
const STEP_TIMEOUT_MS = 60_000;

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => { socket.close(resolve); });
  return port;
}

async function pollUntil(label, fn, { timeoutMs = STEP_TIMEOUT_MS, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn().catch((error) => error);
    if (last === true) return;
    await sleep(intervalMs);
  }
  throw new Error(`pollUntil 超时: ${label}（最后状态: ${String(last && last.message ? last.message : last)}）`);
}

async function api(port, method, route, body) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    ...(body !== undefined
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 响应按原文保留 */ }
  return { status: response.status, ok: response.ok, json, text };
}

function killTree(pid) {
  if (process.platform === 'win32') {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* 已退出 */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'claw-adr0047-roundtrip-'));
  const workDir = path.join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const appPort = await freePort();
  const viewerPort = await freePort();
  const udsPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\claw-adr0047-${process.pid}-${viewerPort}`
    : path.join(root, 'viewer.sock');

  // 黑洞模型端点：接受连接、永不应答 → 轮次模型调用挂起。
  // 持有的连接在对端被 taskkill /F 强杀时会收到 RST（ECONNRESET）——
  // 已接受的 socket 必须挂 error 兜底，否则未捕获错误击穿脚本进程。
  const blackhole = net.createServer((socket) => {
    socket.on('error', () => { /* 对端强杀的正常余波 */ });
  });
  blackhole.on('error', () => {});
  blackhole.listen(0, '127.0.0.1');
  await once(blackhole, 'listening');
  const blackholePort = blackhole.address().port;

  // 预写模型配置（已存在则 server 不覆盖）：指向黑洞。
  await writeFile(path.join(root, 'default.json'), JSON.stringify({
    defaultModel: {
      provider: 'openai',
      baseUrl: `http://127.0.0.1:${blackholePort}/v1`,
      apiKey: 'roundtrip-test-key',
      model: 'roundtrip-test-model',
    },
    agent: { maxTurns: 20, temperature: 0 },
  }, null, 2));

  const serverEnv = (() => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/^(AGENTDEV_|PROTOCLAW_|CLAW_)/.test(key)) delete env[key];
    }
    return {
      ...env,
      AGENTDEV_DATA_DIR: root,
      PORT: String(appPort),
      AGENTDEV_VIEWER_PORT: String(viewerPort),
      AGENTDEV_UDS_PATH: udsPath,
      AGENTDEV_OPEN_BROWSER: 'false',
    };
  })();

  const startServer = async (tag) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: PROJECT_ROOT,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    child.stdout.on('data', (d) => output.push(`[out] ${d}`));
    child.stderr.on('data', (d) => output.push(`[err] ${d}`));
    // Windows taskkill /F 强杀会复位 stdio 管道，产生异步 ECONNRESET——
    // 不挂 error 兜底会把脚本自身以未捕获异常击穿（杀一代服务的收尾步骤）。
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});
    child.on('error', () => {});
    child.on('exit', (code) => output.push(`[exit ${code}]`));
    try {
      await pollUntil(`server ${tag} 就绪`, async () => {
        const probe = await api(appPort, 'GET', '/api/agents').catch(() => null);
        return probe?.ok === true;
      }, { timeoutMs: STEP_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`server ${tag} 未就绪: ${error.message}\n--- server 输出 ---\n${output.join('')}`);
    }
    return { child, output: () => output.join('') };
  };

  let server = null;
  try {
    server = await startServer('第 1 代');
    console.log(`[1] 隔离实例就绪 app=${appPort} viewer=${viewerPort} data=${root}`);

    // ── 会话 s1（创建即等待 runtime READY）──
    const s1Res = await api(appPort, 'POST', '/protoclaw/prebuilt_sessions', {
      agentId: AGENT, openDirectory: workDir, title: 'roundtrip-s1',
    });
    assert.ok(s1Res.ok, `s1 创建失败: ${s1Res.status} ${s1Res.text?.slice(0, 400)}`);
    const s1 = s1Res.json?.session?.id || s1Res.json?.id;
    assert.ok(s1, `s1 响应缺会话 id: ${s1Res.text?.slice(0, 400)}`);
    console.log(`[2] 会话 s1=${s1}（runtime READY）`);

    // ── 生产形状的身份对齐：先停 runtime，再经唤醒闸拉起 ──
    // ADR-0032：PH 会话创建即自动锚线程（目录对话集合），手动再建线程会让
    // 同一会话挂在两个线程上——spawn 身份注入取 findThreadBySession 的首个
    // 匹配（自动线程），而指令发给手动线程，fencing 将正确拒绝跨线程指令。
    // 因此这里发现 s1 的既有线程，不再手动建第二个。
    const stopRes = await api(appPort, 'POST', '/protoclaw/stop_agent', { agentId: AGENT, sessionId: s1 });
    assert.ok(stopRes.ok, `停 s1 runtime 失败: ${stopRes.status} ${stopRes.text?.slice(0, 400)}`);
    const listRes = await api(appPort, 'GET', `/protoclaw/threads?agentId=${AGENT}`);
    assert.ok(listRes.ok, `线程列表失败: ${listRes.status}`);
    const autoThread = (listRes.json?.threads || []).find((t) => t?.headSessionId === s1);
    assert.ok(autoThread, `s1 应有自动锚定线程: ${JSON.stringify((listRes.json?.threads || []).map((t) => ({ id: t.threadId, head: t.headSessionId })))}`);
    const threadId = autoThread.threadId;
    console.log(`[3] 线程 ${threadId}（自动锚定，head=${s1}，runtime 已停）`);

    // ── 指令 #1：唤醒闸拉起（spawn 时已是 head → 身份注入）+ 即时投递 ──
    const cmd1Res = await api(appPort, 'POST', `/protoclaw/threads/${threadId}/commands`, {
      text: 'roundtrip task one', kind: 'user_message',
    });
    assert.ok(cmd1Res.ok, `指令 #1 入箱失败: ${cmd1Res.status} ${cmd1Res.text?.slice(0, 400)}`);
    const cmd1 = cmd1Res.json?.command?.commandId;
    if (Number(cmd1Res.json?.delivery?.delivered) !== 1) {
      console.log(`[4!] 即时投递被拒: ${JSON.stringify(cmd1Res.json?.delivery)} —— 取证`);
      await sleep(4000); // 注册竞态假设：等待 register-agent 到达 viewer
      const retryDeliver = await api(appPort, 'POST', `/protoclaw/threads/${threadId}/deliver`);
      const threadNow = await api(appPort, 'GET', `/protoclaw/threads/${threadId}`);
      const viewerAgents = await fetch(`http://127.0.0.1:${viewerPort}/api/agents`)
        .then((r) => r.json()).catch((error) => ({ error: String(error) }));
      console.log('--- 延迟重试 deliver ---');
      console.log(JSON.stringify(retryDeliver.json, null, 1));
      console.log('--- 线程记录 commands ---');
      console.log(JSON.stringify((threadNow.json?.commands || threadNow.json?.thread?.commands || [])
        .map((c) => ({ id: c.commandId, status: c.status, lastReason: c.lastReason })), null, 1));
      console.log('--- viewer /api/agents ---');
      console.log(JSON.stringify(viewerAgents, null, 1).slice(0, 3000));
      console.log('--- server 输出尾部 ---');
      console.log(server.output().slice(-4000));
      if (Number(retryDeliver.json?.delivered) === 1) {
        console.log('\n诊断：注册竞态（延迟后投递成功）——READY 闸早于 register-agent 身份到达 viewer。');
      } else {
        console.log('\n诊断：延迟重试仍被拒——runtime 身份未注入或 fencing 条件不满足，见上方取证。');
      }
      process.exitCode = 2;
      return;
    }
    await pollUntil('指令 #1 轮次启动（turn.* 事件 + sourceRef）', async () => {
      const events = await api(appPort, 'GET', `/protoclaw/threads/${threadId}/events`);
      const list = events.json?.events || [];
      return list.some((e) => e?.sourceRef === cmd1 && String(e?.type || '').startsWith('turn'));
    }, { timeoutMs: 30_000 });
    console.log(`[4] 指令 #1=${cmd1} 已投递且轮次启动（消费证据在板）——锚点先于 spawn 的身份对齐成立`);

    // ── 指令 #2：忙时投递（排队、无轮次事件）──
    const cmd2Res = await api(appPort, 'POST', `/protoclaw/threads/${threadId}/commands`, {
      text: 'roundtrip task two', kind: 'user_message',
    });
    assert.ok(cmd2Res.ok, `指令 #2 入箱失败: ${cmd2Res.status} ${cmd2Res.text?.slice(0, 400)}`);
    const cmd2 = cmd2Res.json?.command?.commandId;
    assert.equal(cmd2Res.json?.delivery?.delivered, 1, `指令 #2 应忙时投递: ${JSON.stringify(cmd2Res.json?.delivery)}`);
    await sleep(1500);
    const eventsAfter2 = await api(appPort, 'GET', `/protoclaw/threads/${threadId}/events`);
    const touched2 = (eventsAfter2.json?.events || []).some((e) => e?.sourceRef === cmd2);
    assert.ok(!touched2, '指令 #2 不应已有轮次事件（忙时排队语义）');
    console.log(`[5] 指令 #2=${cmd2} 已投递、无消费引用（忙时排队）`);

    // ── successor s2：换头提交前拉起（READY 门前置——生产形状）──
    const s2Res = await api(appPort, 'POST', '/protoclaw/prebuilt_sessions', {
      agentId: AGENT, openDirectory: workDir, title: 'roundtrip-s2',
    });
    assert.ok(s2Res.ok, `s2 创建失败: ${s2Res.status} ${s2Res.text?.slice(0, 400)}`);
    const s2 = s2Res.json?.session?.id || s2Res.json?.id;
    assert.ok(s2, `s2 响应缺会话 id: ${s2Res.text?.slice(0, 400)}`);
    console.log(`[6] successor s2=${s2}（换头前拉起、runtime READY）`);

    // ── 手动换头：原子分类 + unresolved 持久 ──
    const advRes = await api(appPort, 'POST', `/protoclaw/threads/${threadId}/head`, {
      toSessionId: s2, fromSessionId: s1, endKind: 'manual',
    });
    assert.ok(advRes.ok, `换头失败: ${advRes.status} ${advRes.text?.slice(0, 600)}`);
    const unresolvedList = advRes.json?.unresolved || [];
    const unresolvedIds = unresolvedList.map((u) => u?.commandId);
    assert.ok(unresolvedIds.includes(cmd2), `换头 unresolved 应含指令 #2: ${JSON.stringify(unresolvedIds)}`);
    assert.ok(!unresolvedIds.includes(cmd1), `指令 #1 已消费不应进 unresolved: ${JSON.stringify(unresolvedIds)}`);
    const unresolvedEntry = unresolvedList.find((u) => u?.commandId === cmd2);
    const unresolvedId = unresolvedEntry?.unresolvedId || unresolvedEntry?.id;
    assert.ok(unresolvedId, `unresolved 条目缺 id: ${JSON.stringify(unresolvedEntry)}`);
    console.log(`[7] 换头 ${s1}→${s2}：#1 已消费、#2 转 unresolved（${unresolvedEntry?.reason || 'reason?'}）`);

    // ── 探测点：向新 head 再投递（reissue）——successor 身份是否对齐 fencing ──
    const reissueRes = await api(appPort, 'POST',
      `/protoclaw/threads/${threadId}/unresolved/${unresolvedId}/resolve`, { resolution: 'reissue' });
    assert.ok(reissueRes.ok, `reissue 失败: ${reissueRes.status} ${reissueRes.text?.slice(0, 400)}`);
    const delivery = reissueRes.json?.delivery;
    if (Number(delivery?.delivered) === 1) {
      console.log(`[8] successor 探测：reissue 新指令已投递到新 head（delivery=${JSON.stringify(delivery)}）——身份传播成立，无缺口`);
    } else {
      console.log('[8] successor 探测：投递被拒 —— GAP 证据');
      console.log(`    delivery=${JSON.stringify(delivery)}`);
      const afterCmd = await api(appPort, 'GET', `/protoclaw/threads/${threadId}`);
      const pendingStuck = (afterCmd.json?.commands || afterCmd.json?.thread?.commands || [])
        .filter((c) => c?.status === 'pending');
      console.log(`    换头后滞留 pending 指令: ${JSON.stringify(pendingStuck.map((c) => ({ id: c.commandId, text: c.text })))}`);
      console.log('\nGAP CONFIRMED：successor runtime 在换头前拉起（READY 门），spawn 时不带线程身份；'
        + '换头后向新 head 的线程指令被 viewer fencing 拒绝（runtime_not_accepting_input），滞留 pending。');
      process.exitCode = 2;
      return;
    }

    // ──（身份传播成立时的后续验收：重启持久 + 归档）──
    killTree(server.child.pid);
    await pollUntil('第 1 代服务退出', async () => {
      try { process.kill(server.child.pid, 0); return false; } catch { return true; }
    }, { timeoutMs: 20_000 });
    server = await startServer('第 2 代');
    const afterRestart = await api(appPort, 'GET', `/protoclaw/threads/${threadId}`);
    assert.ok(afterRestart.ok, `重启后线程应可读: ${afterRestart.status}`);
    assert.equal(afterRestart.json?.headSessionId || afterRestart.json?.thread?.headSessionId, s2,
      '重启后 head 应保持 s2');
    console.log('[9] 重启后持久：head 保持 s2');
    const archiveRes = await api(appPort, 'POST', `/protoclaw/threads/${threadId}/archive`);
    assert.ok(archiveRes.ok, `归档失败: ${archiveRes.status} ${archiveRes.text?.slice(0, 400)}`);
    console.log(`[10] 线程归档收尾（cleanup=${JSON.stringify(archiveRes.json?.cleanup || null)}）`);
    console.log('\nROUNDTRIP PASS：真实宿主往返全部断言通过');
  } finally {
    if (server) killTree(server.child.pid);
    await new Promise((resolve) => { blackhole.close(resolve); });
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`\nROUNDTRIP FAIL: ${error.message}`);
  process.exitCode = 1;
});
