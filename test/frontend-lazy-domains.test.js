import assert from 'node:assert/strict';
import test from 'node:test';

// lazy-domains 是浏览器 ESM：它只经 window / document 两个全局取环境。
// 这里给出最小桩面，注入的脚本在 append 时同步触发 onload（等同下载完成）。
function installBrowserStubs({ failOn = [] } = {}) {
  const injected = [];
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const windowStub = {
    setTimeout: (fn) => fn(),
    requestIdleCallback: undefined,
  };
  globalThis.window = windowStub;
  globalThis.document = {
    head: {
      append(el) {
        injected.push(el.src);
        if (failOn.some((fragment) => el.src.includes(fragment))) {
          el.onerror?.();
          return;
        }
        // 模拟脚本执行：各文件末尾的顶格全局
        if (el.src.endsWith('wg-core.js')) {
          windowStub.WorkGroupUI = { render: () => '' };
        }
        if (el.src.endsWith('im-ui.js')) {
          windowStub.isIMWorkspaceConfigEditor = () => false;
        }
        if (el.src.endsWith('flow-editor.js')) {
          windowStub.ClawFlowEditor = { renderBlock: () => '' };
        }
        el.onload?.();
      },
    },
    createElement() {
      return { tagName: 'script', src: '', async: true, onload: null, onerror: null };
    },
  };
  return {
    injected,
    windowStub,
    restore() {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
    },
  };
}

test('domainForAgent 只映射当前可达的三个界面，其余返回 null', async () => {
  const { domainForAgent } = await import('../public/src/modules/lazy-domains.js');
  assert.equal(domainForAgent('work-group'), 'work-group');
  assert.equal(domainForAgent('qqbot'), 'im');
  assert.equal(domainForAgent('programming-helper'), null);
  assert.equal(domainForAgent('home'), null);
  assert.equal(domainForAgent(''), null);
});

test('ensure 串行装载域内全部脚本，且不因 ready 提前成立而漏装靠后脚本', async () => {
  const stubs = installBrowserStubs();
  try {
    const mod = await import('../public/src/modules/lazy-domains.js?case=serial');
    const ok = await mod.ensure('im');
    assert.equal(ok, true);
    const names = stubs.injected.map((src) => src.split('/').pop());
    // im-ui 是 ready 谓词的来源；im-actions 在它之后，必须一并装载
    assert.deepEqual(names, ['dispatch-ui.js', 'dispatch-actions.js', 'im-ui.js', 'im-actions.js']);
  } finally {
    stubs.restore();
  }
});

test('ensure 幂等：并发与重复调用只注入一轮；已就绪时不再注入', async () => {
  const stubs = installBrowserStubs();
  try {
    const mod = await import('../public/src/modules/lazy-domains.js?case=idempotent');
    await Promise.all([mod.ensure('work-group'), mod.ensure('work-group')]);
    const firstRound = stubs.injected.length;
    assert.equal(firstRound, mod.__domains['work-group'].scripts.length);
    assert.equal(mod.isLoaded('work-group'), true);
    await mod.ensure('work-group');
    assert.equal(stubs.injected.length, firstRound, '已就绪后不应重复注入');
  } finally {
    stubs.restore();
  }
});

test('装载失败返回 false，且允许下次重试', async () => {
  const stubs = installBrowserStubs({ failOn: ['dispatch-actions.js'] });
  try {
    const mod = await import('../public/src/modules/lazy-domains.js?case=failure');
    assert.equal(await mod.ensure('im'), false);
    assert.equal(mod.isLoaded('im'), false);
    // 失败清空进行中记录：换掉桩后重试应真的再注入
    stubs.injected.length = 0;
    globalThis.document.head.append = (el) => {
      stubs.injected.push(el.src);
      if (el.src.endsWith('im-ui.js')) globalThis.window.isIMWorkspaceConfigEditor = () => false;
      el.onload?.();
    };
    assert.equal(await mod.ensure('im'), true);
    assert.ok(stubs.injected.length > 0);
  } finally {
    stubs.restore();
  }
});

test('未知域返回 false，不抛错', async () => {
  const { ensure } = await import('../public/src/modules/lazy-domains.js?case=unknown');
  assert.equal(await ensure('nope'), false);
});
