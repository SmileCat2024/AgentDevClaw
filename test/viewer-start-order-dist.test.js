/**
 * ViewerWorker dist 集成回归测试（sock 抢占事故，Claw 安装形态）
 *
 * 与框架仓库 start-order-sock-preservation.test.ts 同源契约，但这里跑的是
 * Claw 实际消费的 @agentdevjs/viewer 产物（开发态 junction 指向框架 dist），
 * 验证"端口被占的第二个实例不得破坏既有 sock"在真实安装形态下成立。
 *
 * 发布态（registry 实体目录）安装的旧版本不含该修复，跑必红——发布新框架
 * 包之前自动跳过；框架修复发版并 agentdev:published 后此 skip 分支自然失效。
 * 恢复方法：框架发版后删除下方形态判断，让测试无条件执行。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 探测安装的 dist 是否含启动顺序修复（新代码特征：UDS 启动被 await 且发生在
// HTTP listen 成功之后）。发布态旧版本不含该特征时跳过，框架发版后自动生效；
// 届时可移除探测，让测试无条件执行。
function distHasStartOrderFix() {
  const entryPath = fileURLToPath(import.meta.resolve('@agentdevjs/viewer'));
  const distDir = dirname(entryPath);
  return readdirSync(distDir)
    .filter((f) => f.endsWith('.js'))
    .some((f) => readFileSync(join(distDir, f), 'utf8').includes('await this.startUDSServer()'));
}

function getTestUdsPath() {
  return `/tmp/agentdev-viewer-dist-test-${process.pid}-${Date.now()}.sock`;
}

function getTestPort() {
  return 20000 + Math.floor(Math.random() * 1000);
}

/** 尝试连接 UDS 路径，返回是否成功（超时视为失败） */
function canConnect(udsPath, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = connect(udsPath);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

describe('ViewerWorker dist integration (sock path preservation)', () => {
  let ViewerWorker;
  let hasFix;
  const workers = [];

  before(async () => {
    hasFix = distHasStartOrderFix();
    const mod = await import('@agentdevjs/viewer');
    ViewerWorker = mod.ViewerWorker;
  });

  after(async () => {
    for (const w of workers) {
      await w.stop().catch(() => {});
    }
  });

  it('second instance with taken port must not disturb the existing UDS sock', async (t) => {
    if (!hasFix) {
      t.skip('installed @agentdevjs/viewer dist predates the start-order fix; update the framework package to enable');
      return;
    }
    const udsPath = getTestUdsPath();
    const port = getTestPort();

    const primary = new ViewerWorker(port, false, udsPath);
    workers.push(primary);
    await primary.start();
    assert.ok(existsSync(udsPath), 'primary instance must create the sock file');
    assert.equal(await canConnect(udsPath), true, 'primary UDS listener must be reachable');

    const second = new ViewerWorker(port, false, udsPath);
    workers.push(second);
    await assert.rejects(() => second.start(), /端口|EADDRINUSE/);

    assert.ok(existsSync(udsPath), 'sock file must survive the failed second start');
    assert.equal(await canConnect(udsPath), true, 'primary listener must remain reachable');
  });
});
