import { Marked, Renderer } from 'marked';
import { installBrowserStubs, loadModuleOnce } from './esm-module-loader.js';

export async function loadMarkdownModule({ window = {}, document = {} } = {}) {
  const marked = new Marked();
  marked.Renderer = Renderer;
  const registeredActions = {};
  const loadListeners = [];
  const cleanupStubs = installBrowserStubs({
    window: {
      marked,
      hljs: { getLanguage: () => null, highlight: (code) => ({ value: code }) },
      ClawFW: { actions: { registerMany(actions) { Object.assign(registeredActions, actions); } } },
      addEventListener(type, listener) {
        if (type === 'load') loadListeners.push(listener);
      },
      ...window,
    },
    document,
  });
  try {
    const kernel = await loadModuleOnce('public/src/modules/kernel-state.js', { installGlobals: false });
    globalThis.window.KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');
    // escapeHtml 与 marked renderer 的实现在 markdown-utils 自身（原 markdown-bootstrap
    // classic 相的实现已并入），装载该模块即完成两把桥键注册，无需再跑 classic 源。
    const loaded = await loadModuleOnce('public/src/modules/markdown-utils.js', { installGlobals: false });
    return {
      ...loaded,
      registeredActions,
      dispatchLoad() { for (const listener of loadListeners) listener(); },
      cleanup() {
        loaded.cleanup();
        kernel.cleanup();
        cleanupStubs();
      },
    };
  } catch (error) {
    cleanupStubs();
    throw error;
  }
}
