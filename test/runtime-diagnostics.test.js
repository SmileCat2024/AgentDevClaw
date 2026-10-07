import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { persistRuntimeDiagnostic } from '../server/routes/agent-startup.js';

// 桌面版无控制台，runtime 启动失败必须落盘到用户数据目录 logs/runtime.log，
// 否则「会话创建后立即消失」类故障无现场可查（2026-10 桌面包缺 dist 事故）。
describe('persistRuntimeDiagnostic', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'claw-runtime-diag-'));
    process.env.AGENTDEV_DATA_DIR = dir;
  });

  after(() => {
    delete process.env.AGENTDEV_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends failure events with details to logs/runtime.log under the resolved data root', () => {
    persistRuntimeDiagnostic({
      agentId: 'programming-helper',
      sessionId: 'sess-1',
      event: 'runtime-process-exit',
      details: 'process exited with code 1',
    });
    persistRuntimeDiagnostic({
      agentId: 'programming-helper',
      sessionId: null,
      event: 'shared-session-error',
    });

    const logPath = join(dir, 'logs', 'runtime.log');
    assert.ok(existsSync(logPath), 'diagnostic log file should be created on demand');
    const content = readFileSync(logPath, 'utf8');
    assert.match(content, /\[runtime-process-exit\] agent=programming-helper session=sess-1\nprocess exited with code 1\n/);
    assert.match(content, /\[shared-session-error\] agent=programming-helper session=none\n/);
  });

  it('never throws even when the data root is unwritable', () => {
    process.env.AGENTDEV_DATA_DIR = join(dir, 'blocked-file');
    writeFileSync(process.env.AGENTDEV_DATA_DIR, 'not a directory');
    assert.doesNotThrow(() =>
      persistRuntimeDiagnostic({ agentId: 'a', sessionId: 's', event: 'runtime-process-error', details: 'x' }));
  });
});
