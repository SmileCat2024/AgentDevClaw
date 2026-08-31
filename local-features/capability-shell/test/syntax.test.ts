/**
 * 第一道检查点测试 — 语法验收（ticket 033）
 *
 * bash -n 依赖真实 bash（真实子进程，放宽到 2s 预算）；
 * 降级模式（bashPath=null）为纯函数路径。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSyntax, findBashPath } from '../src/syntax.js';

describe('capability-shell checkSyntax', () => {
  it('bash 可得：合法命令放行', async () => {
    const bash = await findBashPath();
    if (!bash) return; // 无 bash 环境跳过（CI 容器一般有）
    const r = await checkSyntax('echo hi | wc -c', { bashPath: bash });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, false);
  });

  it('bash 可得：语法错误拒绝且 stderr 有诊断', async () => {
    const bashPath = await findBashPath();
    if (!bashPath) return;
    const r = await checkSyntax('if { echo x', { bashPath });
    assert.equal(r.ok, false);
    assert.ok((r.stderr ?? '').length > 0);
  });

  it('bash 缺失：降级放行（degraded: true），后续道兜底', async () => {
    const r = await checkSyntax('anything $(here)', { bashPath: null });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
  });

  it('bash 路径不存在：spawn error 降级放行', async () => {
    const r = await checkSyntax('echo ok', {
      bashPath: '/nonexistent/bash-xyz',
      timeoutMs: 2000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
  });
});

describe('capability-shell findBashPath', () => {
  it('Linux/macOS 返回 $SHELL 或 /bin/bash', async () => {
    if (process.platform === 'win32') return;
    const p = await findBashPath();
    assert.ok(typeof p === 'string' && p.length > 0);
  });
});
