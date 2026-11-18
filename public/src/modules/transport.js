/**
 * transport.js — 传输域：invoke 分发、Viewer 就绪探测与 fetch 分流
 * （P4 T1：从 app-core 抽出的第三族）。
 *
 * 内容与 classic 时期逐字一致，owner 从 app-core 顶层搬到模块相：
 *
 *   - `window.fetch` 的同源 / ViewerWorker 分流补丁。这是**页面级基础设施**，
 *     必须在任何模块发起 fetch 之前装好：p4-entry 在 p2-entry 之前求值，
 *     且首屏链（boot.js）是 index.html 最后一条 module 标签，因此补丁仍然
 *     早于所有业务请求。
 *   - `invoke`：Tauri 桥优先、同源 HTTP 回退的唯一实现。仍有 classic 消费方
 *     （app-main / 悬置域 wg-core、wg-settings-panel），因此保留
 *     KernelState 桥键 `invoke`（domain `transport`）；已迁消费方改具名 import。
 *   - `createViewerReadinessHost()`：Viewer 就绪轮询的窄宿主（application-startup
 *     域装载期取用）。
 *   - `showWebPicker`：非 Windows 的文件 / 目录选择器回退实现，只由 invoke 内部
 *     调用（零外部消费面，因此不上桥；原 `window._showWebPicker` 全局随之注销）。
 *   - `VIEWER_BASE_URL` / `USE_SAME_ORIGIN_VIEWER_PROXY` / `isServerServedPage` /
 *     `nativeFetch` 收敛为模块私有。
 *
 * 所有请求都经 `window.fetch` 发起（浏览器里它就是全局 `fetch`，即本文件装好的
 * 分流补丁）。写裸 `fetch` 在浏览器等价，但在测试桩环境会绕过补丁与替换面——
 * 这条接缝必须显式。
 *
 * 注销条件：app-main 与两个悬置域（wg-*）迁 ESM / 重做、且 sidebar-render 的三处
 * `window.invoke` 改具名 import 后删除 `invoke` 桥键。
 */

const VIEWER_BASE_URL = 'http://127.0.0.1:2026';

const nativeFetch = window.fetch.bind(window);
// Browser deployments always use the product server's same-origin Viewer proxy.
// This remains correct when a gateway exposes the app on another port or under
// a path prefix such as /agentdev/. Non-HTTP desktop shells keep the direct
// ViewerWorker fallback.
const USE_SAME_ORIGIN_VIEWER_PROXY = window.location.protocol === 'http:' || window.location.protocol === 'https:';

window.fetch = function(input, init) {
  if (USE_SAME_ORIGIN_VIEWER_PROXY) {
    return nativeFetch(input, init);
  }
  if (typeof input === 'string' && input.startsWith('/api/')) {
    return nativeFetch(VIEWER_BASE_URL + input, init);
  }
  if (input instanceof Request && input.url.startsWith('/api/')) {
    return nativeFetch(VIEWER_BASE_URL + input.url, init);
  }
  return nativeFetch(input, init);
};

function createViewerReadinessHost() {
  return {
    now: () => Date.now(),
    fetch: (...args) => nativeFetch(...args),
    url: () => USE_SAME_ORIGIN_VIEWER_PROXY ? '/api/agents' : (VIEWER_BASE_URL + '/api/agents'),
    wait: (delay) => new Promise(resolve => setTimeout(resolve, delay)),
  };
}

// ── Web-based file/directory picker (fallback for non-Windows) ──

function showWebPicker(mode) {
  return new Promise((resolve) => {
    const isZh = window.currentLanguage === 'zh';
    const titleMap = {
      directory: isZh ? '选择目录' : 'Select Directory',
      empty_directory: isZh ? '选择空目录' : 'Select Empty Directory',
      files: isZh ? '选择文件' : 'Select Files',
    };
    const title = titleMap[mode] || titleMap.directory;
    const isFileMode = mode === 'files';

    const overlay = document.createElement('div');
    overlay.className = 'fs-dir-picker-overlay';
    overlay.innerHTML = `
      <div class="fs-dir-picker">
        <div class="fs-dir-picker-header">
          <span>${title}</span>
          <button class="fs-dir-picker-close">&times;</button>
        </div>
        <div class="fs-dir-picker-toolbar">
          <button class="fs-dir-picker-up" title="${isZh ? '上一级' : 'Parent'}">&#8593;</button>
          <input type="text" class="fs-dir-picker-path" value="" />
        </div>
        <div class="fs-dir-picker-drives"></div>
        <div class="fs-dir-picker-body"><div class="fs-dir-picker-spinner"></div></div>
        <div class="fs-dir-picker-footer">
          <span class="fs-dir-picker-hint" style="flex:1;font-size:12px;color:var(--text-muted);${isFileMode ? '' : 'display:none'}"></span>
          <button class="fs-dir-picker-cancel">${isZh ? '取消' : 'Cancel'}</button>
          <button class="fs-dir-picker-select">${isZh ? '选择此目录' : 'Select'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let currentPath = '';
    const selectedFiles = new Set();

    function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

    async function loadDir(targetPath) {
      const body = overlay.querySelector('.fs-dir-picker-body');
      const pathInput = overlay.querySelector('.fs-dir-picker-path');
      const upBtn = overlay.querySelector('.fs-dir-picker-up');
      const drivesEl = overlay.querySelector('.fs-dir-picker-drives');
      body.innerHTML = '<div class="fs-dir-picker-spinner"></div>';

      try {
        const url = `/protoclaw/browse_dirs?path=${encodeURIComponent(targetPath)}${isFileMode ? '&includeFiles=true' : ''}`;
        const res = await window.fetch(url);
        if (!res.ok) {
          body.innerHTML = `<div class="fs-dir-picker-error">${isZh ? '无法读取此目录' : 'Cannot read this directory'}</div>`;
          return;
        }
        const data = await res.json();
        currentPath = data.currentPath;
        pathInput.value = currentPath;
        upBtn.disabled = !data.parent;
        upBtn.onclick = () => { if (data.parent) loadDir(data.parent); };

        if (data.drives && data.drives.length > 1) {
          drivesEl.innerHTML = data.drives.map(d =>
            `<button class="fs-dir-picker-drive ${d.path === currentPath ? 'active' : ''}" data-path="${escHtml(d.path)}">${escHtml(d.label)}</button>`
          ).join('');
          drivesEl.querySelectorAll('.fs-dir-picker-drive').forEach(b => {
            b.onclick = () => loadDir(b.getAttribute('data-path'));
          });
          drivesEl.style.display = '';
        } else {
          drivesEl.style.display = 'none';
        }

        if (data.entries.length === 0) {
          body.innerHTML = `<div class="fs-dir-picker-empty">${isZh ? '(空目录)' : '(empty)'}</div>`;
        } else {
          body.innerHTML = data.entries.map(e => {
            const icon = e.isDirectory ? '&#128193;' : '&#128196;';
            const cls = e.isDirectory ? 'fs-dir-entry' : 'fs-dir-entry fs-dir-entry-file';
            const sel = selectedFiles.has(e.path) ? ' selected' : '';
            return `<div class="${cls}${sel}" data-path="${escHtml(e.path)}" data-is-dir="${e.isDirectory}">${icon} ${escHtml(e.name)}</div>`;
          }).join('');
          body.querySelectorAll('.fs-dir-entry').forEach(el => {
            const isDir = el.getAttribute('data-is-dir') === 'true';
            if (isDir) {
              el.ondblclick = () => loadDir(el.getAttribute('data-path'));
            }
            el.onclick = () => {
              if (!isDir && isFileMode) {
                if (el.classList.contains('selected')) {
                  el.classList.remove('selected');
                  selectedFiles.delete(el.getAttribute('data-path'));
                } else {
                  el.classList.add('selected');
                  selectedFiles.add(el.getAttribute('data-path'));
                }
                updateHint();
              }
            };
          });
        }
      } catch {
        body.innerHTML = `<div class="fs-dir-picker-error">${isZh ? '加载失败' : 'Failed to load'}</div>`;
      }
    }

    function updateHint() {
      const hint = overlay.querySelector('.fs-dir-picker-hint');
      if (hint) {
        hint.textContent = isZh ? `已选择 ${selectedFiles.size} 个文件` : `${selectedFiles.size} file(s) selected`;
      }
    }

    overlay.querySelector('.fs-dir-picker-path').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); loadDir(e.target.value); }
    });

    overlay.querySelector('.fs-dir-picker-select').onclick = () => {
      if (isFileMode) {
        resolve({ paths: Array.from(selectedFiles), cancelled: selectedFiles.size === 0 });
      } else {
        if (currentPath) resolve({ path: currentPath, cancelled: false });
      }
      overlay.remove();
    };

    const close = () => {
      if (isFileMode) resolve({ paths: [], cancelled: true });
      else resolve({ path: '', cancelled: true });
      overlay.remove();
    };
    overlay.querySelector('.fs-dir-picker-cancel').onclick = close;
    overlay.querySelector('.fs-dir-picker-close').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    loadDir('');
  });
}

// HTTP 回退的适用判定：页面由 Claw 服务（或其代理）经 http(s) 提供，相对路径
// fetch 自然落在同源服务上。不能按端口白名单判断——自定义 PORT、隔离实例、
// 反向代理场景都会偏离默认端口，端口检查会让 loadAgents 全链失败。
const isServerServedPage = window.location.protocol === 'http:' || window.location.protocol === 'https:';

async function invokeImpl(command, payload = {}) {
  if (window.__PROTOCLAW_TAURI_BRIDGE__ && typeof window.__PROTOCLAW_TAURI_BRIDGE__.invoke === 'function') {
    try {
      return await window.__PROTOCLAW_TAURI_BRIDGE__.invoke(command, payload);
    } catch (error) {
      if (!isServerServedPage) {
        throw error;
      }
    }
  }
  if (isServerServedPage) {
    if (command === 'get_connected_agents') {
      // 归属参数透传：PH 类工作空间的会话切片必须按调用方实际浏览的归属
      // 返回（项目 / 目录）。缺省时服务端回退 workspace_state.openDirectory，
      // 用户正在浏览项目时会拿到目录切片并覆盖项目列表。
      const query = payload && typeof payload === 'object'
        ? Object.entries(payload)
          .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
          .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
          .join('&')
        : '';
      const res = await window.fetch('/protoclaw/get_connected_agents' + (query ? '?' + query : ''));
      if (!res.ok) {
        // Keep the array return shape for existing callers, while carrying the
        // source failure to loadAgents for one consolidated diagnostic event.
        console.warn(`[sidebar] get_connected_agents HTTP ${res.status}: connected snapshot unavailable this round`);
        const emptySnapshot = [];
        Object.defineProperty(emptySnapshot, '__sidebarDiagnostic', {
          value: {
            errorCode: `connected-agents-http-${res.status}`,
            phase: 'connected-http-error',
          },
          enumerable: false,
        });
        return emptySnapshot;
      }
      return res.json();
    }
    if (command === 'get_prebuilt_agents') {
      const res = await window.fetch('/protoclaw/get_prebuilt_agents');
      return res.ok ? res.json() : [];
    }
    if (command === 'get_agents_status') {
      const res = await window.fetch('/protoclaw/get_agents_status');
      return res.ok ? res.json() : [];
    }
    if (command === 'start_agent') {
      const res = await window.fetch('/protoclaw/start_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
    if (command === 'stop_agent') {
      const res = await window.fetch('/protoclaw/stop_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
    if (command === 'restart_agent') {
      const res = await window.fetch('/protoclaw/restart_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      return res.json();
    }
    if (command === 'select_empty_directory') {
      const res = await window.fetch('/protoclaw/select_empty_directory', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      if (data.useWebPicker) return await showWebPicker(data.mode || 'empty_directory');
      return data;
    }
    if (command === 'select_files') {
      const res = await window.fetch('/protoclaw/select_files', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      if (data.useWebPicker) return await showWebPicker(data.mode || 'files');
      return data;
    }
    if (command === 'select_directory') {
      const res = await window.fetch('/protoclaw/select_directory', {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      if (data.useWebPicker) return await showWebPicker(data.mode || 'directory');
      return data;
    }
  }

  throw new Error('Web invoke bridge is not available');
}


// ── classic 兼容桥 ──────────────────────────────────────────────────────
// 仍有 window 面消费方的 `invoke` 保留桥键：classic 侧是 app-main（startApplication
// 的宿主调用）与悬置域 wg-core / wg-settings-panel（目录选择）；已迁 ESM 的
// sidebar-render 也仍走 `window.invoke`（三处 get_connected_agents）——它属本轮禁区，
// 下批改为具名 import 后一并下桥。其余导出按具名 import 交给已迁消费方。
//
// `invoke` 是宿主的 IPC 缝（Tauri 桥 / 同源 HTTP 的唯一分发点），既被 classic
// 调用、又被 ESM 消费方 import。函数键因此经域状态转发：claim 之后 classic 写方
// （例如壳层或诊断面替换 window.invoke）经 setter 落进本域状态，两条调用路径读到
// 同一份实现。这是桥键 setter 语义对函数键的直接应用，不是第二份实现。
const bridgeState = {
  // 初始写不丢失（桥键吸收语义）：classic 相已经把 `window.invoke` 换成另一份实现
  // （桌面壳注入 / 诊断面替换）时，模块接管的是那份实现，而不是把它顶掉。
  invoke: typeof window.invoke === 'function' ? window.invoke : invokeImpl,
};
window.KernelState.defineKey('transport', 'invoke', bridgeState.invoke);
window.KernelState.claim('transport', {
  get: (key) => bridgeState[key],
  set: (key, value) => { bridgeState[key] = value; },
});

/** 宿主 IPC 分发（实现落在域状态上，见上方桥注释）。 */
export function invoke(command, payload = {}) {
  return bridgeState.invoke(command, payload);
}

export { createViewerReadinessHost };
