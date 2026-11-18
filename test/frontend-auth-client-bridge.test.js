/**
 * auth-client 的桥面契约（P4 收尾：classic → ESM）。
 *
 * 本批把认证客户端迁成 ESM 后，对外只剩 domain `auth-client` 的 3 个桥键：
 *   __clawAuthReady / closeAuthSettings / openAuthSettings
 * 消费面分别是 app-main 的 boot 闸（求值期）、sse-client 的自举判定（求值期）、
 * app-ui 的设置 flyout（运行时）。三条都经 window 面，没有具名 import 的消费者，
 * 因此桥键缺失只会表现成「静默少功能」——本文件把这一面钉成断言。
 *
 * 装载路线：真实 import（模块裸引用面 ⊆ window/document 桩面）+ kernel-state 的
 * classic 桥存储。装 auth-client 需要先备好两个装载期依赖：桥存储（defineKey）与
 * action 分发器（authClient.* 动作注册）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserStubs, loadModuleOnce } from './helpers/esm-module-loader.js';

/** 动作分发器的桩（auth-client 在求值期 registerMany 三个 authClient.* 动作）。 */
function createActionsStub() {
  const registered = new Map();
  return {
    registered,
    register(name, fn) { registered.set(name, fn); },
    registerMany(map) { for (const [name, fn] of Object.entries(map)) registered.set(name, fn); },
    unregisterOwner() { return 0; },
  };
}

test('迁 ESM 后：3 个桥键就位、claim 双向转发、原 window.ClawAuth 不留痕', async () => {
  const actions = createActionsStub();
  const cleanup = installBrowserStubs({
    window: {
      // 认证状态查询的响应：未启用访问保护（真实路由形态）
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ enabled: false, configured: false, authenticated: true }),
        text: async () => '{}',
      }),
      ClawFW: { actions },
      KernelState: undefined, // 由 kernel-state.js 装载后挂上
    },
  });
  try {
    await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
    const { module } = await loadModuleOnce('public/src/modules/auth-client.js', { installGlobals: false });

    // 认证闸：命名导出与桥键是同一份 promise（不另存副本）
    assert.equal(typeof module.authReady?.then, 'function');
    assert.equal(window.__clawAuthReady, module.authReady,
      '桥键 __clawAuthReady 必须直接发布 authReady（app-main 的 boot 闸）');

    // 两个设置面函数（消费方是 app-ui 的 click 回调）
    assert.equal(window.closeAuthSettings, module.closeAuthSettings);
    assert.equal(window.openAuthSettings, module.openAuthSettings);

    // claim 之后 classic 写方经 setter 转发：写入后读回同一实现
    const replacement = () => 'replaced';
    window.closeAuthSettings = replacement;
    assert.equal(window.closeAuthSettings, replacement, '认领后 window 写必须转发进模块状态');

    // 动作注册走真实分发器（模板里的 data-action="authClient.*"）
    assert.deepEqual(
      [...actions.registered.keys()].sort(),
      ['authClient.close', 'authClient.logout', 'authClient.save'],
    );
    // 原 window.ClawAuth 零外部消费方，随迁移收敛为模块私有，不得留同名全局
    assert.equal('ClawAuth' in window, false, '零消费方的 window.ClawAuth 必须消失（模块私有）');
  } finally {
    cleanup();
  }
});
