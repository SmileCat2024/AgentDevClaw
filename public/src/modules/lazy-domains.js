/**
 * lazy-domains.js — 悬置域 classic 脚本的按需装载。
 *
 * 背景：work-group / IM（qqbot）/ flow 三个界面的脚本仍是 classic（ADR-0051 封存项），
 * 原先由 index.html 静态标签装载，于是每个用户打开工作台都要为它们付下载与解析成本，
 * 而首屏根本不显示这些界面。这里改成「第一次要渲染该界面时才注入」。首屏加载专项的
 * 一部分：不做迁移，只改装载时点。
 *
 * 为什么是脚本注入而不是 import：这些文件是 classic（`window.WorkGroupUI` 之类顶格
 * 全局导出），不在 ESM 图里。`script.async = false` 保证 script-inserted 脚本按插入
 * 顺序执行，这是 wg-* 的内部依赖顺序（wg-core 必须最后）成立的前提。
 *
 * 触发面：调用方在渲染前 `ensure(domain)`，未就绪时先渲染占位；装载完成后由调用方
 * 重渲染。`schedulePrefetch()` 在首屏渲染后空闲时预取全部域，让「进入界面」通常不再
 * 等待——首屏不受影响是这条设计的全部意义。
 */

const MODULE_BASE = new URL('./', import.meta.url);
const FLOW_EDITOR_URL = new URL('../../flow-editor.js', import.meta.url).href;

const DOMAINS = {
  'work-group': {
    // 顺序即语义：wg-state 提供共享状态，wg-core 最后（其头注要求在所有子文件之后）。
    // resources-viewer 依赖 WorkGroupUI，随本域一起装载。
    scripts: [
      'wg-state.js',
      'wg-voice-input.js',
      'wg-annotations.js',
      'wg-context-menu.js',
      'wg-settings-panel.js',
      'wg-threads-panel.js',
      'wg-popover.js',
      'wg-core.js',
      'resources-viewer.js',
    ],
    ready: () => Boolean(window.WorkGroupUI && typeof window.WorkGroupUI.render === 'function'),
  },
  im: {
    // dispatch-* 被 im-ui 消费（调度概览），与 IM 界面同批。
    scripts: ['dispatch-ui.js', 'dispatch-actions.js', 'im-ui.js', 'im-actions.js'],
    ready: () => typeof window.isIMWorkspaceConfigEditor === 'function',
  },
  flow: {
    scripts: [FLOW_EDITOR_URL],
    ready: () => Boolean(window.ClawFlowEditor),
  },
};

/** agentId → 懒装载域。home 的 dashboard、其它工作空间仍在首屏图里，不在此列。 */
const AGENT_DOMAIN = {
  'work-group': 'work-group',
  qqbot: 'im',
};

/**
 * 首屏后预取的域：只列「当前 UI 里可达」的。work-group 与 flow-workspace 在
 * HIDDEN_PREBUILT_AGENT_IDS 里（隐藏、按 ID 可寻址），界面打不开时预取纯属浪费；
 * flow-editor 的消费面是 Feature 配置的编排 tab，同样不是首屏后的必经路径。
 * 它们保留在按需路径里，将来启用时首次进入会即时装载。
 */
const PREFETCH_DOMAINS = ['im'];

/** 已发起的装载（按域去重）；失败后清空以便下次重试。 */
const inFlight = new Map();

function scriptUrl(script) {
  if (!script) return null;
  return script.startsWith('http') || script.startsWith('/') ? script : new URL(script, MODULE_BASE).href;
}

function injectScript(url) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = url;
    el.async = false; // script-inserted 脚本按插入顺序执行
    el.onload = () => resolve(true);
    el.onerror = () => reject(new Error(`[lazy-domains] 脚本装载失败：${url}`));
    document.head.append(el);
  });
}

export function domainForAgent(agentId) {
  const id = String(agentId || '').trim();
  return AGENT_DOMAIN[id] || null;
}

export function isLoaded(domain) {
  const spec = DOMAINS[domain];
  return spec ? spec.ready() : true;
}

/**
 * 确保某域脚本已装载。
 * @param {string} domain
 * @returns {Promise<boolean>} true=就绪（本次装载或原本就绪），false=域不存在或失败
 */
export function ensure(domain) {
  const spec = DOMAINS[domain];
  if (!spec) return Promise.resolve(false);
  if (spec.ready()) return Promise.resolve(true);
  if (inFlight.has(domain)) return inFlight.get(domain);

  // 串行注入：同一域内的脚本有顺序依赖，并行插入会打乱执行序。
  // 逐个注入而不按 ready() 短路——域内靠后的脚本可能不改变 ready 谓词的判定
  // （例如 im-actions / resources-viewer），短路会让它们整批漏装。
  const task = spec.scripts
    .map(scriptUrl)
    .reduce((chain, url) => chain.then(() => injectScript(url)), Promise.resolve(true))
    .then(() => spec.ready())
    .catch((error) => {
      console.warn(error?.message || error);
      inFlight.delete(domain);
      return false;
    })
    .finally(() => {
      if (spec.ready()) inFlight.delete(domain);
    });
  inFlight.set(domain, task);
  return task;
}

/**
 * 首屏渲染后的空闲预取：让「进入 work-group / IM / 编排」通常不再等脚本。
 * 首屏不受影响是前提——因此走 requestIdleCallback（无该 API 时退化为定时器）。
 */
export function schedulePrefetch({ delayMs = 2000, timeoutMs = 6000, fallbackDelayMs = 800 } = {}) {
  const run = () => {
    for (const domain of PREFETCH_DOMAINS) {
      if (!isLoaded(domain)) ensure(domain);
    }
  };
  // 先让首屏自己的数据请求走完：预取挤在同一窗口会和它们抢连接（首屏时间才是本专项
  // 的目标）。用户在这之前进入对应界面时，ensure 由按需路径触发，不会漏。
  window.setTimeout(() => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: timeoutMs });
    } else {
      window.setTimeout(run, fallbackDelayMs);
    }
  }, delayMs);
}

/** 测试用：清空装载记录（不改已注入的脚本）。 */
export function __resetForTest() {
  inFlight.clear();
}

export const __domains = DOMAINS;
