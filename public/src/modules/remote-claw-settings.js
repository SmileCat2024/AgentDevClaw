/** Remote Claw connection center — state-driven onboarding and device management. */
(function () {
  const state = {
    open: false,
    view: 'home', // home | pair | settings
    loading: false,
    error: '',
    config: {},
    runtime: {},
    devices: [],
    pairing: null,
    relayUrl: '',
    workspaceName: 'AgentDevClaw',
    mobileRelayUrl: '',
  };

  // ── Icons ──────────────────────────────────────────────────────────────────

  const ICON = {
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9h-1.8A7 7 0 1 0 4 15.7"/><path d="M12 12v6"/><path d="m9 15 3-3 3 3"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>',
    qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="5" height="5" x="3" y="3" rx="1"/><path d="M3 8h5M8 3v5"/><rect width="5" height="5" x="16" y="3" rx="1"/><path d="M16 8h5M21 3v5"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M3 16v5M8 21H3"/><path d="M14 14h2v2h-2zM18 14h.01M14 18v.01M18 18v2M21 21v.01M21 14v3"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    spinner: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" class="rc-spin"/></svg>',
  };

  // ── DOM host ────────────────────────────────────────────────────────────────

  function ensureHost() {
    let host = document.getElementById('remote-claw-overlay-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'remote-claw-overlay-host';
      document.body.appendChild(host);
    }
    return host;
  }

  // ── API actions (unchanged logic) ──────────────────────────────────────────

  async function openRemoteClawSettings() {
    state.open = true;
    state.view = 'home';
    state.loading = true;
    state.error = '';
    state.pairing = null;
    render();
    try {
      const data = await getJson('/protoclaw/remote_claw/config');
      state.config = data.config || {};
      state.runtime = data.runtime || {};
      state.relayUrl = state.config.relayUrl || 'http://127.0.0.1:8080';
      state.workspaceName = state.config.workspaceName || 'AgentDevClaw';
      state.mobileRelayUrl = preferredMobileUrl();
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function closeRemoteClawSettings() {
    state.open = false;
    ensureHost().innerHTML = '';
  }

  async function connectRemoteClaw() {
    readForm();
    state.loading = true;
    state.error = '';
    render();
    try {
      const data = await postJson('/protoclaw/remote_claw/connect', {
        relayUrl: state.relayUrl,
        workspaceName: state.workspaceName,
      });
      state.config = data.config || {};
      const fresh = await getJson('/protoclaw/remote_claw/config');
      state.runtime = fresh.runtime || {};
      state.mobileRelayUrl = preferredMobileUrl();
      state.view = 'home';
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function createRemoteClawPairing() {
    readForm();
    state.loading = true;
    state.error = '';
    render();
    try {
      const data = await postJson('/protoclaw/remote_claw/pairing', { mobileRelayUrl: state.mobileRelayUrl });
      state.pairing = data.pairing || null;
      state.mobileRelayUrl = data.mobileRelayUrl || state.mobileRelayUrl;
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function disconnectRemoteClaw() {
    state.loading = true;
    state.error = '';
    render();
    try {
      await postJson('/protoclaw/remote_claw/disconnect', {});
      state.config = { ...state.config, enabled: false };
      state.runtime = { ...state.runtime, enabled: false };
      state.view = 'home';
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function unregisterRemoteClaw() {
    if (!confirm('从服务器注销这台 Claw？\n\n服务器上的会话镜像、配对记录和已登录手机都会被移除。本地会话文件不会删除。')) return;
    state.loading = true;
    state.error = '';
    render();
    try {
      const response = await fetch('/protoclaw/remote_claw/registration', { method: 'DELETE' });
      const json = await response.json();
      if (!response.ok || json.ok === false) throw new Error(json.error || '注销失败');
      state.config = { enabled: false };
      state.runtime = { enabled: false };
      state.devices = [];
      state.pairing = null;
      state.view = 'home';
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── State helpers ──────────────────────────────────────────────────────────

  function isConnected() {
    return state.config?.enabled && state.config?.hasConnectorToken;
  }

  function preferredMobileUrl() {
    const urls = state.runtime?.lanUrls || [];
    return state.mobileRelayUrl || urls[0] || state.config?.relayUrl || '';
  }

  function readForm() {
    const relay = document.getElementById('remote-claw-relay-url');
    const name = document.getElementById('remote-claw-workspace-name');
    const mobile = document.getElementById('remote-claw-mobile-url');
    if (relay) state.relayUrl = relay.value.trim();
    if (name) state.workspaceName = name.value.trim() || 'AgentDevClaw';
    if (mobile) state.mobileRelayUrl = mobile.value.trim();
  }

  function setView(view) {
    readForm();
    state.view = view;
    state.error = '';
    if (view !== 'pair') state.pairing = null;
    render();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  function render() {
    const host = ensureHost();
    if (!state.open) return void (host.innerHTML = '');

    const connected = isConnected();
    const viewKey = !connected ? 'setup' : state.view;

    host.innerHTML = el('div', {
      class: 'rc-overlay',
      onclick: 'if(event.target===this)closeRemoteClawSettings()',
    }, [
      el('div', { class: 'rc-modal' + (state.loading ? ' rc-modal--loading' : '') }, [
        // Header
        el('div', { class: 'rc-header' }, [
          connected && state.view !== 'home'
            ? el('button', { class: 'rc-icon-btn', type: 'button', onclick: "remoteClawSetView('home')" }, ICON.arrowLeft)
            : '',
          el('div', { class: 'rc-header-text' }, [
            el('div', { class: 'rc-title' }, headerTitle(viewKey)),
            el('div', { class: 'rc-subtitle' }, headerSubtitle(viewKey)),
          ]),
          el('button', { class: 'rc-icon-btn rc-icon-btn--close', type: 'button', onclick: 'closeRemoteClawSettings()' }, '×'),
        ]),
        // Error banner
        state.error ? el('div', { class: 'rc-error' }, [ICON.warn, escapeHtml(state.error)]) : '',
        // Body
        el('div', { class: 'rc-body' }, renderView(viewKey)),
        // Loading overlay
        state.loading ? el('div', { class: 'rc-loading-overlay' }, [ICON.spinner, '处理中…']) : '',
      ]),
    ]);
  }

  function renderView(viewKey) {
    if (viewKey === 'setup') return renderSetup();
    if (viewKey === 'pair') return renderPair();
    if (viewKey === 'settings') return renderSettings();
    return renderHome();
  }

  // ── View: Setup (not connected) ─────────────────────────────────────────────

  function renderSetup() {
    return [
      el('div', { class: 'rc-hero' }, [
        el('div', { class: 'rc-hero-icon' }, ICON.cloud),
        el('p', { class: 'rc-hero-desc' }, '连接到 Relay Server 后，你的手机就能安全查看这台电脑上的所有 Agent 会话。数据通过中继服务器加密传输，不会暴露到公网。'),
      ]),
      el('div', { class: 'rc-form' }, [
        field('Relay Server 地址', el('input', {
          class: 'settings-input',
          id: 'remote-claw-relay-url',
          value: state.relayUrl,
          placeholder: 'https://relay.example.com',
          autocomplete: 'off',
        })),
        field('这台电脑的名称', el('input', {
          class: 'settings-input',
          id: 'remote-claw-workspace-name',
          value: state.workspaceName,
          placeholder: 'AgentDevClaw',
          autocomplete: 'off',
        })),
        el('div', { class: 'rc-hint' }, '连接后会为这台 Claw 创建稳定身份，重复连接不会产生新实例。'),
        el('button', {
          class: 'settings-btn settings-btn-primary rc-btn-block',
          type: 'button',
          onclick: 'connectRemoteClaw()',
          disabled: state.loading,
        }, [ICON.link, '开启远程访问']),
      ]),
    ];
  }

  // ── View: Home (connected dashboard) ────────────────────────────────────────

  function renderHome() {
    const wsName = state.config.workspaceName || 'AgentDevClaw';
    const relayUrl = state.config.relayUrl || '';
    return [
      el('div', { class: 'rc-status-card' }, [
        el('div', { class: 'rc-status-indicator' }, el('span', { class: 'rc-status-dot' })),
        el('div', { class: 'rc-status-info' }, [
          el('div', { class: 'rc-status-label' }, '在线'),
          relayUrl ? el('div', { class: 'rc-status-meta' }, escapeHtml(relayUrl)) : '',
        ]),
        el('div', { class: 'rc-status-badge' }, [ICON.check, '已连接']),
      ]),
      el('div', { class: 'rc-ws-name' }, escapeHtml(wsName)),
      el('div', { class: 'rc-action-list' }, [
        el('button', {
          class: 'rc-action-item rc-action-item--primary',
          type: 'button',
          onclick: "remoteClawSetView('pair')",
        }, [
          el('div', { class: 'rc-action-icon' }, ICON.phone),
          el('div', { class: 'rc-action-body' }, [
            el('div', { class: 'rc-action-title' }, '绑定或更换手机'),
            el('div', { class: 'rc-action-desc' }, '新手机登录后会自动退出原手机'),
          ]),
          ICON.chevronRight,
        ]),
        el('button', {
          class: 'rc-action-item',
          type: 'button',
          onclick: "remoteClawSetView('settings')",
        }, [
          el('div', { class: 'rc-action-icon' }, ICON.settings),
          el('div', { class: 'rc-action-body' }, [
            el('div', { class: 'rc-action-title' }, '连接设置'),
            el('div', { class: 'rc-action-desc' }, '修改地址、暂停或注销'),
          ]),
          ICON.chevronRight,
        ]),
      ]),
    ];
  }

  // ── View: Pair (phone pairing) ──────────────────────────────────────────────

  function renderPair() {
    const urls = state.runtime?.lanUrls || [];
    const code = state.pairing?.pairingCode || state.pairing?.code || '';

    if (!state.pairing) {
      return [
        el('div', { class: 'rc-hero' }, [
          el('div', { class: 'rc-hero-icon rc-hero-icon--compact' }, ICON.qr),
        ]),
        el('div', { class: 'rc-form' }, [
          field('手机访问地址', el('input', {
            class: 'settings-input',
            id: 'remote-claw-mobile-url',
            value: state.mobileRelayUrl,
            placeholder: 'http://192.168.1.10:8080',
            autocomplete: 'off',
          })),
          el('div', { class: 'rc-hint' }, '选择手机当前网络可以访问的地址。二维码生成后仍可返回修改。'),
          urls.length > 0
            ? el('div', { class: 'rc-chips' }, urls.map((url) =>
                el('button', {
                  class: 'rc-chip' + (url === state.mobileRelayUrl ? ' rc-chip--selected' : ''),
                  type: 'button',
                  onclick: `useRemoteClawMobileUrl('${escapeAttr(url)}')`,
                }, escapeHtml(url))
              ))
            : '',
          el('button', {
            class: 'settings-btn settings-btn-primary rc-btn-block',
            type: 'button',
            onclick: 'createRemoteClawPairing()',
            disabled: state.loading,
          }, [ICON.qr, '生成登录二维码']),
        ]),
      ];
    }

    return [
      el('div', { class: 'rc-qr-result' }, [
        el('div', { class: 'rc-qr-box' }, state.pairing.qrSvg || ''),
        el('div', { class: 'rc-qr-info' }, [
          el('div', { class: 'rc-qr-code-label' }, '一次性登录码'),
          el('div', { class: 'rc-qr-code' }, escapeHtml(code)),
          el('p', { class: 'rc-qr-hint' }, '打开 Remote Claw 扫描此二维码。二维码 10 分钟后失效，不包含工作空间内容。'),
          el('button', {
            class: 'rc-text-link',
            type: 'button',
            onclick: 'remoteClawResetPairing()',
          }, '修改地址或重新生成'),
        ]),
      ]),
    ];
  }

  // ── View: Settings ──────────────────────────────────────────────────────────

  function renderSettings() {
    return [
      // Connection params — collapsed by default (rarely needed after initial setup)
      el('details', { class: 'rc-collapsible' }, [
        el('summary', { class: 'rc-collapsible-summary' }, [
          el('span', { class: 'rc-collapsible-label' }, '连接参数'),
          el('span', { class: 'rc-collapsible-value' }, escapeHtml(state.relayUrl || '未设置')),
        ]),
        el('div', { class: 'rc-form' }, [
          field('Relay Server', el('input', {
            class: 'settings-input',
            id: 'remote-claw-relay-url',
            value: state.relayUrl,
            autocomplete: 'off',
          })),
          field('电脑名称', el('input', {
            class: 'settings-input',
            id: 'remote-claw-workspace-name',
            value: state.workspaceName,
            autocomplete: 'off',
          })),
          el('button', {
            class: 'settings-btn settings-btn-primary',
            type: 'button',
            onclick: 'connectRemoteClaw()',
          }, '保存设置'),
        ]),
      ]),
      el('div', { class: 'rc-danger-zone' }, [
        el('div', { class: 'rc-danger-item' }, [
          el('div', { class: 'rc-danger-body' }, [
            el('div', { class: 'rc-danger-title' }, '暂停连接'),
            el('div', { class: 'rc-danger-desc' }, '保留服务器注册和手机登录，稍后可重新开启。'),
          ]),
          el('button', {
            class: 'settings-btn settings-btn-secondary',
            type: 'button',
            onclick: 'disconnectRemoteClaw()',
          }, '暂停'),
        ]),
        el('div', { class: 'rc-danger-item rc-danger-item--destructive' }, [
          el('div', { class: 'rc-danger-body' }, [
            el('div', { class: 'rc-danger-title' }, '从服务器注销'),
            el('div', { class: 'rc-danger-desc' }, '移除服务器镜像、配对记录和所有手机登录。本地会话不受影响。'),
          ]),
          el('button', {
            class: 'settings-btn rc-btn-danger',
            type: 'button',
            onclick: 'unregisterRemoteClaw()',
          }, '注销'),
        ]),
      ]),
    ];
  }

  // ── Tiny DOM helpers ────────────────────────────────────────────────────────

  function el(tag, attrs, children) {
    const attrStr = attrs ? Object.entries(attrs).map(([k, v]) => {
      if (v == null || v === false) return '';
      if (v === true) return ` ${k}`;
      return ` ${k}="${escapeAttr(v)}"`;
    }).join('') : '';
    const inner = children == null ? '' : Array.isArray(children) ? children.join('') : String(children);
    return `<${tag}${attrStr}>${inner}</${tag}>`;
  }

  function field(label, inputHtml) {
    return el('div', { class: 'settings-field' }, [
      el('label', {}, label),
      inputHtml,
    ]);
  }

  function headerTitle(viewKey) {
    return { setup: '开启远程访问', pair: '绑定手机', settings: '连接设置', home: '远程访问' }[viewKey] || '远程访问';
  }

  function headerSubtitle(viewKey) {
    return {
      setup: '连接 Relay Server，让手机可以安全查看这台 Claw。',
      pair: '创建一个短时有效的手机登录凭证。',
      settings: '管理本机连接、登录状态和服务器注册。',
      home: '查看连接状态，绑定手机或管理本机注册。',
    }[viewKey] || '';
  }

  // ── Utils ──────────────────────────────────────────────────────────────────

  async function getJson(url) {
    const response = await fetch(url);
    const json = await response.json();
    if (!response.ok || json.ok === false) throw new Error(json?.error?.message || json.error || '请求失败');
    return json;
  }

  async function postJson(url, body) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const json = await response.json();
    if (!response.ok || json.ok === false) throw new Error(json?.error?.message || json.error || '请求失败');
    return json;
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function escapeAttr(value) { return escapeHtml(value); }

  // ── Public API ──────────────────────────────────────────────────────────────

  window.openRemoteClawSettings = openRemoteClawSettings;
  window.closeRemoteClawSettings = closeRemoteClawSettings;
  window.connectRemoteClaw = connectRemoteClaw;
  window.createRemoteClawPairing = createRemoteClawPairing;
  window.disconnectRemoteClaw = disconnectRemoteClaw;
  window.unregisterRemoteClaw = unregisterRemoteClaw;
  window.remoteClawSetView = setView;
  window.remoteClawResetPairing = function () { state.pairing = null; render(); };
  window.useRemoteClawMobileUrl = function (url) { state.mobileRelayUrl = url; render(); };
})();
