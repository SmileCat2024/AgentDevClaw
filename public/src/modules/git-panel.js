/**
 * git-panel.js — Git 源代码管理面板（VS Code SCM 风格）
 *
 * feature 无关的产品 Chrome 层面板：跟随当前查看的 workspace 会话的项目
 * 目录，经 /protoclaw/git/* 路由展示 git 状态，并提供 stage / unstage /
 * commit / discard 简单操作。刷新时机 = 进入面板 / 会话目录变化 / 手动刷新。
 *
 * 交互模式对齐 todo-plan.js：featurePanelBody 事件委托 + data-gp-* 属性，
 * 操作完成后直连 fetch 并 renderFeaturePanel() 重绘。
 *
 * 依赖（全局，声明于 app-core.js / app-main.js / debug-panel-host.js）：
 *   - featurePanelBody, activeFeaturePanel, currentRuntimeAgentId, currentLanguage
 *   - renderFeaturePanel, escapeHtml
 *   - getRuntimeWorkspaceSessionId, getActiveWorkspaceSessionId, getCurrentAgentRecord
 */
(function () {
  'use strict';

  const state = {
    dir: '',            // 当前会话绑定目录（面板视图身份）
    root: '',           // 仓库根（服务端 rev-parse 解析）
    isRepo: true,
    status: null,       // 序列化后的 StatusResult
    error: '',
    notice: '',         // 上一次操作的成功提示（如提交哈希）
    loading: false,
    busy: false,
    commitMessage: '',
    fetchedAt: 0,
  };

  function esc(value) {
    return typeof escapeHtml === 'function'
      ? escapeHtml(String(value ?? ''))
      : String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function zh(zhText, enText) {
    return currentLanguage === 'zh' ? zhText : enText;
  }

  // ── 会话目录解析（跟随当前查看的 workspace 会话）─────────────────
  // 与 force-continuation-panel 相同的身份链：viewer 绑定优先，
  // 回退 host 记录的 activeSessionId，再从 sessions 数组取 openDirectory。

  function currentSessionId() {
    return typeof getRuntimeWorkspaceSessionId === 'function' && currentRuntimeAgentId
      ? getRuntimeWorkspaceSessionId(currentRuntimeAgentId)
        || (typeof getActiveWorkspaceSessionId === 'function' ? getActiveWorkspaceSessionId() : '')
      : '';
  }

  function currentSessionDir() {
    const sid = currentSessionId();
    if (!sid) return '';
    const agent = typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
    const sessions = Array.isArray(agent?.workspace_sessions?.sessions)
      ? agent.workspace_sessions.sessions
      : [];
    const session = sessions.find((s) => String(s?.id || '').trim() === sid);
    return String(session?.openDirectory || '').trim();
  }

  // ── 服务端调用 ────────────────────────────────────────────────────

  async function api(op, body) {
    const res = await fetch('/protoclaw/git/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      throw new Error(String(data?.error || ('HTTP ' + res.status)));
    }
    return data;
  }

  function repaint() {
    if (typeof activeFeaturePanel !== 'undefined'
      && activeFeaturePanel === 'git'
      && typeof renderFeaturePanel === 'function') {
      renderFeaturePanel();
    }
  }

  async function refresh() {
    const dir = state.dir || currentSessionDir();
    if (!dir || state.loading) return;
    state.loading = true;
    state.error = '';
    try {
      const data = await api('status', { dir });
      // 响应返回时会话可能已切走：丢弃过期结果
      if ((state.dir || currentSessionDir()) !== dir) return;
      state.isRepo = data.isRepo !== false;
      state.root = data.root || '';
      state.status = data.status || null;
      state.fetchedAt = Date.now();
    } catch (e) {
      state.error = String(e?.message || e || 'status failed');
    } finally {
      state.loading = false;
      repaint();
    }
  }

  /** render 周期里的目录监视：会话切换（dir 变化）触发一次异步刷新 */
  function watchDir() {
    const dir = currentSessionDir();
    if (dir === state.dir) return;
    state.dir = dir;
    state.root = '';
    state.status = null;
    state.error = '';
    state.notice = '';
    state.isRepo = true;
    if (dir) refresh();
  }

  // ── 分组与徽标 ────────────────────────────────────────────────────
  // VS Code SCM 模型：文件按「暂存的更改 / 更改 / 合并冲突」三组展示。
  // 重命名（R）属于暂存侧；未跟踪（??）归入更改组，徽标显示 U。

  function splitGroups(files) {
    const staged = [];
    const changes = [];
    const conflicts = [];
    for (const f of files) {
      const x = String(f?.index || '');
      const y = String(f?.working_dir || '');
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) {
        conflicts.push(f);
      } else if (x !== ' ' && x !== '?') {
        staged.push(f);
      } else {
        changes.push(f);
      }
    }
    return { staged, changes, conflicts };
  }

  function badgeFor(file, group) {
    const x = String(file?.index || '');
    const y = String(file?.working_dir || '');
    if (group === 'conflict') return { letter: 'C', cls: 'C' };
    if (group === 'staged') return { letter: x || 'M', cls: x || 'M' };
    if (y === 'M' || y === 'D') return { letter: y, cls: y };
    if (x === 'R') return { letter: 'R', cls: 'R' };
    return { letter: 'U', cls: 'U' };
  }

  function displayPath(file) {
    return file?.from ? `${file.path} ← ${file.from}` : String(file?.path || '');
  }

  // ── 渲染 ─────────────────────────────────────────────────────────

  function renderFileRow(file, group) {
    const badge = badgeFor(file, group);
    const path = displayPath(file);
    const inConflict = group === 'conflict';
    // 行内操作：悬停显隐的图标按钮（+ 暂存 / − 取消暂存 / ↺ 丢弃），语义靠 tooltip
    const actions = inConflict ? '' : [
      group === 'staged'
        ? '<button class="git-file-action" data-gp-action="unstage" data-gp-file="' + esc(file.path) + '" title="' + esc(zh('取消暂存', 'Unstage')) + '">&#8722;</button>'
        : '<button class="git-file-action" data-gp-action="stage" data-gp-file="' + esc(file.path) + '" title="' + esc(zh('暂存', 'Stage')) + '">+</button>',
      '<button class="git-file-action is-danger" data-gp-action="discard" data-gp-file="' + esc(file.path) + '" title="' + esc(zh('丢弃改动（不可恢复）', 'Discard changes (cannot be undone)')) + '">&#8634;</button>',
    ].join('');
    return [
      '<div class="git-file' + (inConflict ? ' is-conflict' : '') + '">',
      '<span class="git-file-badge st-' + esc(badge.cls) + '">' + esc(badge.letter) + '</span>',
      '<span class="git-file-path" title="' + esc(path) + '">' + esc(path) + '</span>',
      '<span class="git-file-actions">' + actions + '</span>',
      '</div>',
    ].join('');
  }

  function renderGroup(title, files, group, headerAction) {
    if (!files || files.length === 0) return '';
    return [
      '<section class="git-group">',
      '<div class="git-group-head">',
      '<span class="git-group-title">' + esc(title) + '</span>',
      '<span class="git-group-count">' + files.length + '</span>',
      headerAction || '',
      '</div>',
      files.map((f) => renderFileRow(f, group)).join(''),
      '</section>',
    ].join('');
  }

  function renderHead(status) {
    const branch = status.detached
      ? esc(zh('分离头指针', 'Detached HEAD'))
      : esc(status.current || '—');
    const arrows = [];
    if (status.ahead > 0) arrows.push('↑' + status.ahead);
    if (status.behind > 0) arrows.push('↓' + status.behind);
    const rootLeaf = state.root ? state.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    return [
      '<section class="git-head">',
      '<div class="git-head-line">',
      '<span class="git-branch" title="' + esc(status.tracking ? status.current + ' · ' + status.tracking : '') + '">' + branch + '</span>',
      arrows.length ? '<span class="git-arrows">' + esc(arrows.join(' ')) + '</span>' : '',
      '<button class="git-head-refresh' + (state.loading ? ' is-loading' : '') + '" data-gp-action="refresh" title="' + esc(zh('刷新', 'Refresh')) + '" ' + (state.loading || state.busy ? 'disabled' : '') + '>&#8635;</button>',
      '</div>',
      rootLeaf ? '<div class="git-root" title="' + esc(state.root) + '">' + esc(rootLeaf) + '</div>' : '',
      '</section>',
    ].join('');
  }

  function renderCommitBox(stagedCount) {
    const disabled = stagedCount === 0 || state.busy;
    const label = stagedCount > 0
      ? zh('提交', 'Commit') + ' (' + stagedCount + ')'
      : zh('提交', 'Commit');
    return [
      '<section class="git-commit-box">',
      '<textarea id="git-commit-message" class="git-commit-input" data-gp-message rows="2" placeholder="'
        + esc(zh('提交信息', 'Commit message')) + '">' + esc(state.commitMessage) + '</textarea>',
      '<button class="git-commit-btn" data-gp-action="commit" ' + (disabled ? 'disabled' : '') + '>' + esc(label) + '</button>',
      '</section>',
    ].join('');
  }

  function renderMessage() {
    if (state.error) {
      return '<div class="git-msg is-error">' + esc(state.error) + '</div>';
    }
    if (state.notice) {
      return '<div class="git-msg is-notice">' + esc(state.notice) + '</div>';
    }
    return '';
  }

  function renderEmpty(title, desc) {
    return '<div class="feature-panel-empty"><div>' + esc(title) + '</div>' + (desc ? '<div class="git-empty-desc">' + esc(desc) + '</div>' : '') + '</div>';
  }

  function buildHtml() {
    if (!state.dir) {
      return renderEmpty(
        zh('当前会话未绑定项目目录', 'Current session has no project directory'),
        zh('打开一个绑定了项目目录的会话后，这里会显示它的 git 状态。', 'Open a session bound to a project directory to see its git status here.')
      );
    }
    if (!state.status && !state.error) {
      return renderEmpty(zh('读取中…', 'Loading…'));
    }
    if (!state.isRepo) {
      return renderEmpty(
        zh('不是 git 仓库', 'Not a git repository'),
        zh('当前会话目录未纳入 git 管理。', 'The current session directory is not under git.')
      );
    }

    const status = state.status || { files: [] };
    const { staged, changes, conflicts } = splitGroups(status.files || []);
    const clean = (status.files || []).length === 0;

    const out = ['<div class="git-panel">'];
    out.push(renderHead(status));
    out.push(renderMessage());
    if (staged.length > 0 || state.commitMessage) {
      out.push(renderCommitBox(staged.length));
    }
    out.push(renderGroup(zh('暂存的更改', 'Staged Changes'), staged, 'staged',
      staged.length > 0 ? '<button class="git-group-action" data-gp-action="unstage-all">' + esc(zh('全部取消', 'Unstage All')) + '</button>' : ''));
    out.push(renderGroup(zh('合并冲突', 'Merge Conflicts'), conflicts, 'conflict', ''));
    out.push(renderGroup(zh('更改', 'Changes'), changes, 'changes',
      changes.length > 0 ? '<button class="git-group-action" data-gp-action="stage-all">' + esc(zh('全部暂存', 'Stage All')) + '</button>' : ''));
    if (clean) {
      out.push('<div class="git-clean">' + esc(zh('工作区干净', 'Working tree clean')) + '</div>');
    }
    out.push('</div>');
    return out.join('');
  }

  function render() {
    watchDir();
    return buildHtml();
  }

  // ── 操作 ─────────────────────────────────────────────────────────

  function readCommitMessage() {
    const el = document.getElementById('git-commit-message');
    if (el) state.commitMessage = el.value;
    return String(state.commitMessage || '').trim();
  }

  async function runAction(fn) {
    if (state.busy) return;
    state.busy = true;
    state.notice = '';
    repaint();
    try {
      await fn();
    } catch (e) {
      state.error = String(e?.message || e || 'operation failed');
    } finally {
      state.busy = false;
      repaint();
    }
  }

  async function doStage(files) {
    await runAction(async () => {
      await api('stage', files ? { dir: state.dir, files } : { dir: state.dir });
      await refresh();
    });
  }

  async function doUnstage(files) {
    await runAction(async () => {
      await api('unstage', files ? { dir: state.dir, files } : { dir: state.dir });
      await refresh();
    });
  }

  async function doCommit() {
    const message = readCommitMessage();
    if (!message) {
      state.error = zh('请填写提交信息', 'Commit message is required');
      repaint();
      return;
    }
    const stagedCount = (state.status?.files || []).filter((f) => f.index !== ' ' && f.index !== '?'
      && !(f.index === 'U' || f.working_dir === 'U' || (f.index === 'A' && f.working_dir === 'A') || (f.index === 'D' && f.working_dir === 'D'))).length;
    const confirmed = window.confirm(
      zh('提交 ' + stagedCount + ' 个已暂存文件？\n\n' + message, 'Commit ' + stagedCount + ' staged files?\n\n' + message)
    );
    if (!confirmed) return;
    await runAction(async () => {
      const data = await api('commit', { dir: state.dir, message });
      state.commitMessage = '';
      const hash = String(data?.commit?.commit || '').slice(0, 8);
      state.notice = hash ? zh('已提交 ' + hash, 'Committed ' + hash) : zh('已提交', 'Committed');
      await refresh();
    });
  }

  async function doDiscard(path) {
    const confirmed = window.confirm(
      zh('丢弃「' + path + '」的改动？\n\n此操作不可恢复。', 'Discard changes to "' + path + '"?\n\nThis cannot be undone.')
    );
    if (!confirmed) return;
    await runAction(async () => {
      await api('discard', { dir: state.dir, files: [path] });
      await refresh();
    });
  }

  // ── 事件委托（对齐 todo-plan.js 的 featurePanelBody 模式）────────

  featurePanelBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-gp-action]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.dataset.gpAction || '';
    const file = btn.dataset.gpFile || '';
    if (action === 'refresh') {
      state.error = '';
      state.notice = '';
      refresh();
    } else if (action === 'stage') {
      doStage([file]);
    } else if (action === 'stage-all') {
      doStage(null);
    } else if (action === 'unstage') {
      doUnstage([file]);
    } else if (action === 'unstage-all') {
      doUnstage(null);
    } else if (action === 'commit') {
      doCommit();
    } else if (action === 'discard') {
      doDiscard(file);
    }
  });

  featurePanelBody.addEventListener('input', (e) => {
    const ta = e.target.closest('textarea[data-gp-message]');
    if (!ta) return;
    state.commitMessage = ta.value;
  });

  window.GitPanel = {
    render,
    onOpen() {
      watchDir();
      if (state.dir) refresh();
    },
    refresh,
  };
})();
