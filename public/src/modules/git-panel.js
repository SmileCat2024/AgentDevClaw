/**
 * git-panel.js — Git 源代码管理面板（VS Code SCM 交互 × Claw 面板语言）
 *
 * feature 无关的产品 Chrome 层面板：跟随当前查看的 workspace 会话的项目
 * 目录，经 /protoclaw/git/* 路由展示 git 状态，并提供 stage / unstage /
 * commit / discard / branch 简单操作与图形化提交历史（SVG 泳道，
 * 算法在 git-graph.js）。
 *
 * 布局（上下双区，均可独立折叠 + 中间分隔条拖拽调高）：
 *   ┌────────────────────────────┐
 *   │ 更改与暂存  [概况条] [⟳]   │ ← 上区：概况（目录/远程关系/总数）
 *   │  提交框 + 可折叠分区        │    （暂存的更改 / 更改 / 冲突 / 分支）
 *   ├───── ⟂ 可拖拽分隔条 ───────┤
 *   │ 图形  [分支选择▾] [加载更多]│ ← 下区：SVG 提交历史（分支过滤）
 *   └────────────────────────────┘
 *
 * 刷新时机 = 进入面板 / 会话目录就绪（含重试，修复首次切入不加载）/
 * 会话目录变化 / 手动刷新 / 任一写操作后（统一 loadAll 单点拉取）。
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
    aheadHashes: [],    // 未推送提交哈希集合（「传出的更改」分组依据）
    branches: null,     // { locals, remotes, current }
    stash: [],          // [{ ref, desc }]（Stash 已从 UI 移除，保留字段以兼容旧布局缓存）
    error: '',
    errors: {},         // 分端点错误：{ graph, branches, stash }——失败必须可见，禁止静默
    notice: '',         // 上一次操作的成功提示（如提交哈希）
    loading: false,
    busy: false,
    commitMessage: '',
    expandedCommit: '', // 展开文件清单的提交 hash
    commitFiles: {},    // hash -> [{path, added, removed}] 懒加载缓存
    branch: '',         // 图形区分支过滤（'' = 当前分支）
    graphLimit: 120,    // 图形区加载条数（「加载更多」递增）
    // 布局状态（localStorage 持久化）
    zoneFold: { changes: false, graph: false },
    subFold: { staged: true, changes: true, conflict: false, stash: false, branches: false },
    topH: 0,            // 上区像素高度（0 = 默认比例）
    changesScroll: 0,
    graphScroll: 0,
  };

  const LS_KEY = 'claw:git:layout';

  function saveLayout() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        zoneFold: state.zoneFold, subFold: state.subFold, topH: state.topH,
      }));
    } catch (_) { /* 隐私模式等场景忽略 */ }
  }

  function loadLayout() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) || {};
      if (d.zoneFold) state.zoneFold = { ...state.zoneFold, ...d.zoneFold };
      if (d.subFold) state.subFold = { ...state.subFold, ...d.subFold };
      if (typeof d.topH === 'number' && d.topH > 0) state.topH = d.topH;
    } catch (_) { /* 损坏数据忽略 */ }
  }
  loadLayout();

  function esc(value) {
    return typeof escapeHtml === 'function'
      ? escapeHtml(String(value ?? ''))
      : String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function zh(zhText, enText) {
    return currentLanguage === 'zh' ? zhText : enText;
  }

  // ── 会话目录解析（跟随当前查看的 workspace 会话）─────────────────

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

  /** 全量拉取：status + graph + branches 并行（graph 按当前分支过滤） */
  async function loadAll() {
    const dir = state.dir || currentSessionDir();
    if (!dir || state.loading) return;
    state.loading = true;
    state.error = '';
    try {
      // 各端点独立容错：一个失败不清空整个面板，错误落到对应分区展示
      const errors = {};
      const safe = (key, p) => p.catch((e) => { errors[key] = String(e?.message || e); return null; });
      const [status, graph, branches] = await Promise.all([
        safe('status', api('status', { dir })),
        safe('graph', api('graph', { dir, limit: state.graphLimit, branch: state.branch })),
        safe('branches', api('branches', { dir })),
      ]);
      // 响应返回时会话可能已切走：丢弃过期结果
      if ((state.dir || currentSessionDir()) !== dir) return;
      state.isRepo = status ? status.isRepo !== false : true;
      state.root = status?.root || '';
      state.status = status?.status || null;
      state.graph = Array.isArray(graph?.commits) ? graph.commits : [];
      state.aheadHashes = Array.isArray(graph?.aheadHashes) ? graph.aheadHashes : [];
      state.branches = branches || null;
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

  /**
   * 首次切入不加载的修复：切入面板时会话数据（agent record 的
   * workspace_sessions）可能尚未就绪，currentSessionDir() 暂时返回空。
   * 这里带退避重试轮询目录就绪，面板切走即停。
   */
  let retryTimer = null;
  function ensureLoaded(attempt) {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (typeof activeFeaturePanel === 'undefined' || activeFeaturePanel !== 'git') return;
    const dir = currentSessionDir();
    if (dir) {
      if (state.dir !== dir) {
        watchDir();
      } else if (!state.status && !state.loading) {
        loadAll();
      }
      return;
    }
    if (attempt >= 12) return; // ~6s 后放弃，显示空态指引
    retryTimer = setTimeout(() => ensureLoaded(attempt + 1), 500);
  }

  /** render 周期里的目录监视：会话切换（dir 变化）触发一次异步刷新 */
  function watchDir() {
    const dir = currentSessionDir();
    if (dir === state.dir) return;
    state.dir = dir;
    state.root = '';
    state.status = null;
    state.graph = [];
    state.aheadHashes = [];
    state.branches = null;
    state.stash = [];
    state.error = '';
    state.errors = {};
    state.notice = '';
    state.isRepo = true;
    state.commitMessage = '';
    state.expandedCommit = '';
    state.commitFiles = {};
    state.branch = '';
    state.graphLimit = 120;
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

  /** 文件类型图标（短文本徽标）：json 用 {}，其余取扩展名大写 */
  function fileTypeIcon(path) {
    const base = String(path || '').split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot < 0 || dot === base.length - 1) return { label: '—', known: false };
    const ext = base.slice(dot + 1).toLowerCase();
    if (ext === 'json') return { label: '{}', known: true };
    if (ext === 'md') return { label: 'M↓', known: true };
    const label = ext.slice(0, 4).toUpperCase();
    return { label, known: true };
  }

  // ── 渲染：文件行 / 分组 ───────────────────────────────────────────

  function renderFileRow(file, group) {
    const badge = badgeFor(file, group);
    const path = displayPath(file);
    const inConflict = group === 'conflict';
    const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const icon = fileTypeIcon(path);
    // 行内操作：悬停显隐的图标按钮（+ 暂存 / − 取消暂存 / ↺ 丢弃）
    const actions = inConflict ? '' : [
      group === 'staged'
        ? '<button class="git-file-action" data-gp-action="unstage" data-gp-file="' + esc(file.path) + '" title="' + esc(zh('取消暂存', 'Unstage')) + '">&#8722;</button>'
        : '<button class="git-file-action" data-gp-action="stage" data-gp-file="' + esc(file.path) + '" title="' + esc(zh('暂存', 'Stage')) + '">+</button>',
      '<button class="git-file-action is-danger" data-gp-action="discard" data-gp-file="' + esc(file.path) + '" title="' + esc(zh('丢弃改动（不可恢复）', 'Discard changes (cannot be undone)')) + '">&#8634;</button>',
    ].join('');
    return [
      '<div class="git-file' + (inConflict ? ' is-conflict' : '') + '" title="' + esc(path) + '">',
      '<span class="git-file-icon">' + esc(icon.label) + '</span>',
      '<span class="git-file-name">' + esc(name) + '</span>',
      (dir ? '<span class="git-file-dir">' + esc(dir) + '</span>' : ''),
      '<span class="git-file-actions">' + actions + '</span>',
      '<span class="git-file-badge st-' + esc(badge.cls) + '">' + esc(badge.letter) + '</span>',
      '</div>',
    ].join('');
  }

  function renderFilesList(files, group) {
    return files.map((f) => renderFileRow(f, group)).join('');
  }

  /** 上区内部可折叠分区（summary 点击 → subFold 状态 → 重绘，不经原生 details） */
  function subSection(key, title, count, bodyHtml, toolsHtml, open) {
    return [
      '<div class="git-sub' + (open ? ' is-open' : '') + '" data-gp-sub="' + key + '">',
      '<div class="git-sub-head">',
      '<span class="git-sub-chev" aria-hidden="true"></span>',
      '<span class="git-sub-title">' + esc(title) + '</span>',
      (count > 0 ? '<span class="git-sub-count">' + count + '</span>' : ''),
      '<span class="git-sub-tools">' + (toolsHtml || '') + '</span>',
      '</div>',
      (open ? '<div class="git-sub-body">' + (bodyHtml || '') + '</div>' : ''),
      '</div>',
    ].join('');
  }

  // ── 渲染：概况条（目录 / 总体 / 远程关系）─────────────────────────

  function renderOverview(status) {
    const files = status?.files || [];
    const { staged, changes, conflicts } = splitGroups(files);
    const rootLeaf = state.root ? state.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
    const branch = status?.detached ? zh('分离头指针', 'detached') : (status?.current || '—');
    // 远程关系：ahead/behind + 跟踪分支；无跟踪时明示
    let sync;
    if (status?.tracking) {
      const parts = [];
      if (status.ahead > 0) parts.push('↑' + status.ahead);
      if (status.behind > 0) parts.push('↓' + status.behind);
      sync = parts.length
        ? '<span class="git-ov-sync is-dirty">' + esc(parts.join(' ')) + '</span>'
        : '<span class="git-ov-sync is-clean">' + esc(zh('与远程一致', 'in sync')) + '</span>';
    } else {
      sync = '<span class="git-ov-sync is-none">' + esc(zh('无远程跟踪', 'no upstream')) + '</span>';
    }
    const dirtyCount = changes.length + conflicts.length;
    const summary = files.length === 0
      ? '<span class="git-ov-count is-clean">' + esc(zh('工作区干净', 'clean')) + '</span>'
      : '<span class="git-ov-count">' + esc(
        zh(
          (staged.length ? staged.length + ' 暂存' : '')
          + (staged.length && dirtyCount ? ' · ' : '')
          + (dirtyCount ? dirtyCount + ' 更改' : ''),
          (staged.length ? staged.length + ' staged' : '')
          + (staged.length && dirtyCount ? ' · ' : '')
          + (dirtyCount ? dirtyCount + ' changed' : '')
        )) + '</span>';
    return [
      '<div class="git-overview">',
      '<span class="git-ov-dir" title="' + esc(state.root || state.dir) + '">' + esc(rootLeaf || '—') + '</span>',
      '<span class="git-ov-branch" title="' + esc(status?.tracking ? branch + ' · ' + status.tracking : branch) + '">&#10262; ' + esc(branch) + '</span>',
      sync,
      summary,
      '</div>',
    ].join('');
  }

  function renderCommitBox(stagedCount) {
    const disabled = stagedCount === 0 || state.busy;
    const branch = state.status?.current || '';
    const placeholder = branch
      ? zh('提交信息 (Ctrl+Enter 在 "' + branch + '" 上提交)', 'Commit message (Ctrl+Enter to commit on "' + branch + '")')
      : zh('提交信息', 'Commit message');
    const label = stagedCount > 0
      ? '&#10003; ' + esc(zh('提交', 'Commit')) + ' (' + stagedCount + ')'
      : '&#10003; ' + esc(zh('提交', 'Commit'));
    return [
      '<div class="git-commit-box">',
      '<textarea id="git-commit-message" class="git-commit-input" data-gp-message rows="2" placeholder="'
        + esc(placeholder) + '">' + esc(state.commitMessage) + '</textarea>',
      '<button class="git-commit-btn" data-gp-action="commit" ' + (disabled ? 'disabled' : '') + '>' + label + '<span class="git-commit-kbd">Ctrl+&#9166;</span></button>',
      '</div>',
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

  // ── 渲染：图形区（SVG 泳道 + 行文本叠加 + 分支过滤）───────────────

  function refLabel(ref) {
    const name = String(ref?.name || '');
    if (!name) return '';
    if (ref.type === 'head') {
      return '<span class="git-ref is-head"><span class="git-ref-icon">&#9678;</span>' + esc(name) + '</span>';
    }
    if (ref.type === 'remote') {
      return '<span class="git-ref is-remote"><span class="git-ref-icon">&#972;</span>' + esc(name) + '</span>';
    }
    if (ref.type === 'tag') {
      return '<span class="git-ref is-tag">' + esc(name) + '</span>';
    }
    return '<span class="git-ref is-local">' + esc(name) + '</span>';
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

  function renderGraphBody() {
    const commits = state.graph;
    if (state.errors.graph) {
      return '<div class="git-empty-desc">' + esc(zh('历史加载失败：', 'Failed to load history: ')) + esc(state.errors.graph) + '</div>';
    }
    if (!commits.length) {
      return '<div class="git-empty-desc">' + esc(zh('暂无提交', 'No commits yet')) + '</div>';
    }

    const lanes = window.GitGraph.computeLanes(commits);
    const headRow = 0; // log 新→旧，第一行即所选分支顶端
    // 「传出的更改」虚线节点仅在查看当前分支（branch 未过滤）时有意义
    const aheadSet = state.branch ? new Set() : new Set(state.aheadHashes);
    const svg = window.GitGraph.buildGraphSvg(lanes, headRow, aheadSet);

    // 头部区段里第一个「已推送」提交的行号（传出的更改分组行的插入点）
    let outgoingEnd = 0;
    while (outgoingEnd < commits.length && aheadSet.has(commits[outgoingEnd].hash)) outgoingEnd++;
    const hasOutgoing = outgoingEnd > 0 && outgoingEnd < commits.length;

    const rows = commits.map((c, row) => {
      const isHead = row === headRow;
      const refs = (c.refs || []).map(refLabel).join('');
      const outgoingRow = hasOutgoing && row === outgoingEnd
        ? '<div class="git-outgoing-row"><span class="git-outgoing-ring"></span>'
          + '<span class="git-outgoing-label">' + esc(zh('传出的更改', 'Outgoing Changes')) + '</span>'
          + '<span class="git-outgoing-branch">' + esc(state.status?.current || '') + '</span></div>'
        : '';
      const files = state.expandedCommit === c.hash
        ? renderCommitFiles(c.hash)
        : '';
      return [
        outgoingRow,
        '<div class="git-history-row' + (isHead ? ' is-head' : '') + (state.expandedCommit === c.hash ? ' is-expanded' : '') + '" data-gp-commit="' + esc(c.hash) + '" title="' + esc(c.author + ' · ' + c.relTime) + '">',
        '<span class="git-history-text">',
        refs,
        '<span class="git-history-subject">' + esc(c.subject) + '</span>',
        '</span>',
        '</div>',
        files,
      ].join('');
    }).join('');

    const loadMore = commits.length >= state.graphLimit
      ? '<div class="git-load-more"><button class="git-load-more-btn" data-gp-action="load-more" '
        + (state.loading ? 'disabled' : '') + '>' + esc(zh('加载更早的提交', 'Load older commits')) + '</button></div>'
      : '';

    return [
      '<div class="git-history" style="--git-canvas-w:' + svg.width + 'px">',
      '<div class="git-history-canvas">' + svg.svg + '</div>',
      '<div class="git-history-rows">' + rows + loadMore + '</div>',
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

  /** 图形区分支切换：输入框模型切换同款交互（触发按钮 + ccb 式弹层） */
  function renderBranchTrigger() {
    if (!state.branches) return '';
    return [
      '<button class="git-branch-trigger" data-gp-action="branch-menu" title="' + esc(zh('按分支查看历史', 'Filter history by branch')) + '">',
      '<span class="git-branch-trigger-name">' + esc(branchTriggerLabel()) + '</span>',
      '<svg class="git-branch-trigger-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>',
      '</button>',
    ].join('');
  }

  function branchTriggerLabel() {
    if (!state.branch) {
      const current = state.branches?.current || state.status?.current || '';
      return zh('当前分支', 'Current') + (current ? ' · ' + current : '');
    }
    return state.branch;
  }

  function renderBranchMenu() {
    const b = state.branches;
    const item = (name, label, hint) => [
      '<div class="git-bm-item' + (state.branch === name ? ' active' : '') + '" data-gp-branch="' + esc(name) + '">',
      '<span class="git-bm-left"><span class="git-bm-name">' + esc(label) + '</span></span>',
      (hint ? '<span class="git-bm-right"><span class="git-bm-hint">' + esc(hint) + '</span></span>' : ''),
      '</div>',
    ].join('');
    const current = b.current || state.status?.current || '';
    const locals = (b.locals || []).filter((x) => !x.current).map((x) => item(x.name, x.name, x.relTime));
    const remotes = (b.remotes || [])
      .filter((r) => r.name !== 'origin/HEAD')
      .map((r) => item(r.name, r.name, r.relTime));
    return [
      '<div class="git-bm-group-title">' + esc(zh('查看', 'View')) + '</div>',
      item('', zh('当前分支', 'Current') + (current ? ' · ' + current : '')),
      locals.length ? '<div class="git-bm-group-title">' + esc(zh('本地分支', 'Local branches')) + '</div>' + locals.join('') : '',
      remotes.length ? '<div class="git-bm-group-title">' + esc(zh('远程分支', 'Remote branches')) + '</div>' + remotes.join('') : '',
    ].join('');
  }

  function closeBranchMenu() {
    const menu = document.getElementById('git-branch-menu');
    if (menu) menu.remove();
    document.removeEventListener('mousedown', onBranchMenuOutside, true);
  }

  function onBranchMenuOutside(e) {
    const menu = document.getElementById('git-branch-menu');
    if (menu && !menu.contains(e.target)
      && !(e.target.closest && e.target.closest('[data-gp-action="branch-menu"]'))) {
      closeBranchMenu();
    }
  }

  function toggleBranchMenu(e) {
    const btn = e.target.closest('[data-gp-action="branch-menu"]');
    if (!btn) return;
    e.stopPropagation();
    if (document.getElementById('git-branch-menu')) { closeBranchMenu(); return; }
    const rect = btn.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'git-branch-menu';
    menu.className = 'git-branch-menu';
    menu.innerHTML = renderBranchMenu();
    menu.style.left = Math.max(8, rect.left) + 'px';
    menu.style.top = (rect.bottom + 6) + 'px';
    document.body.appendChild(menu);
    document.addEventListener('mousedown', onBranchMenuOutside, true);
  }

  // ── 渲染：分支（上区内部可折叠分区）──────────────────────────────

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

  function renderBranchesBody() {
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
      locals || '<div class="git-empty-desc">' + esc(zh('无本地分支', 'No local branches')) + '</div>',
      remotes ? '<div class="git-sub-group-title">' + esc(zh('远程', 'Remotes')) + '</div>' + remotes : '',
    ].join('');
  }

  function renderStashBody() {
    return '';
  }

  // ── 渲染：双区骨架 ────────────────────────────────────────────────

  function zoneBar(zone, titleHtml, toolsHtml, folded) {
    return [
      '<div class="git-zone-bar" data-gp-zone-bar="' + zone + '">',
      '<span class="git-zone-chev' + (folded ? '' : ' is-open') + '" aria-hidden="true"></span>',
      '<span class="git-zone-title">' + titleHtml + '</span>',
      '<span class="git-zone-tools">' + (toolsHtml || '') + '</span>',
      '</div>',
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

    // ── 上区：更改与暂存 ──
    const refreshBtn = '<button class="git-zone-btn' + (state.loading ? ' is-loading' : '') + '" data-gp-action="refresh" title="'
      + esc(zh('刷新', 'Refresh')) + '" ' + (state.loading || state.busy ? 'disabled' : '') + '>&#8635;</button>';
    const changesTools = refreshBtn;

    const changesBodyHtml = [
      renderMessage(),
      renderOverview(status),
      renderCommitBox(staged.length),
      subSection('staged', zh('暂存的更改', 'Staged Changes'), staged.length,
        renderFilesList(staged, 'staged'),
        staged.length ? '<button class="git-group-action" data-gp-action="unstage-all">' + esc(zh('全部取消', 'Unstage All')) + '</button>' : '',
        state.subFold.staged),
      conflicts.length ? subSection('conflict', zh('合并冲突', 'Merge Conflicts'), conflicts.length,
        renderFilesList(conflicts, 'conflict'), '', state.subFold.conflict) : '',
      subSection('changes', zh('更改', 'Changes'), changes.length,
        renderFilesList(changes, 'changes'),
        changes.length ? '<button class="git-group-action" data-gp-action="stage-all">' + esc(zh('全部暂存', 'Stage All')) + '</button>' : '',
        state.subFold.changes),
      state.branches ? subSection('branches', zh('分支', 'Branches'),
        (state.branches.locals || []).length + (state.branches.remotes || []).filter((r) => r.name !== 'origin/HEAD').length,
        renderBranchesBody(),
        '<button class="git-group-action" data-gp-action="branch-create">' + esc(zh('新建', 'New')) + '</button>',
        state.subFold.branches) : '',
    ].join('');

    // ── 下区：图形 ──
    const graphTools = renderBranchTrigger()
      + '<button class="git-zone-btn' + (state.loading ? ' is-loading' : '') + '" data-gp-action="refresh" title="'
        + esc(zh('刷新', 'Refresh')) + '" ' + (state.loading || state.busy ? 'disabled' : '') + '>&#8635;</button>';

    const topFolded = state.zoneFold.changes;
    const graphFolded = state.zoneFold.graph;

    return [
      '<div class="git-panel" style="' + (state.topH ? '--git-top-h:' + state.topH + 'px' : '') + '">',
      '<section class="git-zone' + (topFolded ? ' is-folded' : '') + '" data-zone="changes">',
      zoneBar('changes', esc(zh('更改与暂存', 'Changes')), changesTools, topFolded),
      topFolded ? '' : '<div class="git-zone-body" data-zone-body="changes">' + changesBodyHtml + '</div>',
      '</section>',
      topFolded || graphFolded ? '' : '<div class="git-splitter" data-gp-splitter title="' + esc(zh('拖拽调整高度', 'Drag to resize')) + '"></div>',
      '<section class="git-zone' + (graphFolded ? ' is-folded' : '') + '" data-zone="graph">',
      zoneBar('graph', esc(zh('图形', 'Graph')), graphTools, graphFolded),
      graphFolded ? '' : '<div class="git-zone-body git-graph-scroll" data-zone-body="graph">' + renderGraphBody() + '</div>',
      '</section>',
      '</div>',
    ].join('');
  }

  // ── 滚动位置保持（repaint 重建 DOM 后恢复各区滚动）────────────────

  function captureScroll() {
    const c = document.querySelector('.git-zone-body[data-zone-body="changes"]');
    const g = document.querySelector('.git-zone-body[data-zone-body="graph"]');
    if (c) state.changesScroll = c.scrollTop;
    if (g) state.graphScroll = g.scrollTop;
  }

  function restoreScroll() {
    requestAnimationFrame(() => {
      const c = document.querySelector('.git-zone-body[data-zone-body="changes"]');
      const g = document.querySelector('.git-zone-body[data-zone-body="graph"]');
      if (c) c.scrollTop = state.changesScroll || 0;
      if (g) g.scrollTop = state.graphScroll || 0;
    });
  }

  function render() {
    captureScroll();
    watchDir();
    // 首次切入时会话数据可能未就绪：启动带退避的目录就绪轮询
    if (!state.dir || (!state.status && !state.loading && !state.error)) {
      ensureLoaded(0);
    }
    const html = buildHtml();
    restoreScroll();
    return html;
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

  function toggleCommit(hash) {
    if (state.expandedCommit === hash) {
      state.expandedCommit = '';
    } else {
      state.expandedCommit = hash;
      ensureCommitFiles(hash);
    }
    repaint();
  }

  // ── 分隔条拖拽（上下区高度调节）───────────────────────────────────

  function onSplitterDown(e) {
    const splitter = e.target.closest('[data-gp-splitter]');
    if (!splitter) return;
    const panel = document.querySelector('.git-panel');
    if (!panel) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const minY = 140;
    const maxY = Math.max(minY + 100, rect.height - 160);
    function move(ev) {
      const h = Math.max(minY, Math.min(maxY, ev.clientY - rect.top));
      state.topH = Math.round(h);
      panel.style.setProperty('--git-top-h', state.topH + 'px');
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      saveLayout();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // ── 事件委托（对齐 todo-plan.js 的 featurePanelBody 模式）────────

  featurePanelBody.addEventListener('mousedown', onSplitterDown);

  featurePanelBody.addEventListener('click', (e) => {
    // 分区头折叠（自管状态，不经原生 details）
    const subHead = e.target.closest('.git-sub-head');
    if (subHead && !e.target.closest('button')) {
      const key = subHead.closest('[data-gp-sub]')?.dataset.gpSub || '';
      if (key in state.subFold) {
        state.subFold[key] = !state.subFold[key];
        saveLayout();
        repaint();
      }
      return;
    }
    // 大区标题栏折叠（点工具按钮/选择器除外）
    const zoneBarEl = e.target.closest('[data-gp-zone-bar]');
    if (zoneBarEl && !e.target.closest('button, select')) {
      const zone = zoneBarEl.dataset.gpZoneBar || '';
      if (zone in state.zoneFold) {
        state.zoneFold[zone] = !state.zoneFold[zone];
        saveLayout();
        repaint();
      }
      return;
    }

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
    } else if (action === 'load-more') {
      state.graphLimit += 120;
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
    } else if (action === 'branch-menu') {
      toggleBranchMenu(e);
    }
  });

  // 分支弹层菜单项点击（菜单挂在 body 上，面板委托覆盖不到，独立监听）
  document.body.addEventListener('click', (e) => {
    const item = e.target.closest('#git-branch-menu [data-gp-branch]');
    if (!item) return;
    e.preventDefault();
    state.branch = item.dataset.gpBranch || '';
    state.graphLimit = 120;
    state.graphScroll = 0;
    state.expandedCommit = '';
    closeBranchMenu();
    loadAll();
  });

  featurePanelBody.addEventListener('input', (e) => {
    const ta = e.target.closest('textarea[data-gp-message]');
    if (!ta) return;
    state.commitMessage = ta.value;
  });

  // Ctrl+Enter 快捷提交（VS Code SCM 同款）
  featurePanelBody.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.closest('textarea[data-gp-message]')) {
      e.preventDefault();
      doCommit();
    }
  });

  window.GitPanel = {
    render,
    onOpen() {
      ensureLoaded(0);
      if (state.dir && !state.loading) loadAll();
    },
    refresh,
  };
})();
