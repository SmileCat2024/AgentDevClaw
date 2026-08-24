/**
 * git-panel.js — Git 源代码管理面板（VS Code SCM 风格）
 *
 * feature 无关的产品 Chrome 层面板：跟随当前查看的 workspace 会话的项目
 * 目录，经 /protoclaw/git/* 路由展示 git 状态，并提供 stage / unstage /
 * commit / discard / branch / stash 简单操作与图形化提交历史（SVG 泳道，
 * 算法在 git-graph.js）。
 *
 * 分区（可折叠 details，默认全展开）：
 *   更改   — 暂存/提交/discard（VS Code SCM 交互）
 *   历史   — SVG 提交图 + 行文本；点行展开该提交的文件清单（懒加载）
 *   分支   — 本地/远程列表；点击切换、新建、删除
 *   贮藏   — stash 列表；save/pop/drop
 *
 * 刷新时机 = 进入面板 / 会话目录变化 / 手动刷新 / 任一写操作后（统一
 * loadAll 全量拉取，端点轻量，逻辑单点）。
 *
 * 交互模式对齐 todo-plan.js：featurePanelBody 事件委托 + data-gp-* 属性。
 *
 * 依赖（全局，声明于 app-core.js / app-main.js / debug-panel-host.js / git-graph.js）：
 *   - featurePanelBody, activeFeaturePanel, currentRuntimeAgentId, currentLanguage
 *   - renderFeaturePanel, escapeHtml, GitGraph
 *   - getRuntimeWorkspaceSessionId, getActiveWorkspaceSessionId, getCurrentAgentRecord
 */
(function () {
  'use strict';

  const state = {
    dir: '',            // 当前会话绑定目录（面板视图身份）
    root: '',           // 仓库根（服务端 rev-parse 解析）
    isRepo: true,
    status: null,       // 序列化后的 StatusResult
    graph: [],          // 提交历史（新→旧，含 lane）
    branches: null,     // { locals, remotes, current }
    stash: [],          // [{ ref, desc }]
    error: '',
    errors: {},         // 分端点错误：{ graph, branches, stash }——失败必须可见，禁止静默
    notice: '',         // 上一次操作的成功提示（如提交哈希）
    loading: false,
    busy: false,
    commitMessage: '',
    expandedCommit: '', // 展开文件清单的提交 hash
    commitFiles: {},    // hash -> [{path, added, removed}] 懒加载缓存
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
      const detail = String(data?.error || ('HTTP ' + res.status));
      // 失败留痕：UI 呈现之外，Console 同步记录便于定位环境问题
      console.warn('[GitPanel] ' + op + ' failed: ' + detail + ' (dir=' + String(body?.dir || '') + ')');
      throw new Error(detail);
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

  /** 全量拉取：status + graph + branches + stash 并行 */
  async function loadAll() {
    const dir = state.dir || currentSessionDir();
    if (!dir || state.loading) return;
    state.loading = true;
    state.error = '';
    try {
      // 各端点独立容错：一个失败不清空整个面板，错误落到对应分区展示
      const errors = {};
      const safe = (key, p) => p.catch((e) => { errors[key] = String(e?.message || e); return null; });
      const [status, graph, branches, stash] = await Promise.all([
        safe('status', api('status', { dir })),
        safe('graph', api('graph', { dir, limit: 120 })),
        safe('branches', api('branches', { dir })),
        safe('stash', api('stash', { dir, op: 'list' })),
      ]);
      // 响应返回时会话可能已切走：丢弃过期结果
      if ((state.dir || currentSessionDir()) !== dir) return;
      state.isRepo = status ? status.isRepo !== false : true;
      state.root = status?.root || '';
      state.status = status?.status || null;
      state.graph = Array.isArray(graph?.commits) ? graph.commits : [];
      state.branches = branches || null;
      state.stash = Array.isArray(stash?.entries) ? stash.entries : [];
      state.errors = errors;
      state.error = errors.status || '';
      state.expandedCommit = state.expandedCommit
        && state.graph.some((c) => c.hash === state.expandedCommit)
        ? state.expandedCommit : '';
    } catch (e) {
      state.error = String(e?.message || e || 'status failed');
    } finally {
      state.loading = false;
      repaint();
    }
  }

  const refresh = loadAll;

  /** render 周期里的目录监视：会话切换（dir 变化）触发一次异步刷新 */
  function watchDir() {
    const dir = currentSessionDir();
    if (dir === state.dir) return;
    state.dir = dir;
    state.root = '';
    state.status = null;
    state.graph = [];
    state.branches = null;
    state.stash = [];
    state.error = '';
    state.errors = {};
    state.notice = '';
    state.isRepo = true;
    state.commitMessage = '';
    state.expandedCommit = '';
    state.commitFiles = {};
    if (dir) loadAll();
  }

  // ── 更改分组与徽标 ────────────────────────────────────────────────
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

  // ── 渲染：更改区 ─────────────────────────────────────────────────

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

  function renderChangesGroup(title, files, group, headerAction) {
    if (!files || files.length === 0) return '';
    return [
      '<div class="git-group-head">',
      '<span class="git-group-title">' + esc(title) + '</span>',
      '<span class="git-group-count">' + files.length + '</span>',
      headerAction || '',
      '</div>',
      files.map((f) => renderFileRow(f, group)).join(''),
    ].join('');
  }

  function renderHead(status) {
    const branch = status?.detached
      ? esc(zh('分离头指针', 'Detached HEAD'))
      : esc(status?.current || '—');
    const arrows = [];
    if (status?.ahead > 0) arrows.push('↑' + status.ahead);
    if (status?.behind > 0) arrows.push('↓' + status.behind);
    const rootLeaf = state.root ? state.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    return [
      '<section class="git-head">',
      '<div class="git-head-line">',
      '<span class="git-branch" title="' + esc(status?.tracking ? status.current + ' · ' + status.tracking : '') + '">' + branch + '</span>',
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

  // ── 渲染：提交历史（SVG 泳道 + 行文本叠加）────────────────────────

  function refLabel(ref) {
    const name = String(ref?.name || '');
    if (!name) return '';
    const cls = ref.type === 'head' ? 'is-head' : ref.type === 'tag' ? 'is-tag'
      : ref.type === 'remote' ? 'is-remote' : 'is-local';
    const label = ref.type === 'head' ? name : ref.type === 'tag' ? 'tag: ' + name : name;
    return '<span class="git-ref ' + cls + '">' + esc(label) + '</span>';
  }

  async function ensureCommitFiles(hash) {
    if (state.commitFiles[hash]) return;
    try {
      const data = await api('commit_files', { dir: state.dir, hash });
      state.commitFiles[hash] = Array.isArray(data.files) ? data.files : [];
      repaint();
    } catch (e) {
      state.commitFiles[hash] = [];
      state.error = String(e?.message || e);
      repaint();
    }
  }

  function renderHistory() {
    const commits = state.graph;
    // 分区恒在：无数据/加载失败时给出可见状态，而不是让整个分区消失
    if (state.errors.graph) {
      return '<div class="git-empty-desc">' + esc(zh('提交历史加载失败：', 'Failed to load history: ')) + esc(state.errors.graph) + '</div>';
    }
    if (!commits.length) {
      return '<div class="git-empty-desc">' + esc(zh('暂无提交', 'No commits yet')) + '</div>';
    }

    const lanes = window.GitGraph.computeLanes(commits);
    const headRow = 0; // log 新→旧，第一行即 HEAD
    const svg = window.GitGraph.buildGraphSvg(lanes, headRow);

    const rows = commits.map((c, row) => {
      const isHead = row === headRow;
      const refs = (c.refs || []).map(refLabel).join('');
      const files = state.expandedCommit === c.hash
        ? renderCommitFiles(c.hash)
        : '';
      return [
        '<div class="git-history-row' + (isHead ? ' is-head' : '') + (state.expandedCommit === c.hash ? ' is-expanded' : '') + '" data-gp-commit="' + esc(c.hash) + '">',
        '<span class="git-history-text">',
        refs,
        '<span class="git-history-subject" title="' + esc(c.subject) + '">' + esc(c.subject) + '</span>',
        '</span>',
        '<span class="git-history-meta">' + esc(c.author) + ' · ' + esc(c.relTime) + '</span>',
        '</div>',
        files,
      ].join('');
    }).join('');

    return [
      '<div class="git-history" style="--git-canvas-w:' + svg.width + 'px">',
      '<div class="git-history-canvas">' + svg.svg + '</div>',
      '<div class="git-history-rows">' + rows + '</div>',
      '</div>',
    ].join('');
  }

  function renderCommitFiles(hash) {
    const cached = state.commitFiles[hash];
    if (!cached) {
      return '<div class="git-commit-files"><div class="git-commit-files-loading">' + esc(zh('加载中…', 'Loading…')) + '</div></div>';
    }
    if (!cached.length) {
      return '<div class="git-commit-files"><div class="git-commit-files-loading">' + esc(zh('无文件变更', 'No file changes')) + '</div></div>';
    }
    return [
      '<div class="git-commit-files">',
      cached.map((f) => [
        '<div class="git-commit-file" title="' + esc(f.path) + '">',
        '<span class="git-commit-file-path">' + esc(f.path) + '</span>',
        (f.added ? '<span class="git-num is-add">+' + f.added + '</span>' : ''),
        (f.removed ? '<span class="git-num is-del">-' + f.removed + '</span>' : ''),
        '</div>',
      ].join('')).join(''),
      '</div>',
    ].join('');
  }

  // ── 渲染：分支与贮藏 ──────────────────────────────────────────────

  function renderBranchRow(b) {
    const current = !!b.current;
    const tracking = current && state.status && state.status.tracking;
    const aheadBehind = tracking
      ? (state.status.ahead ? '<span class="git-branch-flag is-ahead" title="' + esc(zh('领先远程', 'ahead of remote')) + '">&#8593;' + state.status.ahead + '</span>' : '')
        + (state.status.behind ? '<span class="git-branch-flag is-behind" title="' + esc(zh('落后远程', 'behind remote')) + '">&#8595;' + state.status.behind + '</span>' : '')
      : '';
    // 远程分支只读展示（检出会造成 detached HEAD），本地分支可点击切换
    const clickable = current || b.remote ? '' : ' data-gp-action="branch-switch" data-gp-name="' + esc(b.name) + '"';
    const actions = current || b.remote ? '' : [
      '<button class="git-file-action is-danger" data-gp-action="branch-delete" data-gp-name="' + esc(b.name) + '" title="' + esc(zh('删除分支', 'Delete branch')) + '">&#10005;</button>',
    ].join('');
    return [
      '<div class="git-branch-row' + (current ? ' is-current' : '') + '"' + clickable + ' title="' + esc(b.subject) + '">',
      '<span class="git-file-badge">' + (current ? '&#10003;' : '') + '</span>',
      '<span class="git-branch-name">' + esc(b.name) + '</span>',
      '<span class="git-branch-right">',
      aheadBehind,
      b.relTime ? '<span class="git-branch-time">' + esc(b.relTime) + '</span>' : '',
      '<span class="git-file-actions">' + actions + '</span>',
      '</span>',
      '</div>',
    ].join('');
  }

  function renderBranches() {
    if (state.errors.branches) {
      return '<div class="git-empty-desc">' + esc(zh('分支加载失败：', 'Failed to load branches: ')) + esc(state.errors.branches) + '</div>';
    }
    const b = state.branches;
    if (!b) return '';
    const locals = (b.locals || []).map(renderBranchRow).join('');
    const remotes = (b.remotes || [])
      .filter((r) => r.name !== 'origin/HEAD')
      .map(renderBranchRow).join('');
    return [
      locals
        ? '<div class="git-group-head"><span class="git-group-title">' + esc(zh('本地', 'Local')) + '</span>'
          + '<span class="git-group-count">' + (b.locals || []).length + '</span>'
          + '<button class="git-group-action" data-gp-action="branch-create">' + esc(zh('新建', 'New')) + '</button></div>' + locals
        : '<div class="git-empty-desc">' + esc(zh('无本地分支', 'No local branches')) + '</div>',
      remotes
        // 远程分支默认折叠成一行计数，展开才罗列——避免整屏 origin/* 刷屏
        ? '<details class="git-remote-fold"><summary>' + esc(zh('远程', 'Remotes'))
          + ' · ' + (b.remotes || []).filter((r) => r.name !== 'origin/HEAD').length + '</summary>' + remotes + '</details>'
        : '',
    ].join('');
  }

  function renderStash() {
    const entries = state.stash || [];
    const head = '<div class="git-group-head"><span class="git-group-title">' + esc(zh('贮藏', 'Stash')) + '</span>'
      + (entries.length ? '<span class="git-group-count">' + entries.length + '</span>' : '')
      + '<button class="git-group-action" data-gp-action="stash-save">' + esc(zh('贮藏全部', 'Stash All')) + '</button></div>';
    if (!entries.length) {
      return head + '<div class="git-empty-desc">' + esc(zh('无贮藏条目', 'No stash entries')) + '</div>';
    }
    return head + entries.map((s) => [
      '<div class="git-branch-row" title="' + esc(s.desc) + '">',
      '<span class="git-branch-name">' + esc(s.desc) + '</span>',
      '<span class="git-file-actions">',
      '<button class="git-file-action" data-gp-action="stash-pop" data-gp-ref="' + esc(s.ref) + '" title="' + esc(zh('恢复并删除', 'Pop')) + '">&#8635;</button>',
      '<button class="git-file-action is-danger" data-gp-action="stash-drop" data-gp-ref="' + esc(s.ref) + '" title="' + esc(zh('丢弃贮藏', 'Drop stash')) + '">&#10005;</button>',
      '</span>',
      '</div>',
    ].join('')).join('');
  }

  // ── 渲染：分区壳与主入口 ─────────────────────────────────────────

  function section(id, title, bodyHtml, open) {
    if (!bodyHtml) return '';
    return [
      '<details class="git-section" data-gp-section="' + id + '"' + (open ? ' open' : '') + '>',
      '<summary class="git-section-title">' + esc(title) + '</summary>',
      '<div class="git-section-body">' + bodyHtml + '</div>',
      '</details>',
    ].join('');
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

    const changesBody = [
      (staged.length > 0 || state.commitMessage) ? renderCommitBox(staged.length) : '',
      renderChangesGroup(zh('暂存的更改', 'Staged Changes'), staged, 'staged',
        staged.length > 0 ? '<button class="git-group-action" data-gp-action="unstage-all">' + esc(zh('全部取消', 'Unstage All')) + '</button>' : ''),
      renderChangesGroup(zh('合并冲突', 'Merge Conflicts'), conflicts, 'conflict', ''),
      renderChangesGroup(zh('更改', 'Changes'), changes, 'changes',
        changes.length > 0 ? '<button class="git-group-action" data-gp-action="stage-all">' + esc(zh('全部暂存', 'Stage All')) + '</button>' : ''),
      clean ? '<div class="git-clean">' + esc(zh('工作区干净', 'Working tree clean')) + '</div>' : '',
    ].join('');

    return [
      '<div class="git-panel">',
      renderHead(status),
      renderMessage(),
      section('changes', zh('更改', 'Changes'), changesBody, true),
      section('history', zh('提交历史', 'Commit History'), renderHistory(), true),
      section('branches', zh('分支', 'Branches'), renderBranches(), false),
      section('stash', zh('贮藏', 'Stash'), renderStash(), false),
      '</div>',
    ].join('');
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
      await loadAll();
    });
  }

  async function doUnstage(files) {
    await runAction(async () => {
      await api('unstage', files ? { dir: state.dir, files } : { dir: state.dir });
      await loadAll();
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
      await loadAll();
    });
  }

  async function doDiscard(path) {
    const confirmed = window.confirm(
      zh('丢弃「' + path + '」的改动？\n\n此操作不可恢复。', 'Discard changes to "' + path + '"?\n\nThis cannot be undone.')
    );
    if (!confirmed) return;
    await runAction(async () => {
      await api('discard', { dir: state.dir, files: [path] });
      await loadAll();
    });
  }

  async function doBranchSwitch(name) {
    const confirmed = window.confirm(
      zh('切换到分支「' + name + '」？\n\n未提交的改动若与目标分支冲突将阻止切换。', 'Switch to branch "' + name + '"?\n\nUncommitted changes conflicting with the target will block the switch.')
    );
    if (!confirmed) return;
    await runAction(async () => {
      await api('branch', { dir: state.dir, op: 'switch', name });
      state.notice = zh('已切换到 ' + name, 'Switched to ' + name);
      await loadAll();
    });
  }

  async function doBranchCreate() {
    const name = window.prompt(zh('新分支名称：', 'New branch name:'));
    if (!name || !name.trim()) return;
    await runAction(async () => {
      await api('branch', { dir: state.dir, op: 'create', name: name.trim() });
      state.notice = zh('已创建分支 ' + name.trim(), 'Created branch ' + name.trim());
      await loadAll();
    });
  }

  async function doBranchDelete(name) {
    const confirmed = window.confirm(
      zh('删除分支「' + name + '」？', 'Delete branch "' + name + '"?')
    );
    if (!confirmed) return;
    await runAction(async () => {
      try {
        await api('branch', { dir: state.dir, op: 'delete', name });
      } catch (e) {
        // -d 对未合并分支失败：二次确认后强制删除
        const msg = String(e?.message || '');
        if (/not fully merged|未合并/i.test(msg)
          && window.confirm(zh('分支「' + name + '」未完全合并，强制删除？\n\n未合并的提交将不可恢复。', 'Branch "' + name + '" is not fully merged. Force delete?\n\nUnmerged commits cannot be recovered.'))) {
          await api('branch', { dir: state.dir, op: 'delete', name, force: true });
        } else {
          throw e;
        }
      }
      state.notice = zh('已删除分支 ' + name, 'Deleted branch ' + name);
      await loadAll();
    });
  }

  async function doStashSave() {
    const confirmed = window.confirm(
      zh('将当前全部未提交改动贮藏？', 'Stash all uncommitted changes?')
    );
    if (!confirmed) return;
    await runAction(async () => {
      await api('stash', { dir: state.dir, op: 'save' });
      state.notice = zh('已贮藏', 'Stashed');
      await loadAll();
    });
  }

  async function doStashOp(op, ref) {
    const labels = { pop: zh('恢复', 'Pop'), drop: zh('丢弃', 'Drop') };
    const confirmed = window.confirm(
      zh(labels[op] + '贮藏 ' + ref + '？', labels[op] + ' stash ' + ref + '?')
    );
    if (!confirmed) return;
    await runAction(async () => {
      await api('stash', { dir: state.dir, op, ref });
      await loadAll();
    });
  }

  function toggleCommit(hash) {
    if (state.expandedCommit === hash) {
      state.expandedCommit = '';
    } else {
      state.expandedCommit = hash;
      ensureCommitFiles(hash);
    }
    repaint();
  }

  // ── 事件委托（对齐 todo-plan.js 的 featurePanelBody 模式）────────

  featurePanelBody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-gp-action]');
    if (!btn) {
      const commitRow = e.target.closest('[data-gp-commit]');
      if (commitRow && !e.target.closest('.git-commit-files')) {
        e.preventDefault();
        toggleCommit(commitRow.dataset.gpCommit || '');
      }
      return;
    }
    const action = btn.dataset.gpAction || '';
    const file = btn.dataset.gpFile || '';
    if (action === 'refresh') {
      state.error = '';
      state.notice = '';
      loadAll();
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
    } else if (action === 'branch-switch') {
      doBranchSwitch(btn.dataset.gpName || '');
    } else if (action === 'branch-create') {
      doBranchCreate();
    } else if (action === 'branch-delete') {
      e.stopPropagation();
      doBranchDelete(btn.dataset.gpName || '');
    } else if (action === 'stash-save') {
      doStashSave();
    } else if (action === 'stash-pop') {
      doStashOp('pop', btn.dataset.gpRef || '');
    } else if (action === 'stash-drop') {
      doStashOp('drop', btn.dataset.gpRef || '');
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
      if (state.dir) loadAll();
    },
    refresh,
  };
})();
