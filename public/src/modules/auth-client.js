/**
 * auth-client.js — 单密码访问保护客户端（P4 收尾：classic → ESM）。
 *
 * 三项职责：
 *   1. 认证闸：读 /protoclaw/auth/status，经 `authReady`（桥键
 *      `window.__clawAuthReady`）放行编排域启动与 SSE 建连；
 *   2. `window.fetch` 的 401 拦截：认证路径与远程命名空间以外的 401 触发登录浮层；
 *   3. 设置面（openAuthSettings / closeAuthSettings）与 `authClient.*` 动作。
 *
 * ## 装载相位（本文件最关键的一条约束）
 *
 * 原先是 index.html 的 classic 标签（head 第 95 行，早于 app-core），顶层语句在
 * 解析相执行。迁 ESM 后改为**同一位置的 `<script type="module">` 独立入口**，
 * 两条顺序约束因此由标签序表达（挪动即改时序，plan R4）：
 *   - 必须早于 `app-main` 入口：编排域的 boot 主链在求值期读本文件发布的认证闸；
 *   - 必须早于 `kernel-entry`（其图里的 transport 在求值期把当时的 `window.fetch`
 *     捕获为 `nativeFetch`）：本文件的 401 拦截原来是它的**内层**。反过来则拦截
 *     变外层——两者对 401 的判定都读入参 URL，可观察行为等价，但那是无理由地
 *     改动既有的补丁叠放序（D4：搬代码不改行为）。
 *
 * 为什么不做成让 app-main `import { authReady }`：本文件求值期要求 action 分发器
 * 与桥存储就位（401 拦截与 `authClient.*` 注册都是装载期副作用）。静态边会把这个
 * 副作用随编排域铺进**每一张触达 app-main 的图**（实测：80 个夹具文件因此被迫为
 * auth/status 建模，其中 20+ 个的请求序列断言与超时挂起被牵连）。窄口桥键
 * （`defineKey`）保持原 classic 相的可达面，语义与装载成本都不变。
 *
 * ## 时序审计（R1–R4 + S，2026-11-18）
 *
 *   - R1：没有任何 classic 文件在顶层读写本文件的键（`grep -rnw` 全量核过；
 *     `window.closeAuthSettings` / `window.openAuthSettings` 的消费方是 app-ui 的
 *     click 回调，运行时触达）。
 *   - R2：boot 窗口——app-main 的 `await window.__clawAuthReady` 读的是本文件在
 *     模块相发布的桥键；由「本入口早于 app-main 入口」保证（与 ^ 同一条约束，
 *     index.html 注释与 test/frontend-boot-chain.test.js 双向钉住）。
 *   - R3：无加载期 DOM 查询——登录浮层在 showLogin() 里按需创建。
 *   - R4：顶层语句从解析相移到模块相。（a）`initialize()` 仍等 DOMContentLoaded：
 *     模块相 readyState 已是 'interactive'，判据改为「已 complete 才立刻执行」，
 *     生产路径与原 `readyState === 'loading'` 分支等价。（b）fetch 补丁与动作注册
 *     的时点整体后移到模块相——classic 侧解析期没有任何 fetch 调用（消费方都在
 *     DOMContentLoaded 之后或事件回调里），认证状态的读取时点不变，故
 *     `auth/status` 仍早于 `/api/agents`（生产浏览器回归钉住该顺序）。
 *   - S：原文件是 sloppy（无 'use strict'），全文无隐式全局赋值、无 with、无顶层
 *     `this` 引用，strict 化无行为差异。
 */

const nativeFetch = window.fetch.bind(window);
let authState = { enabled: false, configured: false, authenticated: true };
let overlay = null;
let resolveReady;
let rejectReady;
/** 认证闸：initialize() / 登录成功后兑现，失败时 reject。 */
export const authReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

function appUrl(pathname) {
  return typeof window.__PROTOCLAW_APP_URL__ === 'function'
    ? window.__PROTOCLAW_APP_URL__(pathname)
    : pathname;
}

function isAuthPath(input) {
  const raw = typeof input === 'string' ? input : input?.url || '';
  try {
    return new URL(raw, window.location.href).pathname.startsWith('/protoclaw/auth/');
  } catch {
    return false;
  }
}

// 远程命名空间请求（/api/agents/remote:<connId>:… /…）的 401 来自远程实例
// 的访问保护，与本机会话无关：输入本机密码解决不了，弹登录框只会误导。
// 这类失败由调用方按业务错误呈现（如消息发送失败的 toast）。
function isRemoteNamespaceRequest(input) {
  const raw = typeof input === 'string' ? input : input?.url || '';
  try {
    const { pathname } = new URL(raw, window.location.href);
    if (!pathname.startsWith('/api/agents/')) return false;
    return decodeURIComponent(pathname.split('/')[3] || '').startsWith('remote:');
  } catch {
    return false;
  }
}

function text(zh, en) {
  return (localStorage.getItem('agentdev-language') || 'zh') === 'zh' ? zh : en;
}

function removeOverlay() {
  overlay?.remove();
  overlay = null;
}

function showLogin(error = '') {
  if (!authState.enabled || authState.authenticated) return;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'claw-auth-overlay';
    overlay.innerHTML = `
        <div class="claw-auth-card">
          <div class="claw-auth-brand-mark" aria-hidden="true">A</div>
          <div class="claw-auth-title">AgentDevClaw</div>
          <div class="claw-auth-subtitle">${text('访问保护', 'Access protection')}</div>
          <div class="claw-auth-prompt">${text('请输入密码以继续使用工作台', 'Enter the password to continue to the workbench')}</div>
          <form id="claw-auth-form" novalidate>
            <label class="claw-auth-label" for="claw-auth-password">${text('密码', 'Password')}</label>
            <input id="claw-auth-password" type="password" autocomplete="current-password" autofocus
              placeholder="${text('请输入访问密码', 'Enter access password')}">
            <div id="claw-auth-error" class="claw-auth-error" role="alert"></div>
            <button class="settings-btn settings-btn-primary" type="submit">${text('登录工作台', 'Sign in')}</button>
          </form>
        </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#claw-auth-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const passwordInput = overlay.querySelector('#claw-auth-password');
      const errorEl = overlay.querySelector('#claw-auth-error');
      const button = overlay.querySelector('button');
      button.disabled = true;
      errorEl.textContent = '';
      try {
        const response = await nativeFetch(appUrl('/protoclaw/auth/login'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: passwordInput.value }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || text('登录失败', 'Sign-in failed'));
        authState.authenticated = true;
        removeOverlay();
        resolveReady(authState);
        window.dispatchEvent(new CustomEvent('claw-authenticated'));
      } catch (error) {
        errorEl.textContent = error.message || text('登录失败', 'Sign-in failed');
        passwordInput.select();
        button.disabled = false;
      }
    });
  }
  const errorEl = overlay.querySelector('#claw-auth-error');
  if (errorEl && error) errorEl.textContent = error;
  overlay.querySelector('#claw-auth-password')?.focus();
}

function handleUnauthorized(input) {
  if (isAuthPath(input) || isRemoteNamespaceRequest(input)) return;
  authState.authenticated = false;
  showLogin();
}

function ensureAuthSettingsHost() {
  let host = document.getElementById('auth-settings-overlay-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'auth-settings-overlay-host';
    document.body.appendChild(host);
  }
  return host;
}

export function closeAuthSettings() {
  const host = document.getElementById('auth-settings-overlay-host');
  if (host) host.innerHTML = '';
}

function renderAuthSettings(config) {
  const isZh = (localStorage.getItem('agentdev-language') || 'zh') === 'zh';
  const auth = config || { enabled: false, configured: false };
  const host = ensureAuthSettingsHost();
  host.innerHTML = [
    '<div class="feature-detail-overlay">',
    '<div class="feature-detail-window auth-settings-window">',
    '<div class="feature-detail-head">',
    '<div>',
    '<div class="feature-detail-title">' + (isZh ? '访问保护' : 'Access protection') + '</div>',
    '<div class="feature-detail-subtitle">' + (isZh ? '配置此 Claw 的单密码访问保护' : 'Configure single-password access protection for this Claw') + '</div>',
    '</div>',
    '<button class="feature-detail-close" type="button" title="' + (isZh ? '关闭' : 'Close') + '" data-action="authClient.close">×</button>',
    '</div>',
    '<div class="settings-tab-content auth-settings-content">',
    '<div class="settings-section">',
    '<div class="settings-auth-warning">' + text(
      '开启后，访问此 Claw 的浏览器需要输入密码。密码只保存在服务端的加密哈希中。公网部署仍建议使用 HTTPS。',
      'When enabled, browsers must enter a password to access this Claw. Only a password hash is stored on the server. HTTPS is still recommended for public deployments.') + '</div>',
    '<label class="settings-checkbox auth-settings-checkbox">',
    '<input type="checkbox" id="settings-auth-enabled" ' + (auth.enabled ? 'checked' : '') + '>',
    '<span>' + (isZh ? '开启访问保护' : 'Enable access protection') + '</span>',
    '</label>',
    '<div class="settings-field">',
    '<label for="settings-auth-password">' + (auth.configured ? (isZh ? '修改密码（留空保持不变）' : 'Change password (leave blank to keep)') : (isZh ? '设置密码' : 'Set password')) + '</label>',
    '<input class="settings-input" id="settings-auth-password" type="password" autocomplete="new-password" placeholder="' + (isZh ? '至少 8 个字符' : 'At least 8 characters') + '">',
    '</div>',
    '<div class="settings-auth-status">' + (auth.enabled ? (isZh ? '当前状态：已开启' : 'Status: enabled') : (isZh ? '当前状态：未开启' : 'Status: disabled')) + '</div>',
    '</div>',
    '</div>',
    '<div class="settings-footer">',
    '<div class="settings-actions">',
    auth.enabled ? '<button class="settings-btn settings-btn-secondary" type="button" data-action="authClient.logout">' + (isZh ? '退出登录' : 'Sign out') + '</button>' : '',
    '<button class="settings-btn settings-btn-secondary" type="button" data-action="authClient.close">' + (isZh ? '取消' : 'Cancel') + '</button>',
    '<button class="settings-btn settings-btn-primary" type="button" id="auth-settings-save" data-action="authClient.save">' + (isZh ? '保存保护设置' : 'Save protection settings') + '</button>',
    '</div>',
    '</div>',
    '</div>',
    '</div>',
  ].join('');
}

export async function openAuthSettings() {
  try {
    const response = await fetch(appUrl('/protoclaw/auth/config'), { cache: 'no-store' });
    const config = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(config.error || text('读取保护设置失败', 'Failed to load protection settings'));
    renderAuthSettings(config);
  } catch (error) {
    window.alert(error.message || text('读取保护设置失败', 'Failed to load protection settings'));
  }
}

async function saveAuthSettings() {
  const enabled = document.getElementById('settings-auth-enabled')?.checked === true;
  const password = document.getElementById('settings-auth-password')?.value || '';
  const button = document.getElementById('auth-settings-save');
  if (button) button.disabled = true;
  try {
    const response = await fetch(appUrl('/protoclaw/auth/config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text('保存保护设置失败', 'Failed to save protection settings'));
    authState.enabled = data.enabled === true;
    authState.configured = data.configured === true;
    authState.authenticated = true;
    closeAuthSettings();
    window.alert(text('访问保护设置已保存。', 'Access protection settings saved.'));
  } catch (error) {
    window.alert(error.message || text('保存失败', 'Save failed'));
    if (button) button.disabled = false;
  }
}

// 认证 API（原 window.ClawAuth）：消费面只有本文件的 authClient.logout 动作，
// 因此随迁移收敛为模块私有（P4 配方步 2「消费面为零 → 模块私有」）。
const authApi = {
  getState: () => ({ ...authState }),
  getConfig: async () => {
    const response = await fetch(appUrl('/protoclaw/auth/config'), { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text('读取保护设置失败', 'Failed to load protection settings'));
    return data;
  },
  saveConfig: async ({ enabled, password = '' }) => {
    const response = await fetch(appUrl('/protoclaw/auth/config'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: enabled === true, password }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || text('保存保护设置失败', 'Failed to save protection settings'));
    authState.enabled = data.enabled === true;
    authState.configured = data.configured === true;
    authState.authenticated = true;
    return data;
  },
  logout: async () => {
    await fetch(appUrl('/protoclaw/auth/logout'), { method: 'POST' });
    window.location.reload();
  },
};

// ── 事件接线（data-action="authClient.*"）─────────────────────────────
// 动作分发器由 index.html 的 classic 标签先于一切模块装载（模块相必然就位）。
window.ClawFW.actions.registerMany({
  'authClient.close': () => closeAuthSettings(),
  'authClient.save': () => saveAuthSettings(),
  // 登出走模块内部 API（logout 内含 reload），不复制其实现
  'authClient.logout': () => authApi.logout(),
});

window.fetch = function(input, init) {
  return nativeFetch(input, init).then((response) => {
    if (response.status === 401) handleUnauthorized(input);
    return response;
  });
};

async function initialize() {
  try {
    const response = await nativeFetch(appUrl('/protoclaw/auth/status'), { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    authState = {
      enabled: data.enabled === true,
      configured: data.configured === true,
      authenticated: data.authenticated !== false,
    };
    if (authState.enabled && !authState.authenticated) {
      showLogin();
      return;
    }
    resolveReady(authState);
  } catch (error) {
    rejectReady(error);
    console.warn('[auth] failed to read authentication status:', error);
  }
}

// ── 桥接期兼容面（domain `auth-client`）──────────────────────────────────
// 三个桥键，逐个说明消费面与注销条件：
//   __clawAuthReady   ← sse-client 求值期的自举判定（`typeof ... .then`，缺席时走
//                       「模块顶层自举」分支；测试夹具也按该键注入闸）。
//   closeAuthSettings ← app-ui 设置 flyout 的 click 回调（运行时，非求值期）。
//   openAuthSettings  ← 同上（「访问保护」菜单项）。
// 编排域（app-main）在求值期读第一个键（`await window.__clawAuthReady`）——
// 由「本入口早于 app-main 入口」保证可达，见文件头注。
//
// 注销条件：__clawAuthReady 待 sse-client 的自举分支重评并改具名 import（或该
// 分支随 T5 收敛删除）；两个设置面函数待 app-ui 能安全具名 import——**不能**
// 直接 import：本模块求值期就要求 action 分发器与桥存储就位（fetch 401 拦截、
// authClient.* 动作注册），静态边会把这个装载期副作用随 app-ui 铺进每一张触达
// 主视图域的图（实测：p2 静态环用例整片红），因此按窗口面保留，待该副作用拆到
// 独立装载单元后再收敛。
window.KernelState.defineKey('auth-client', '__clawAuthReady', authReady);
window.KernelState.defineKey('auth-client', 'closeAuthSettings', closeAuthSettings);
window.KernelState.defineKey('auth-client', 'openAuthSettings', openAuthSettings);
const bridgeApi = {
  __clawAuthReady: authReady,
  closeAuthSettings,
  openAuthSettings,
};
window.KernelState.claim('auth-client', {
  get: (key) => bridgeApi[key],
  set: (key, value) => { bridgeApi[key] = value; },
});

// 初始化时相：沿用「DOMContentLoaded 之后」的既有语义。模块相 readyState 已是
// 'interactive'（DOMContentLoaded 尚未触发），因此只有已经错过该事件（动态
// import / 测试桩）才立刻执行。
if (document.readyState === 'complete') initialize();
else document.addEventListener('DOMContentLoaded', initialize, { once: true });
