/**
 * slash-menu.js — Slash 命令菜单
 *
 * 独立 UI 组件，与 user input 输入框解耦：
 * - 触发源是任一 .user-input-textarea（idle 主输入区 input-<requestId> 与
 *   运行中常驻条 #input-persistent 皆可）：内容以 / 开头时浮层出现
 *   （document 级 capture 监听，只读 value，不修改输入模块任何行为；
 *   移除本模块系统照常工作）
 * - 键盘归属规则：菜单有可选项时 Enter/↑/↓/Tab/Esc 归菜单（capture 拦截，
 *   Enter = 执行 + 消费整条输入），空态或关闭时键盘归输入框 —— / 开头的
 *   文本此时作为普通消息正常发送，发送路径对 slash 零感知
 * - 命令执行是控制动作（调用 handler / 投递 capability），绝不构造
 *   user-turn 消息
 *
 * 命令条目结构：{ name, title?, description?, destination?: 'host'|'session', handler?, parameters? }
 * - host：前端本地执行（handler）
 * - session：转发到当前会话 runtime 的 capability registry
 *   （POST /protoclaw/capability_invoke；parameters 为
 *   FeatureManifestSettingProperty 形状，触发参数表单）
 *
 * 动态清单：菜单唤起时按当前 (runtimeAgent, session) 拉取一次
 * GET /protoclaw/commands（拉取式，无缓存订阅）。会话命令以完整
 * ref（feature.command）展示与调用；过滤同时匹配全名与末段短名。
 *
 * 暴露：
 * - SlashMenu.isActive() — 菜单激活（可见且有可选项）
 * - SlashMenu.registerCommands(list) — 注册宿主域命令条目
 *
 * 依赖（全局，由 app-core.js / 既有模块提供）：
 * - t, escapeHtml, currentLanguage (app-core.js / i18n.js)
 * - autoResize (input-helpers.js)、_cacheSessionInput (voice-input.js)
 * - currentRuntimeAgentId、getRuntimeId、getLogicalAgentId、
 *   getRuntimeWorkspaceSessionId (app-core.js)
 * - getCurrentRuntimeRecord、getCurrentAgentRecord (app-main.js)
 * - window.ClawToast (toast 组件)
 */

// ── 模块局部状态（app-core 全局状态纪律：状态放所属模块局部）──
let _hostCommands = [];
let _sessionCommands = [];
let _filtered = [];
let _highlightIdx = 0;
let _visible = false;
let _menuEl = null;
// 当前触发菜单的输入框（两类：#input-persistent 常驻条 / input-<requestId> 主输入区，
// 共同特征 class user-input-textarea）。定位、执行消费、键盘归属都跟随它
let _activeTa = null;
// 参数表单态：非 null 时菜单内容为该命令的参数表单
let _formCmd = null;
let _dirtyKeys = new Set();
// 动态清单拉取去重键（agentId::sessionId），菜单每次从隐藏转可见时重拉
let _lastFetchKey = null;
// prompt 型命令的待发 pill（激活暂存）：选中不执行，发送 Enter 时统一
// invoke（成功后命令短名并入消息文本原样发出，注入由 feature 在 CallStart 完成）。
// 触发由该状态驱动，不做字符串解析；输入框切换/会话切换时清空（防跨会话误投）
let _pendingPrompts = [];

function _isInputTextarea(el) {
  return !!(el && el.tagName === 'TEXTAREA' && el.classList.contains('user-input-textarea'));
}

function _currentTa() {
  // detached（输入区随会话切换重建）时回退到常驻条
  if (_activeTa && _activeTa.isConnected) return _activeTa;
  return document.getElementById('input-persistent');
}

function _allCommands() {
  return _hostCommands.concat(_sessionCommands);
}

// ── 动态清单拉取（拉取式：唤起时取一次）────────────────────────

function _currentTarget() {
  // 控制投递三元组，对齐 todo_control 先例（todo-plan.js sendTodoControl）：
  // - runtimeId 是主定位 id（与轮询数据源 /api/agents/:id 同空间），
  //   currentRuntimeAgentId 同步设置、无 await 窗口，是唯一可靠的 stale 基准
  // - agentId 是 workspace 逻辑 id，从 runtime 反查 agent record 提取，
  //   不从页面焦点（focusedAgentId）猜测
  // - sessionId 从 runtime 的 viewer 绑定派生（代表用户正在查看的会话），
  //   allAgents 缓存派生值只在无绑定时兜底
  const runtimeId = getRuntimeId(currentRuntimeAgentId)
    || (typeof currentRuntimeAgentId === 'string' ? currentRuntimeAgentId : '');
  if (!runtimeId) return { agentId: '', runtimeId: '', sessionId: '' };
  const record = (typeof getCurrentRuntimeRecord === 'function' && getCurrentRuntimeRecord())
    || (typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null);
  const agentId = (record ? getLogicalAgentId(record) : '') || '';
  const sessionId = getRuntimeWorkspaceSessionId(runtimeId) || '';
  return { agentId, runtimeId, sessionId };
}

function _maybeFetchSessionCommands() {
  const { agentId, runtimeId, sessionId } = _currentTarget();
  if (!runtimeId || !sessionId) return;
  const key = agentId + '::' + runtimeId + '::' + sessionId;
  if (_lastFetchKey === key) return;
  _lastFetchKey = key;
  const url = '/protoclaw/commands?agentId=' + encodeURIComponent(agentId)
    + '&runtimeId=' + encodeURIComponent(runtimeId)
    + '&sessionId=' + encodeURIComponent(sessionId);
  fetch(url).then(function (res) { return res.ok ? res.json() : null; }).then(function (data) {
    if (!data || data.ok !== true) return;
    const list = Array.isArray(data.commands) ? data.commands : [];
    _sessionCommands = list.filter(function (c) {
      return c && typeof c.name === 'string' && c.name;
    }).map(function (c) {
      return {
        // 寻址用完整 ref（registry 的 ref 字段，feature.command）；
        // 裸 name（如 configure）不唯一，invoke 会 not_found
        name: c.ref || c.name,
        title: c.title || '',
        description: c.description || '',
        destination: 'session',
        kind: c.kind === 'prompt' ? 'prompt' : 'invoke',
        parameters: c.parameters && typeof c.parameters === 'object' ? c.parameters : undefined,
        currentValues: c.currentValues && typeof c.currentValues === 'object' ? c.currentValues : undefined,
      };
    });
    if (_visible && !_formCmd) {
      const ta = _currentTa();
      if (ta) _syncFromInput(ta);
    }
  }).catch(function () {
    // 拉取失败仅意味着本次会话命令缺席，宿主命令仍可用；下次唤起重试
    _lastFetchKey = null;
  });
}

// ── 浮层 DOM（懒创建，挂 body，不嵌入输入卡结构）────────────────

function _ensureMenuEl() {
  if (_menuEl) return _menuEl;
  _menuEl = document.createElement('div');
  _menuEl.className = 'slash-menu';
  _menuEl.style.display = 'none';
  _menuEl.setAttribute('role', 'listbox');
  document.body.appendChild(_menuEl);

  // mousedown + preventDefault 抢在 textarea blur 之前，点击项时焦点不丢
  _menuEl.addEventListener('mousedown', function (e) {
    if (_formCmd) {
      // 表单态：阻止 mousedown 默认行为会破坏 select 展开与文本选择，
      // 只拦截提交/取消按钮
      const btn = e.target.closest('.slash-form-btn');
      if (!btn) return;
      e.preventDefault();
      if (btn.dataset.action === 'submit') void _submitForm();
      else _cancelForm();
      return;
    }
    const item = e.target.closest('.slash-menu-item');
    if (!item) return;
    e.preventDefault();
    const cmd = _filtered[parseInt(item.dataset.idx, 10)];
    void _execute(cmd, _currentTa());
  });
  // 表单交互（委托，挂载一次）：dirty 跟踪 / showWhen 重评估 / 滑条数值读数
  _menuEl.addEventListener('input', function (e) {
    if (!_formCmd) return;
    const key = e.target?.dataset?.key;
    if (key) _dirtyKeys.add(key);
    if (e.target && e.target.type === 'range') {
      _paintRange(e.target);
      const out = e.target.parentElement?.querySelector('.slash-form-range-val');
      if (out) out.textContent = e.target.value;
    }
  }, true);
  _menuEl.addEventListener('change', function (e) {
    if (!_formCmd) return;
    const key = e.target?.dataset?.key;
    if (key) _dirtyKeys.add(key);
    if (e.target && (e.target.tagName === 'SELECT' || e.target.type === 'checkbox' || e.target.type === 'range')) {
      _applyShowWhen();
    }
  }, true);
  return _menuEl;
}

function _render() {
  const menu = _ensureMenuEl();
  menu.classList.toggle('is-form', _formCmd !== null);
  if (_formCmd) {
    _renderForm(menu);
  } else if (_filtered.length === 0) {
    menu.innerHTML = '<div class="slash-menu-empty">' + escapeHtml(t('slash_menu_empty')) + '</div>';
  } else {
    menu.innerHTML = _filtered.map(function (cmd, i) {
      const active = i === _highlightIdx ? ' is-active' : '';
      return '<div class="slash-menu-item' + active + '" data-idx="' + i + '" role="option">' +
        '<span class="slash-menu-item-name">/' + escapeHtml(cmd.name) + '</span>' +
        (cmd.description ? '<span class="slash-menu-item-desc">' + escapeHtml(cmd.description) + '</span>' : '') +
        '</div>';
    }).join('');
  }
  _position();
}

function _position() {
  const ta = _currentTa();
  if (!ta) {
    _hide();
    return;
  }
  const rect = ta.getBoundingClientRect();
  const vw = window.innerWidth;
  // 宽度外部定义：输入框宽 - 两侧收进（相对输入框居中、略窄），不随内容撑开
  const inset = 20;
  let width = Math.round(rect.width - inset * 2);
  const minW = Math.min(240, vw - 24);
  if (width < minW) width = minW;
  let left = Math.round(rect.left + inset);
  if (left + width > vw - 12) left = Math.max(12, vw - 12 - width);
  _menuEl.style.left = left + 'px';
  _menuEl.style.width = width + 'px';
  _menuEl.style.top = 'auto';
  _menuEl.style.bottom = Math.round(window.innerHeight - rect.top + 8) + 'px';
  // 高度上限 = 输入框上方可用空间：底部锚定 + maxHeight，表单永不向下侵入输入框
  const avail = Math.round(rect.top) - 24;
  _menuEl.style.maxHeight = Math.min(480, Math.max(160, avail)) + 'px';
}

function _show() {
  _visible = true;
  const menu = _ensureMenuEl();
  menu.style.display = '';
  _maybeFetchSessionCommands();
  _render();
}

function _hide() {
  _visible = false;
  _formCmd = null;
  if (_menuEl) _menuEl.style.display = 'none';
}

// ── 过滤与执行 ────────────────────────────────────────────────

function _matches(cmd, query) {
  const full = cmd.name.toLowerCase();
  if (full.startsWith(query)) return true;
  // 末段短名（ref 去掉 feature 前缀）也参与前缀匹配，/force 命中 force-continuation.continue
  const tail = full.slice(full.lastIndexOf('.') + 1);
  return tail.startsWith(query);
}

function _syncFromInput(ta) {
  if (!_isInputTextarea(ta)) {
    if (_visible) _hide();
    return;
  }
  // 输入框归属变化（idle↔常驻条切换 / 会话重建）：prompt pill 不跨输入框
  // 迁移——invoke 目标是"输入框所属会话"，换了框旧 pill 语义失效
  if (_activeTa && _activeTa !== ta) _clearPrompts();
  _activeTa = ta;
  const value = ta.value;
  if (typeof value !== 'string' || !value.startsWith('/')) {
    if (_visible) _hide();
    return;
  }
  // 命令名 = 首个空白前的部分；/ 后直接空格视为浏览全部
  const query = value.slice(1).split(/\s+/)[0].toLowerCase();
  _filtered = _allCommands().filter(function (c) {
    return _matches(c, query);
  });
  _highlightIdx = 0;
  _formCmd = null;
  _show();
}

async function _execute(cmd, ta) {
  if (!cmd) return;
  // prompt 型：选中不执行——挂 pill，用户补充说明后随 Enter 发送时统一触发
  if (cmd.kind === 'prompt' && cmd.destination === 'session') {
    if (ta) {
      ta.value = '';
      autoResize(ta);
      _cacheSessionInput(ta);
    }
    if (!_pendingPrompts.some(function (p) { return p.name === cmd.name; })) {
      _pendingPrompts.push(cmd);
    }
    _hide();
    _renderPillBar();
    ta?.focus();
    return;
  }
  // 消费语义：命令执行吃掉整条输入（含同步草稿缓存，防切换会话后复活）
  if (ta) {
    ta.value = '';
    autoResize(ta);
    _cacheSessionInput(ta);
  }
  if (cmd.destination === 'session') {
    if (cmd.parameters && Object.keys(cmd.parameters).length > 0) {
      _formCmd = cmd;
      _render();
      _focusFirstField();
      return;
    }
    await _invokeSessionCommand(cmd, {});
    _hide();
    return;
  }
  _hide();
  try {
    if (typeof cmd.handler === 'function') await cmd.handler();
  } catch (e) {
    console.error('[SlashMenu] command failed:', cmd.name, e);
    window.ClawToast?.show?.({
      id: 'slash-command-failed',
      status: 'error',
      title: currentLanguage === 'zh' ? '命令执行失败' : 'Command failed',
      description: e instanceof Error ? e.message : String(e),
      autoDismiss: 6000,
    });
  }
}

function _completeCommand(ta) {
  const cmd = _filtered[_highlightIdx];
  if (!cmd || !ta) return;
  ta.value = '/' + cmd.name + ' ';
  autoResize(ta);
  _syncFromInput(ta);
}

// ── 会话命令投递（capability registry 传输面消费端）─────────────

// 底层 invoke（无 UI 副作用）：成功返回 {ok:true,result}，失败 {ok:false,error}
async function _postCapabilityInvoke(cmd, args) {
  const { agentId, runtimeId, sessionId } = _currentTarget();
  if (!runtimeId || !sessionId) {
    return { ok: false, error: currentLanguage === 'zh' ? '无可用会话' : 'No active session' };
  }
  try {
    const res = await fetch('/protoclaw/capability_invoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: cmd.name, args, agentId, runtimeId, sessionId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      return { ok: false, error: (data && data.error) || ('HTTP ' + res.status) };
    }
    return { ok: true, result: data.result, target: { agentId, runtimeId, sessionId } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function _invokeSessionCommand(cmd, args) {
  const r = await _postCapabilityInvoke(cmd, args);
  if (!r.ok) {
    console.error('[SlashMenu] capability invoke failed:', cmd.name, r.error);
    window.ClawToast?.show?.({
      id: 'slash-capability-failed',
      status: 'error',
      title: currentLanguage === 'zh' ? '命令执行失败' : 'Command failed',
      description: r.error + ' — ' + cmd.name,
      autoDismiss: 6000,
    });
    return;
  }
  window.ClawToast?.show?.({
    id: 'slash-capability-ok',
    status: 'success',
    title: currentLanguage === 'zh' ? '命令已执行' : 'Command executed',
    description: cmd.name,
    autoDismiss: 3500,
  });
  // 广播事实（不含结果语义）：关心该 capability 的面板（如会话控制）
  // 自行决定刷新。Slash 菜单保持邮差定位，不认识具体 feature。
  window.dispatchEvent(new CustomEvent('claw:capability-invoked', {
    detail: { ref: cmd.name, ...r.target },
  }));
  if (typeof window._scheduleInspectorRefresh === 'function') window._scheduleInspectorRefresh(120);
}

// ── prompt pill（激活暂存条）────────────────────────────────────

function _shortName(cmd) {
  const full = cmd.name || '';
  return full.slice(full.lastIndexOf('.') + 1);
}

function _clearPrompts() {
  _pendingPrompts = [];
  const bar = document.getElementById('slash-prompt-bar');
  if (bar) bar.remove();
}

function _renderPillBar() {
  const ta = _currentTa();
  if (!ta || _pendingPrompts.length === 0) {
    _clearPrompts();
    return;
  }
  let bar = document.getElementById('slash-prompt-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'slash-prompt-bar';
    bar.className = 'slash-prompt-bar';
    // 挂在 textarea 紧前（两类输入框同构：textarea 都在
    // .persistent-input-textarea-area 内），不嵌入输入模块逻辑
    ta.parentNode.insertBefore(bar, ta);
  } else if (bar.parentNode !== ta.parentNode) {
    ta.parentNode.insertBefore(bar, ta);
  }
  bar.innerHTML = _pendingPrompts.map(function (cmd, i) {
    const nm = escapeHtml(_shortName(cmd));
    const desc = cmd.description ? ' title="' + escapeHtml(cmd.description) + '"' : '';
    return '<span class="slash-prompt-pill"' + desc + '>'
      + '<span class="slash-prompt-pill-name">/' + nm + '</span>'
      + '<button type="button" class="slash-prompt-pill-x" data-idx="' + i + '"'
      + ' title="' + escapeHtml(t('slash_pill_remove')) + '">×</button>'
      + '</span>';
  }).join('');
}

// 发送时统一触发：逐个 invoke（全部成功才发消息；任一失败 pill 保留供重试）。
// 消息文本 = 各 pill 短名前缀 + 用户补充说明，作为普通 user 消息原样发出
async function _dispatchPrompts(ta) {
  const pills = _pendingPrompts.slice();
  const rest = (typeof ta.value === 'string' ? ta.value : '').trim();
  for (const cmd of pills) {
    const r = await _postCapabilityInvoke(cmd, {});
    if (!r.ok) {
      window.ClawToast?.show?.({
        id: 'slash-prompt-failed',
        status: 'error',
        title: currentLanguage === 'zh' ? '技能激活失败，消息未发送' : 'Skill activation failed, message not sent',
        description: r.error + ' — ' + cmd.name,
        autoDismiss: 6000,
      });
      return;
    }
  }
  const prefix = pills.map(function (c) { return '/' + _shortName(c); }).join(' ');
  ta.value = prefix + (rest ? ' ' + rest : '');
  autoResize(ta);
  _clearPrompts();
  // 合成 Enter 走原生发送路径（此刻 pill 已清、菜单已关，capture 放行）
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

// ── 参数表单（FeatureManifestSettingProperty 渲染）───────────────

function _fieldId(key) {
  return 'slash-param-' + key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// 滑条"已填充"轨道（accent → 当前值，其余为轨道底色），webkit 无
// range-progress 伪元素，用居中 4px 渐变条统一实现
function _paintRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max);
  const span = max - min;
  const pct = span > 0 ? Math.min(100, Math.max(0, ((Number(el.value) - min) / span) * 100)) : 0;
  const accent = 'var(--accent-color, #5b8def)';
  const track = 'var(--border-color, rgba(255, 255, 255, 0.14))';
  el.style.background = 'linear-gradient(to right, ' + accent + ' 0%, ' + accent + ' ' + pct + '%, '
    + track + ' ' + pct + '%, ' + track + ' 100%)';
  el.style.backgroundSize = '100% 4px';
  el.style.backgroundPosition = 'center';
  el.style.backgroundRepeat = 'no-repeat';
}

function _renderFieldHtml(key, prop, initial) {
  const id = _fieldId(key);
  const title = escapeHtml(prop.title || key);
  // 回显优先级：capability 当前生效值 > 声明 default
  const init = initial !== undefined && initial !== null ? initial : prop.default;
  const initStr = init !== undefined && init !== null ? String(init) : '';
  const keyAttr = ' id="' + id + '" data-key="' + escapeHtml(key) + '"';
  let control = '';
  if (prop.type === 'boolean') {
    control = '<input type="checkbox" class="slash-form-checkbox"' + keyAttr
      + (init === true ? ' checked' : '') + '>';
  } else if (prop.type === 'select' && Array.isArray(prop.options) && prop.options.length > 0) {
    control = '<select class="slash-form-select"' + keyAttr + '>'
      + prop.options.map(function (opt) {
        const v = String(opt.value);
        const sel = initStr === v ? ' selected' : '';
        return '<option value="' + escapeHtml(v) + '"' + sel + '>'
          + escapeHtml(opt.label || v) + '</option>';
      }).join('') + '</select>';
  } else if (prop.type === 'number' && typeof prop.min === 'number' && typeof prop.max === 'number') {
    // 有界数值（音量/上限类配置）→ 滑条 + 右侧数值读数
    const step = typeof prop.step === 'number' ? prop.step : 1;
    control = '<input type="range" class="slash-form-range"' + keyAttr
      + ' min="' + prop.min + '" max="' + prop.max + '" step="' + step + '"'
      + (initStr !== '' ? ' value="' + escapeHtml(initStr) + '"' : '') + '>'
      + '<span class="slash-form-range-val">' + escapeHtml(initStr !== '' ? initStr : String(prop.min)) + '</span>';
  } else if (prop.type === 'number') {
    control = '<input type="number" class="slash-form-input"' + keyAttr
      + (initStr !== '' ? ' value="' + escapeHtml(initStr) + '"' : '')
      + (prop.placeholder ? ' placeholder="' + escapeHtml(prop.placeholder) + '"' : '')
      + (typeof prop.min === 'number' ? ' min="' + prop.min + '"' : '')
      + (typeof prop.max === 'number' ? ' max="' + prop.max + '"' : '')
      + (typeof prop.step === 'number' ? ' step="' + prop.step + '"' : '') + '>';
  } else {
    // string / file / directory 及未知类型统一按文本输入（路径即文本）
    control = '<input type="text" class="slash-form-input"' + keyAttr
      + (initStr !== '' ? ' value="' + escapeHtml(initStr) + '"' : '')
      + (prop.placeholder ? ' placeholder="' + escapeHtml(prop.placeholder) + '"' : '') + '>';
  }
  // 行布局对齐 feature 配置页（fs-row）：左标题（+描述）列弹性，右控件列固定宽右贴
  return '<div class="slash-form-field" data-key="' + escapeHtml(key) + '">'
    + '<div class="slash-form-label">' + title
    + (prop.description ? '<div class="slash-form-hint">' + escapeHtml(prop.description) + '</div>' : '')
    + '</div>'
    + '<div class="slash-form-ctrl">' + control + '</div>'
    + '</div>';
}

function _renderForm(menu) {
  const cmd = _formCmd;
  const params = cmd.parameters || {};
  const current = cmd.currentValues && typeof cmd.currentValues === 'object' ? cmd.currentValues : {};
  const fieldsHtml = Object.keys(params).map(function (key) {
    return _renderFieldHtml(key, params[key], current[key]);
  }).join('');
  _dirtyKeys = new Set();
  // 结构：head（命令名+描述）/ body（字段区，滚动）/ actions（常驻底部）。
  // 高度上限由 _position 注入容器，body 内滚，表单永不向下侵入输入框
  menu.innerHTML =
    '<div class="slash-form" role="form">'
    + '<div class="slash-form-head">'
    + '<div class="slash-form-title">/' + escapeHtml(cmd.name) + '</div>'
    + (cmd.description ? '<div class="slash-form-subtitle">' + escapeHtml(cmd.description) + '</div>' : '')
    + '</div>'
    + '<div class="slash-form-body">' + fieldsHtml + '</div>'
    + '<div class="slash-form-actions">'
    + '<button type="button" class="slash-form-btn" data-action="cancel">'
    + escapeHtml(t('slash_form_cancel')) + '</button>'
    + '<button type="button" class="slash-form-btn is-primary" data-action="submit">'
    + escapeHtml(t('slash_form_submit')) + '</button>'
    + '</div></div>';
  _menuEl.querySelectorAll('.slash-form-range').forEach(_paintRange);
  _applyShowWhen();
}

function _applyShowWhen() {
  if (!_formCmd || !_menuEl) return;
  const params = _formCmd.parameters || {};
  Object.keys(params).forEach(function (key) {
    const prop = params[key];
    if (!prop.showWhen) return;
    const depEl = _menuEl.querySelector('#' + _fieldId(prop.showWhen.property));
    const field = _menuEl.querySelector('.slash-form-field[data-key="' + key + '"]');
    if (!depEl || !field) return;
    const val = depEl.type === 'checkbox' ? depEl.checked : depEl.value;
    field.style.display = (prop.showWhen.values || []).map(String).includes(String(val))
      ? '' : 'none';
  });
}

function _focusFirstField() {
  if (!_menuEl) return;
  const first = _menuEl.querySelector('.slash-form-field:not([style*="display: none"]) input, .slash-form-field select');
  first?.focus();
}

function _collectFormArgs() {
  const args = {};
  if (!_menuEl) return args;
  _menuEl.querySelectorAll('[data-key]').forEach(function (el) {
    if (!el.id || !el.id.startsWith('slash-param-')) return;
    const key = el.dataset.key;
    // dirty-only：未交互过的字段（含纯回显值）不提交，避免把 default 误写为配置
    if (!_dirtyKeys.has(key)) return;
    const field = el.closest('.slash-form-field');
    if (field && field.style.display === 'none') return;
    if (el.type === 'checkbox') args[key] = el.checked;
    else if (el.type === 'range' || el.type === 'number') args[key] = el.value === '' ? undefined : Number(el.value);
    else args[key] = el.value;
  });
  return args;
}

async function _submitForm() {
  const cmd = _formCmd;
  if (!cmd) return;
  const args = _collectFormArgs();
  _hide();
  await _invokeSessionCommand(cmd, args);
}

function _cancelForm() {
  _formCmd = null;
  _render();
}

// ── document 级 capture 监听（零侵入 persistent-input.js）────────

document.addEventListener('input', function (e) {
  if (!_isInputTextarea(e.target)) return;
  // 表单打开期间输入框打字不打断表单（否则 _formCmd 被销毁，勾选状态
  // 静默丢失）；表单只经 Esc / 取消按钮 / 点击外部关闭
  if (_formCmd && _visible) return;
  _syncFromInput(e.target);
}, true);

document.addEventListener('keydown', function (e) {
  if (!_visible) {
    // 菜单关闭但存在 prompt pill：Enter = 统一触发后发送；Esc = 清空 pill
    if (_pendingPrompts.length > 0 && _isInputTextarea(e.target)) {
      if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        void _dispatchPrompts(e.target);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        _clearPrompts();
      }
    }
    return;
  }
  if (!_isInputTextarea(e.target)) {
    // 表单态下，焦点在表单控件内：Enter 提交、Esc 取消
    if (_formCmd && _menuEl && _menuEl.contains(e.target)) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        void _submitForm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        _cancelForm();
      }
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    _hide();
    return;
  }
  // 空态时键盘归输入框：/ 开头文本回车即普通消息发送（但有 prompt pill
  // 时 Enter 归 pill 派发——命令前缀需并入消息，且 pill 触发先于发送）
  if (!_formCmd && _filtered.length === 0) {
    if (_pendingPrompts.length > 0 && e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      void _dispatchPrompts(e.target);
    }
    return;
  }
  if (_formCmd) {
    // 输入框聚焦但表单打开（焦点曾在表单后回到输入框）：Esc 已处理，Enter 提交
    if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      void _submitForm();
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    _highlightIdx = (_highlightIdx + 1) % _filtered.length;
    _render();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    _highlightIdx = (_highlightIdx - 1 + _filtered.length) % _filtered.length;
    _render();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    e.stopPropagation();
    _completeCommand(e.target);
  } else if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    void _execute(_filtered[_highlightIdx], e.target);
  }
}, true);

// 点击菜单外（非输入框）时关闭
document.addEventListener('mousedown', function (e) {
  // pill 删除按钮（mousedown 抢在 textarea blur 前处理，不丢焦点）
  const x = e.target.closest?.('.slash-prompt-pill-x');
  if (x) {
    e.preventDefault();
    e.stopPropagation();
    _pendingPrompts.splice(parseInt(x.dataset.idx, 10) || 0, 1);
    _renderPillBar();
    return;
  }
  if (!_visible) return;
  if (_menuEl && _menuEl.contains(e.target)) return;
  if (_isInputTextarea(e.target)) return;
  _hide();
}, true);

window.addEventListener('resize', function () {
  if (_visible) _position();
});

// ── window 导出 ────────────────────────────────────────────────

window.SlashMenu = {
  isActive: function () {
    return _visible && (_formCmd !== null || _filtered.length > 0);
  },
  registerCommands: function (list) {
    _hostCommands = (Array.isArray(list) ? list : []).filter(function (c) {
      return c && typeof c.name === 'string' && c.name;
    });
    if (_visible && !_formCmd) {
      const ta = _currentTa();
      if (ta) _syncFromInput(ta);
      else _hide();
    }
  },
};
