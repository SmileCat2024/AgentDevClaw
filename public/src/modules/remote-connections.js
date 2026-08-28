/**
 * remote-connections.js
 *
 * ADR-0008 Phase 1 用户可见面（R1-07）：
 *  - 侧栏项目投影：消费 /protoclaw/remote_catalog（R1-05），将远程目录
 *    投影到对应 workspace 的统一「项目 → 运行时」渲染模型中；连接只参与
 *    内部寻址与状态，不单独占用用户可见层级。
 *  - 连接管理面板：走 /protoclaw/remote_connections 增删改与握手（server 同步
 *    健康探测 / 托管隧道生命周期，全程不重启生效）。
 *  - 远程条目按握手 capability 门控（ADR-0011）：具备 capabilities.write 的
 *    连接体验与本地一致；无写能力（旧远程/断开）进入只读主视图；
 *    断开连接的条目整体停用并明示原因。
 *
 * Exported globals:
 *   isRemoteNamespaceAgentId, maybeRefreshRemoteCatalog,
 *   refreshRemoteCatalog, openRemoteConnectionsManager
 *
 * State discipline: 本模块所有状态均为局部作用域，不进 app-core.js 全局区。
 */

const REMOTE_NS = 'remote:';
// Catalog 轮询节流：跟随既有 poll 循环调度（maybeRefreshRemoteCatalog 由
// runPollCycle 调用），独立于各 poll 周期做时间窗去重。
const RC_CATALOG_REFRESH_MS = 4000;
const REMOTE_CONN_STATUS_CLASSES = new Set([
  'configured', 'connecting', 'connected', 'reconnecting', 'disconnected', 'degraded',
]);

let _rcCatalogInFlight = false;
let _rcLastCatalogFetchAt = 0;
let _rcSidebarProjectionVersion = 0;
// 连接全集（含 disabled，来自 manager 的 CRUD 响应）：区分「删除」与「仅停用」。
let _rcAllConnectionIds = new Set();

// 渲染中的分区（connId -> section）：仅包含 catalog 当前返回的 enabled 连接，
// disabled / 删除的连接立即从展示中消失（默认关闭语义）。
const _rcVisibleSections = new Map();
// 最后已知身份（connId -> { name, workspaces }）：连接断开时保留上次成功聚合
// 的分组内容（ADR-0008 第 2 条：身份由前端持有，不伪造在线数据）。
const _rcMemoryByConnection = new Map();
// 写能力表（connId -> boolean）：随 catalog 携带的握手 capability 刷新
// （ADR-0011）。断开态 section 不携带 capability → false，重连握手后恢复。
const _rcWriteByConnection = new Map();

// ── Namespace helpers ──────────────────────────────────────────────────────

function isRemoteNamespaceAgentId(agentId) {
  return typeof agentId === 'string' && agentId.startsWith(REMOTE_NS);
}

function splitRemoteNamespaceId(agentId) {
  if (!isRemoteNamespaceAgentId(agentId)) return null;
  const rest = agentId.slice(REMOTE_NS.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  return { connectionId: rest.slice(0, sep), innerId: rest.slice(sep + 1) };
}

// 写能力门控（ADR-0011）：远程且具备 capabilities.write 才可写；本地身份
// 永不因此进入只读。未知连接（尚未出现在 catalog）按不可写处理。
function isRemoteWriteEnabled(agentId) {
  const split = splitRemoteNamespaceId(agentId);
  if (!split) return true;
  return _rcWriteByConnection.get(split.connectionId) === true;
}

function rcStatusClass(state) {
  const normalized = String(state || '').trim();
  return REMOTE_CONN_STATUS_CLASSES.has(normalized) ? `remote-status-${normalized}` : 'remote-status-configured';
}

function formatRemoteClock(isoOrNull) {
  const ts = isoOrNull instanceof Date ? isoOrNull.getTime() : Number(isoOrNull);
  if (!Number.isFinite(ts)) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ── Catalog consumption ───────────────────────────────────────────────────

function shouldRenderRemoteCatalog(payload) {
  return !!payload && Array.isArray(payload.connections) && payload.connections.length > 0;
}

function ingestRemoteCatalog(payload) {
  if (!shouldRenderRemoteCatalog(payload)) {
    // 404 / 空目录 / 失败响应：不保留任何远程 UI（默认关闭语义）。
    _rcVisibleSections.clear();
    _rcMemoryByConnection.clear();
    _rcWriteByConnection.clear();
    return;
  }

  const seenIds = new Set();
  for (const raw of payload.connections) {
    const connId = typeof raw?.connectionId === 'string' ? raw.connectionId : '';
    if (!connId || connId.includes(':')) continue;
    seenIds.add(connId);

    // 写能力随 section 刷新（ADR-0011）：connected 态携带握手 capability，
    // 断开态缺失 → false。未知字段缺失同样视为不可写。
    _rcWriteByConnection.set(connId, raw?.capabilities?.write === true);

    const connected = raw.status === 'connected';
    const workspaces = connected && Array.isArray(raw.workspaces)
      ? raw.workspaces
      : (_rcMemoryByConnection.get(connId)?.workspaces || []);
    if (connected) {
      _rcMemoryByConnection.set(connId, { name: raw.name || connId, workspaces });
    }

    const prev = _rcVisibleSections.get(connId);
    const wasConnected = prev?.status === 'connected';
    const disconnectedAt = connected
      ? null
      : (wasConnected ? Date.now() : (prev?.disconnectedAt ?? null));
    _rcVisibleSections.set(connId, {
      ...raw,
      name: raw.name || _rcMemoryByConnection.get(connId)?.name || connId,
      workspaces,
      disconnectedAt,
    });

    // 主视图正停在该连接的远程会话上时，把健康变化明示到顶栏状态徽章
    // （远程会话无 /connection 本地刷新路径，由 catalog 周期代为同步）。
    if (typeof currentRuntimeAgentId === 'string'
      && splitRemoteNamespaceId(currentRuntimeAgentId)?.connectionId === connId) {
      if (wasConnected && !connected) {
        window.ClawToast?.show?.({
          id: `remote-focus-offline-${connId}`,
          status: 'warning',
          title: t('rcon_state_disconnected'),
          description: t('rcon_banner_disconnected'),
        });
      }
      if (typeof setConnectionStatus === 'function') {
        setConnectionStatus(connected);
      }
    }
  }

  // 不在本轮快照内的连接：移出展示。不在连接全集里的视为已删除，
  // 连记忆一并清除；仍在全集的（disabled）保留最后已知身份供重新启用恢复。
  for (const connId of Array.from(_rcVisibleSections.keys())) {
    if (!seenIds.has(connId)) {
      _rcVisibleSections.delete(connId);
      _rcWriteByConnection.delete(connId);
      if (!_rcAllConnectionIds.has(connId)) _rcMemoryByConnection.delete(connId);
    }
  }
}

async function refreshRemoteCatalog() {
  if (_rcCatalogInFlight) return;
  _rcCatalogInFlight = true;
  try {
    let renderedSomething = false;
    try {
      const res = await fetch('/protoclaw/remote_catalog');
      if (res.ok) {
        const payload = await res.json().catch(() => null);
        ingestRemoteCatalog(payload);
        renderedSomething = _rcVisibleSections.size > 0;
      } else {
        ingestRemoteCatalog(null);
      }
    } catch {
      // transport failure behaves like a 404: no remote UI this cycle
      ingestRemoteCatalog(null);
    }
    _rcSidebarProjectionVersion += 1;
    if (typeof renderAgentList === 'function') renderAgentList();
    if (renderedSomething) tryRestoreRemoteFocus();
  } finally {
    _rcCatalogInFlight = false;
    _rcLastCatalogFetchAt = Date.now();
  }
}

function maybeRefreshRemoteCatalog() {
  const now = Date.now();
  if (_rcCatalogInFlight || now - _rcLastCatalogFetchAt < RC_CATALOG_REFRESH_MS) return;
  void refreshRemoteCatalog();
}

// ── Focus restore for remote namespace memories ───────────────────────────

// 启动后首个成功 catalog 用于尝试一次远程焦点恢复；此后不再介入（用户主动
// 切换永远优先）。沿用本地恢复的优先级语义：本地 inputRequest > 记忆。
let _rcBootstrapSeen = false;

function isRemoteEntryOnline(namespacedId) {
  for (const section of _rcVisibleSections.values()) {
    if (section.status !== 'connected') continue;
    for (const workspace of (Array.isArray(section.workspaces) ? section.workspaces : [])) {
      for (const entry of (Array.isArray(workspace?.entries) ? workspace.entries : [])) {
        if (entry.runtimeId === namespacedId || entry.id === namespacedId || entry.agentId === namespacedId) return true;
      }
    }
  }
  return false;
}

// 逻辑条目 ID → 命名空间运行时引用（目录条目的 runtimeId 字段）。远程 viewer
// 只认运行时 ID：runtime 数据端点、模板映射等 /api 请求都应以它寻址。条目尚无
// 运行时（未启动/连接降级）时返回 null，调用方保持原 ID 显式失败，不静默换目标。
function resolveRuntimeRef(logicalAgentId) {
  const wanted = typeof logicalAgentId === 'string' ? logicalAgentId : '';
  if (!wanted) return null;
  for (const section of _rcVisibleSections.values()) {
    if (section.status !== 'connected') continue;
    for (const workspace of (Array.isArray(section.workspaces) ? section.workspaces : [])) {
      for (const entry of (Array.isArray(workspace?.entries) ? workspace.entries : [])) {
        // 目录条目身份：runtimeId = 命名空间运行时引用（点击寻址目标），
        // id 与 agentId（归属宿主）是额外身份。wanted 可能是其中任一。
        if (entry.runtimeId === wanted || entry.id === wanted || entry.agentId === wanted) {
          if (typeof entry.runtimeId === 'string') return entry.runtimeId;
          return entry.id || null;
        }
      }
    }
  }
  return null;
}

// 命名空间运行时引用 → 目录条目宿主的逻辑 agent id（如 'programming-helper'）。
// 控制类请求（tool_state / swap 系）在远程会话下用它在 allAgents 之外解析宿主
// 身份；非目录条目（本地 id / 未知引用）返回 null，调用方显式失败不猜目标。
function getEntryHostAgentId(namespacedId) {
  const wanted = typeof namespacedId === 'string' ? namespacedId : '';
  if (!wanted) return null;
  for (const section of _rcVisibleSections.values()) {
    for (const workspace of (Array.isArray(section.workspaces) ? section.workspaces : [])) {
      for (const entry of (Array.isArray(workspace?.entries) ? workspace.entries : [])) {
        if (entry.runtimeId === wanted || entry.id === wanted) {
          return splitRemoteNamespaceId(entry.agentId)?.innerId || null;
        }
      }
    }
  }
  return null;
}

// 目录条目 → 宿主级命名空间 id（如 'remote:server-a:programming-helper'）。
// focusedAgentId 收敛（T21-A）用它把远程运行时引用归并到宿主 agent 身份；
// 非目录条目（本地 id / 未知引用）返回 null，调用方显式失败不猜目标。
function getEntryHostNamespaceId(namespacedId) {
  const wanted = typeof namespacedId === 'string' ? namespacedId : '';
  if (!wanted) return null;
  for (const section of _rcVisibleSections.values()) {
    for (const workspace of (Array.isArray(section.workspaces) ? section.workspaces : [])) {
      for (const entry of (Array.isArray(workspace?.entries) ? workspace.entries : [])) {
        if (entry.runtimeId === wanted || entry.id === wanted) {
          if (typeof entry.agentId === 'string' && entry.agentId) return entry.agentId;
          return null;
        }
      }
    }
  }
  return null;
}

// 目录条目 → 会话标题回退链（sessionTitle → name → 空串）。header 标题回退
// （T21-E）用它兜底远程会话顶部标题；未命中返回空串由调用方继续回退。
function getEntrySessionTitle(namespacedId) {
  const wanted = typeof namespacedId === 'string' ? namespacedId : '';
  if (!wanted) return '';
  for (const section of _rcVisibleSections.values()) {
    for (const workspace of (Array.isArray(section.workspaces) ? section.workspaces : [])) {
      for (const entry of (Array.isArray(workspace?.entries) ? workspace.entries : [])) {
        if (entry.runtimeId === wanted || entry.id === wanted) {
          if (typeof entry.sessionTitle === 'string' && entry.sessionTitle) return entry.sessionTitle;
          if (typeof entry.name === 'string' && entry.name) return entry.name;
          return '';
        }
      }
    }
  }
  return '';
}

// 目录条目 → 命名空间化会话 id（如 'remote:server-a:session-x'，与 aggregator
// 的 namespaceId 产物一致）。仅当为非空字符串时返回，否则空串；调用方以空串
// 视为不可寻址，与远程裸 sessionId 直接比较前需先在服务端还原。
function getEntryRuntimeSessionId(namespacedId) {
  const wanted = typeof namespacedId === 'string' ? namespacedId : '';
  if (!wanted) return '';
  for (const section of _rcVisibleSections.values()) {
    for (const workspace of (Array.isArray(section.workspaces) ? section.workspaces : [])) {
      for (const entry of (Array.isArray(workspace?.entries) ? workspace.entries : [])) {
        if (entry.runtimeId === wanted || entry.id === wanted) {
          if (typeof entry.sessionId === 'string' && entry.sessionId) return entry.sessionId;
          return '';
        }
      }
    }
  }
  return '';
}

function tryRestoreRemoteFocus() {
  if (_rcBootstrapSeen) return;
  _rcBootstrapSeen = true;

  let rememberedId = null;
  try { rememberedId = localStorage.getItem('claw:lastFocusedRuntimeId'); } catch { /* ignore */ }
  if (!isRemoteNamespaceAgentId(rememberedId)) return;

  // 本地恢复算法的第一顺位是 inputRequest；有待处理输入的本地会话不被远程
  // 记忆抢占。
  const hasPendingLocalInput = (Array.isArray(allAgents) ? allAgents : []).some((agent) =>
    agent?.connected !== false && (agent.pending_input_count ?? agent.pendingInputCount ?? 0) > 0);
  if (hasPendingLocalInput) return;

  // 目录尚未能证明该远程条目可达（可能已禁用/断开）→ 维持本地 fallback。
  if (!isRemoteEntryOnline(rememberedId)) return;

  void window.switchAgent(rememberedId).catch((e) => console.warn('[remote-connections] focus restore failed:', e));
}

// ── Sidebar projection ────────────────────────────────────────────────────

// Remote catalog is a data source, not a second sidebar tree. The renderer asks
// for the projection belonging to one local workspace and renders it with the
// same project-group/runtime components as local sessions.
function getRemoteSidebarProjection(workspaceAgentId, sidebarEntryId = workspaceAgentId) {
  const localAgentId = String(workspaceAgentId || '').trim();
  const expectedSidebarEntryId = String(sidebarEntryId || localAgentId).trim();
  if (!localAgentId || !expectedSidebarEntryId) return [];

  const groups = new Map();
  for (const section of _rcVisibleSections.values()) {
    const online = section.status === 'connected';
    for (const workspace of (Array.isArray(section.workspaces) ? section.workspaces : [])) {
      for (const rawEntry of (Array.isArray(workspace?.entries) ? workspace.entries : [])) {
        const remoteOwnerId = splitRemoteNamespaceId(rawEntry.agentId)?.innerId || '';
        if (remoteOwnerId !== localAgentId) continue;
        const runtimeSessionType = String(rawEntry.sessionType || 'main').trim() || 'main';
        const entrySidebarId = String(rawEntry.sidebarEntryId || '').trim()
          || (runtimeSessionType === 'main' ? localAgentId : `${localAgentId}:${runtimeSessionType}`);
        if (entrySidebarId !== expectedSidebarEntryId) continue;

        const projectName = String(workspace.displayName || workspace.projectName || '').trim();
        const projectDir = String(workspace.projectDir || '').trim();
        const groupKey = String(workspace.groupKey || `${section.connectionId}:${projectName}`);
        let group = groups.get(groupKey);
        if (!group) {
          group = { projectName, projectDir, entries: [] };
          groups.set(groupKey, group);
        }
        group.entries.push({
          ...rawEntry,
          ownerId: localAgentId,
          sidebarEntryId: entrySidebarId,
          source: 'remote',
          contextMenuEnabled: false,
          status: online ? 'connected' : 'disconnected',
          ...(projectName ? {
            projectName,
            projectDir,
            projectKey: groupKey,
          } : {}),
          remoteConnectionId: section.connectionId,
          remoteConnectionName: section.name,
        });
      }
    }
  }

  return [...groups.entries()]
    .sort(([, left], [, right]) => String(left.projectName).localeCompare(String(right.projectName), undefined, {
      sensitivity: 'base', numeric: true,
    }))
    .flatMap(([groupKey, group]) => group.entries.map((entry) => ({
      ...entry,
      ...(group.projectName ? {
        projectName: group.projectName,
        projectDir: group.projectDir,
        projectKey: groupKey,
      } : {}),
    })));
}

function getRemoteSidebarProjectionVersion() {
  return _rcSidebarProjectionVersion;
}

// 断开条目点击：capture 阶段提示原因并阻断通用委托的静默 return。
document.addEventListener('click', (event) => {
  const item = event.target.closest('.agent-item.remote-entry-disabled');
  if (!item) return;
  window.ClawToast?.show?.({
    id: `remote-entry-disabled-${item.dataset.agentId}`,
    status: 'warning',
    title: t('rcon_state_disconnected'),
    description: t('rcon_entry_disabled_hint'),
  });
}, true);

// ── Connection manager panel ──────────────────────────────────────────────

let _rcManagerEl = null;
let _rcManagerEditingId = null;

function ensureManagerDom() {
  if (_rcManagerEl) return _rcManagerEl;
  const root = document.createElement('div');
  root.className = 'rcm-overlay';
  root.innerHTML = `
    <div class="rcm-modal" role="dialog" aria-modal="true">
      <div class="rcm-head">
        <div>
          <h3>${escapeHtml(t('rcon_mgr_title'))}</h3>
          <p class="rcm-subtitle">${escapeHtml(t('rcon_mgr_subtitle'))}</p>
        </div>
        <button type="button" class="rcm-close" title="ESC">&times;</button>
      </div>
      <div class="rcm-body">
        <div class="rcm-list-head">
          <button type="button" class="rcm-btn primary" data-action="add">${escapeHtml(t('rcon_mgr_add'))}</button>
          <button type="button" class="rcm-btn" data-action="refresh">${escapeHtml(t('rcon_mgr_refresh'))}</button>
        </div>
        <div class="rcm-list"></div>
        <form class="rcm-form" style="display:none;"></form>
      </div>
    </div>
  `;
  document.body.appendChild(root);
  _rcManagerEl = root;

  root.querySelector('.rcm-close').addEventListener('click', closeRemoteConnectionsManager);
  root.addEventListener('click', (event) => {
    if (event.target === root) closeRemoteConnectionsManager();
  });
  root.querySelector('.rcm-list-head').addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'add') showManagerForm(null);
    if (action === 'refresh') await reloadManagerData();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeRemoteConnectionsManager();
  });
  // 列表条目动作（edit/delete/handshake/toggle-enabled）走事件委托：
  // .rcm-list 元素跨 reloadManagerData 的 innerHTML 重建保持不变，绑定一次即可。
  bindManagerListEvents(root);
  return root;
}

function closeRemoteConnectionsManager() {
  if (!_rcManagerEl) return;
  _rcManagerEl.remove();
  _rcManagerEl = null;
  _rcManagerEditingId = null;
}

function openRemoteConnectionsManager() {
  const root = ensureManagerDom();
  root.style.display = '';
  hideManagerForm();
  void reloadManagerData();
}

function hideManagerForm() {
  if (_rcManagerEl) _rcManagerEl.querySelector('.rcm-form').style.display = 'none';
}

function showManagerForm(record) {
  const form = _rcManagerEl.querySelector('.rcm-form');
  _rcManagerEditingId = record?.id || null;
  const mode = record?.mode || 'manual';
  form.innerHTML = `
    <div class="rcm-form-grid">
      <label>${escapeHtml(t('rcon_field_name'))}<input name="name" required value="${escapeHtml(record?.name || '')}"></label>
      <label>${escapeHtml(t('rcon_field_conn_id'))}<input name="id" value="${escapeHtml(record?.id || '')}" ${record?.id ? 'disabled' : ''}></label>
      <label class="rcm-inline-check"><input type="checkbox" name="enabled" ${record?.enabled === false ? '' : 'checked'}>
        <span>${escapeHtml(t('rcon_field_enabled'))}</span></label>
      <label>${escapeHtml(t('rcon_field_mode'))}
        <select name="mode">
          <option value="url" ${mode === 'url' ? 'selected' : ''}>${escapeHtml(t('rcon_mode_url'))}</option>
          <option value="manual" ${mode === 'manual' ? 'selected' : ''}>${escapeHtml(t('rcon_mode_manual'))}</option>
          <option value="managed" ${mode === 'managed' ? 'selected' : ''}>${escapeHtml(t('rcon_mode_managed'))}</option>
        </select>
      </label>
      <label class="rcm-url-field">${escapeHtml(t('rcon_field_base_url'))}<input name="baseUrl" type="url" placeholder="https://claw.example.com" value="${escapeHtml(record?.baseUrl || '')}"></label>
      <label class="rcm-local-port-field">${escapeHtml(t('rcon_field_local_port'))}<input name="localPort" type="number" min="1" max="65535" value="${escapeHtml(String(record?.localPort ?? ''))}"></label>
      <label class="rcm-auth-field">${escapeHtml(t('rcon_field_auth_password'))}<input name="authPassword" type="password" autocomplete="new-password" placeholder="${escapeHtml(record?.auth?.configured ? t('rcon_field_auth_keep') : t('rcon_field_auth_hint'))}"></label>
    </div>
    <fieldset class="rcm-managed-fields">
      <legend>${escapeHtml(t('rcon_mode_managed'))}</legend>
      <div class="rcm-form-grid">
        <label>${escapeHtml(t('rcon_field_ssh_host'))}<input name="sshHost" value="${escapeHtml(record?.ssh?.host || '')}"></label>
        <label>${escapeHtml(t('rcon_field_ssh_user'))}<input name="sshUser" value="${escapeHtml(record?.ssh?.user || '')}"></label>
        <label>${escapeHtml(t('rcon_field_ssh_port'))}<input name="sshPort" type="number" min="1" max="65535" value="${escapeHtml(String(record?.ssh?.port ?? ''))}"></label>
        <label>${escapeHtml(t('rcon_field_host_alias'))}<input name="hostAlias" value="${escapeHtml(record?.ssh?.hostAlias || '')}"></label>
        <label>${escapeHtml(t('rcon_field_app_port'))}<input name="appPort" type="number" min="1" max="65535" value="${escapeHtml(String(record?.remote?.appPort ?? ''))}"></label>
      </div>
    </fieldset>
    <div class="rcm-url-hint"><strong>${escapeHtml(t('rcon_url_hint_title'))}</strong><span>${escapeHtml(t('rcon_url_hint_body'))}</span></div>
    <div class="rcm-manual-hint"><strong>${escapeHtml(t('rcon_mgr_manual_hint_title'))}</strong><span>${escapeHtml(t('rcon_mgr_manual_hint_body'))}</span></div>
    <div class="rcm-form-error" style="display:none;"></div>
    <div class="rcm-form-actions">
      <button type="submit" class="rcm-btn primary">${escapeHtml(t('rcon_mgr_save'))}</button>
      <button type="button" class="rcm-btn" data-action="cancel">${escapeHtml(t('rcon_mgr_cancel'))}</button>
    </div>
  `;
  form.style.display = '';
  const syncModeVisibility = () => {
    const value = form.elements.mode.value;
    form.querySelector('.rcm-managed-fields').style.display = value === 'managed' ? '' : 'none';
    form.querySelector('.rcm-url-field').style.display = value === 'url' ? '' : 'none';
    form.querySelector('.rcm-local-port-field').style.display = value === 'url' ? 'none' : '';
    form.querySelector('.rcm-url-hint').style.display = value === 'url' ? '' : 'none';
    form.querySelector('.rcm-manual-hint').style.display = value === 'manual' ? '' : 'none';
  };
  syncModeVisibility();
  form.elements.mode.addEventListener('change', syncModeVisibility);
  form.querySelector('[data-action="cancel"]').addEventListener('click', hideManagerForm);
  form.onsubmit = (event) => submitManagerForm(event, form);
}

function readOptionalInt(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
}

async function submitManagerForm(event, form) {
  event.preventDefault();
  const errorBox = form.querySelector('.rcm-form-error');
  errorBox.style.display = 'none';

  const idField = form.elements.id.value.trim();
  const editingId = _rcManagerEditingId;
  const name = form.elements.name.value.trim();
  const mode = form.elements.mode.value;
  const enabled = form.elements.enabled.checked;
  const payload = { name, enabled, mode };

  if (!editingId) {
    if (!name) return reportManagerError(errorBox, t('rcon_mgr_error_name_required'));
    if (!idField) return reportManagerError(errorBox, t('rcon_mgr_error_id_required'));
    payload.id = idField;
  }

  // 访问密码：填写则更新；编辑时留空 = 不提交 auth 字段 = 服务端保持现有密码。
  const authPassword = form.elements.authPassword.value;
  if (authPassword) payload.auth = { password: authPassword };

  if (mode === 'url') {
    const baseUrl = form.elements.baseUrl.value.trim().replace(/\/+$/, '');
    if (!baseUrl) return reportManagerError(errorBox, t('rcon_mgr_error_base_url_required'));
    if (!/^https?:\/\//i.test(baseUrl)) {
      return reportManagerError(errorBox, t('rcon_mgr_error_base_url_invalid'));
    }
    payload.baseUrl = baseUrl;
  } else {
    const localPort = readOptionalInt(form.elements.localPort.value);
    // localPort 是本地回环转发/探测入口，隧道模式下必填
    if (localPort === undefined || Number.isNaN(localPort)) {
      return reportManagerError(errorBox, t('rcon_mgr_error_port_required'));
    }
    payload.localPort = localPort;

    if (mode === 'managed') {
      const host = form.elements.sshHost.value.trim();
      if (!host) return reportManagerError(errorBox, t('rcon_mgr_error_ssh_host'));
      const port = readOptionalInt(form.elements.sshPort.value);
      if (Number.isNaN(port)) return reportManagerError(errorBox, t('rcon_mgr_error_port_invalid'));
      const appPort = readOptionalInt(form.elements.appPort.value);
      if (Number.isNaN(appPort)) return reportManagerError(errorBox, t('rcon_mgr_error_port_invalid'));
      payload.ssh = {
        host,
        user: form.elements.sshUser.value.trim(),
        ...(Number.isInteger(port) ? { port } : {}),
        ...(form.elements.hostAlias.value.trim() ? { hostAlias: form.elements.hostAlias.value.trim() } : {}),
      };
      payload.remote = { ...(Number.isInteger(appPort) ? { appPort } : {}) };
    }
  }

  try {
    const res = await fetch('/protoclaw/remote_connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editingId ? { ...payload, id: editingId } : payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
    }
    hideManagerForm();
    await reloadManagerData();
    void refreshRemoteCatalog();
  } catch (error) {
    reportManagerError(errorBox, error.message);
  }
}

function reportManagerError(box, message) {
  box.textContent = message;
  box.style.display = '';
}

async function deleteRemoteConnection(connId, button) {
  if (!button.dataset.armed) {
    button.dataset.armed = 'true';
    button.textContent = t('rcon_mgr_delete_confirm');
    setTimeout(() => { delete button.dataset.armed; }, 4000);
    return;
  }
  try {
    const res = await fetch(`/protoclaw/remote_connections/${encodeURIComponent(connId)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    _rcMemoryByConnection.delete(connId);
    await reloadManagerData();
    void refreshRemoteCatalog();
  } catch (error) {
    console.warn('[remote-connections] delete failed:', error.message);
  }
}

function tunnelDiagHtml(connId, tunnels) {
  const tunnel = tunnels?.[connId];
  if (!tunnel) return '';
  const lines = Array.isArray(tunnel.stderrTail) ? tunnel.stderrTail.slice(-8) : [];
  return `
    <details class="rcm-tunnel-diag">
      <summary><span class="remote-tunnel-badge remote-tunnel-${escapeHtml(tunnel.tunnel || 'stopped')}">
        ${escapeHtml(t(`rcon_tunnel_${tunnel.tunnel}`))}
      </span> ${escapeHtml(t('rcon_mgr_tunnel_diag'))}</summary>
      ${lines.length > 0 ? `<pre>${escapeHtml(lines.join('\n'))}</pre>` : `<pre>${escapeHtml(currentLanguage === 'zh' ? '暂无诊断输出' : 'No diagnostic output')}</pre>`}
    </details>
  `;
}

function modeLabel(mode) {
  return t(mode === 'managed' ? 'rcon_mode_managed' : mode === 'url' ? 'rcon_mode_url' : 'rcon_mode_manual');
}

function managerItemHtml(connection, status, tunnels) {
  const connId = connection.id;
  const state = status?.state || 'configured';
  const appInfo = status?.appInfo;
  const handshakeInfo = appInfo
    ? `Claw ${escapeHtml(appInfo.clawVersion || '?')} · framework ${escapeHtml(appInfo.frameworkVersion || '?')}`
    : escapeHtml(t('rcon_mgr_no_handshake'));
  const versionWarning = status?.versionWarning
    ? `<div class="rcm-version-warn" title="${escapeHtml(status.versionWarning.message || '')}">
         ⚠ ${escapeHtml(t('rcon_mgr_version_warn'))}${status.versionWarning.message ? ` — ${escapeHtml(status.versionWarning.message)}` : ''}
       </div>`
    : '';
  const addressInfo = connection.mode === 'url'
    ? ` · <code>${escapeHtml(connection.baseUrl || '')}</code>`
    : '';
  return `
    <div class="rcm-item" data-conn-id="${escapeHtml(connId)}">
      <div class="rcm-item-main">
        <div class="rcm-item-title">
          <strong>${escapeHtml(connection.name)}</strong>
          <span class="remote-status-badge ${rcStatusClass(state)}">${escapeHtml(t(`rcon_state_${state}`))}</span>
          <label class="rcm-inline-check" title="${escapeHtml(t('rcon_field_enabled'))}">
            <input type="checkbox" data-action="toggle-enabled" ${connection.enabled !== false ? 'checked' : ''}>
          </label>
        </div>
        <div class="rcm-item-meta">
          <code>${escapeHtml(connId)}</code> · ${escapeHtml(modeLabel(connection.mode))}${addressInfo}
          · ${handshakeInfo}${connection.auth?.configured ? ` · ${escapeHtml(t('rcon_auth_configured'))}` : ''}
        </div>
        ${versionWarning}
        ${connection.mode === 'managed' ? tunnelDiagHtml(connId, tunnels) : ''}
      </div>
      <div class="rcm-item-actions">
        <button type="button" class="rcm-btn" data-action="edit">${escapeHtml(t('rcon_mgr_edit'))}</button>
        <button type="button" class="rcm-btn" data-action="handshake">${escapeHtml(t('rcon_mgr_handshake'))}</button>
        <button type="button" class="rcm-btn danger" data-action="delete">${escapeHtml(t('rcon_mgr_delete'))}</button>
      </div>
    </div>
  `;
}

function applyRecordShapeForEdit(connection) {
  // server 端存储形如 { id,name,enabled,mode,localPort,ssh:{...},remote:{...} }
  // 前端表单展示需要逐字段平铺的映射；auth 只回传 configured 标记，不回显明文。
  return {
    ...connection,
    ssh: connection.ssh || {},
    remote: connection.remote || {},
    auth: connection.auth || {},
  };
}

function bindManagerListEvents(root) {
  const list = root.querySelector('.rcm-list');
  list.addEventListener('click', async (event) => {
    const item = event.target.closest('.rcm-item');
    if (!item) return;
    const connId = item.dataset.connId;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'delete') {
      await deleteRemoteConnection(connId, event.target.closest('[data-action]'));
      return;
    }
    const record = (item.__record || {});
    if (action === 'edit') showManagerForm(applyRecordShapeForEdit(record));
    if (action === 'handshake') {
      try {
        const res = await fetch(`/protoclaw/remote_connections/${encodeURIComponent(connId)}/handshake`, { method: 'POST' });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
        await reloadManagerData();
      } catch (error) {
        window.ClawToast?.show?.({
          id: `remote-handshake-failed-${connId}`,
          status: 'warning',
          title: t('rcon_mgr_handshake'),
          description: error.message,
        });
      }
    }
  });
  list.addEventListener('change', async (event) => {
    if (event.target.dataset.action !== 'toggle-enabled') return;
    const item = event.target.closest('.rcm-item');
    if (!item) return;
    const record = item.__record || {};
    try {
      const res = await fetch('/protoclaw/remote_connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...applyRecordShapeForEdit(record), enabled: event.target.checked }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
      await reloadManagerData();
      void refreshRemoteCatalog();
    } catch (error) {
      event.target.checked = !event.target.checked;
      window.ClawToast?.show?.({
        id: `remote-toggle-failed-${item.dataset.connId}`,
        status: 'warning',
        title: record.name || item.dataset.connId,
        description: error.message,
      });
    }
  });
}

async function reloadManagerData() {
  if (!_rcManagerEl) return;
  const list = _rcManagerEl.querySelector('.rcm-list');
  try {
    const res = await fetch('/protoclaw/remote_connections');
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(data?.message || `HTTP ${res.status}`);
    const statuses = new Map((data.statuses || []).map((s) => [s.id, s]));
    const tunnels = data.tunnels || {};
    const records = Array.isArray(data.connections) ? data.connections : [];

    if (records.length === 0) {
      list.innerHTML = `<div class="rcm-empty">${escapeHtml(t('rcon_mgr_empty'))}</div>`;
      return;
    }
    list.innerHTML = records.map((record) =>
      managerItemHtml(record, statuses.get(record.id), tunnels)
    ).join('');
    for (const el of list.querySelectorAll('.rcm-item')) {
      const match = records.find((r) => r.id === el.dataset.connId);
      if (match) el.__record = match;
    }
    // 连接全集同步：供 catalog 缓存判定「删除 vs 仅 disabled」。
    _rcAllConnectionIds = new Set(records.map((r) => r.id));
  } catch (error) {
    list.innerHTML = `<div class="rcm-empty">${escapeHtml(currentLanguage === 'zh' ? '加载失败：' : 'Failed to load: ')}${escapeHtml(error.message)}</div>`;
  }
}

window.RemoteConnections = {
  refresh: refreshRemoteCatalog,
  openManager: openRemoteConnectionsManager,
  resolveRuntimeRef,
  getEntryHostAgentId,
  getEntryHostNamespaceId,
  getEntrySessionTitle,
  getEntryRuntimeSessionId,
  isRemoteWriteEnabled,
};
