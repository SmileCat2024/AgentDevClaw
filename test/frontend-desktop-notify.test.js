import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * desktop-notify.js 呈现级去重的沙箱测试（frontend-vm 先例同 frontend-trim-page）。
 * 只驱动 _presentAppNotification 的 generic（reminder）路径：server 对这类帧
 * 逐条投、无事件级键，SSE 重连重放同一帧必须被前端挡住（同帧只弹一次）。
 */
function createNotifySandbox() {
  const shown = [];
  class FakeNotification {
    static permission = 'granted';
    constructor(title, options) { shown.push({ title, options }); }
    close() {}
  }
  let now = 1_000_000; // 可控时钟：30s 窗口用 tick 推进，不用真实 sleep
  const ctx = createFrontendSandbox({
    Notification: FakeNotification,
    Worker: class { constructor() {} },
    Blob: class { constructor() {} },
    URL: { createObjectURL: () => 'blob:fake' },
    normalizeAgentIdentity: (id) => String(id || '').trim(),
    Date: { now: () => now },
  });
  ctx.document.hidden = false;
  ctx.document.hasFocus = () => true;
  ctx.loadSource('public/src/modules/desktop-notify.js');
  return {
    ctx,
    shown,
    tick: (ms) => { now += ms; },
    present: (frame) => ctx.run(`_presentAppNotification(${JSON.stringify(frame)})`),
  };
}

const reminderFrame = (overrides = {}) => ({
  kind: 'app-notification',
  agentId: 'memo',
  type: 'reminder',
  title: 'Memo 提醒',
  body: '喝水',
  ...overrides,
});

describe('desktop-notify generic (reminder) dedup', () => {
  it('identical reminder frames only toast once (SSE replay suppression)', () => {
    const { present, shown } = createNotifySandbox();
    present(reminderFrame());
    present(reminderFrame()); // SSE 断连重连的 Last-Event-ID 重放
    assert.equal(shown.length, 1, '同帧重放必须只弹一次');
  });

  it('different reminder content still toasts within the window', () => {
    const { present, shown } = createNotifySandbox();
    present(reminderFrame({ body: '喝水' }));
    present(reminderFrame({ body: '站起来走走' }));
    assert.equal(shown.length, 2, '同分钟两条不同内容的提醒互不吞');
  });

  it('same content toasts again after the 30s window (recurring reminders unaffected)', () => {
    const { present, shown, tick } = createNotifySandbox();
    present(reminderFrame());
    tick(30_001);
    present(reminderFrame()); // 真循环提醒：同文案、次日再发
    assert.equal(shown.length, 2, '窗口过期后同文案提醒照常弹出');
  });

  it('frames carrying requestId dedupe by requestId, not content', () => {
    const { present, shown } = createNotifySandbox();
    present(reminderFrame({ requestId: 'r1', body: '相同文案' }));
    present(reminderFrame({ requestId: 'r1', body: '相同文案' }));
    present(reminderFrame({ requestId: 'r2', body: '相同文案' }));
    assert.equal(shown.length, 2, '同 requestId 重放抑制；新 requestId 是新事实');
  });

  it('different agents dedupe independently', () => {
    const { present, shown } = createNotifySandbox();
    present(reminderFrame({ agentId: 'memo' }));
    present(reminderFrame({ agentId: 'memo-2' }));
    assert.equal(shown.length, 2, '去重按会话身份隔离，互不影响');
  });
});
