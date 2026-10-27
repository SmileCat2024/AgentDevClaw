/**
 * trim-page.js — 统一精简页面（按比例 + 按轮次两模式）
 *
 * 左栏为贯穿时间轴（轮次节点、切点与状态统一落在轴上），
 * 右栏配置（模式切换 / 比例滑动条 + 数值框 / 摘要 / 归档 / 技能保护 / 读数）。
 *
 * 按比例模式：TrimRatioCore（trim-ratio-core.js）本地重算切点，全部纯前端、
 * 不重复请求；提交 policy = { preservedMsgRanges: [[cutIndex, last]] }。
 * 单轮体量过大切线落入轮内时，该轮自动展开 assistant 回复锚点与工具段级切点。
 * 按轮次模式（默认）：逐轮勾选（非连续），policy 与旧对话框一致。
 * 提交编排（navGuard / 归档乐观回滚 / sidebar operation / 远程切换）自
 * session-dialogs.js submitTrimCompact 原样迁移。
 *
 * 依赖全局状态 (定义在 app-core.js): currentLanguage, allAgents, currentRuntimeAgentId,
 *   _navigationGuardEpoch, bumpNavigationGuard, lastRenderedWorkspaceHtml
 * 依赖全局函数: renderCurrentMainView, escapeHtml, closeCompactMenu,
 *   getCurrentAgentRecord, createCompactedResumeSession, loadAgents,
 *   setPreferredUnitMode, markSessionLoading, clearSessionLoading,
 *   markSessionArchivedForMutation, beginSidebarOperation, getSidebarOperation,
 *   updateSidebarOperation, finishSidebarOperation,
 *   applySidebarMutationDeltaWithDiagnostics, applySessionMutationDelta,
 *   requestArchivedSourceRuntimeCleanup, upsertConnectedAgent, getRuntimeId,
 *   isRemoteNamespaceAgentId, beginChatLoadingSession, clearChatLoadingSession,
 *   requestSwitch, getWorkspaceSessionById, getPathLeaf,
 *   fmtPct (app-core.js，trim/branch 共用口径),
 *   window.RemoteConnections (远程精简切换)
 * 依赖模块: TrimRatioCore (trim-ratio-core.js, window 挂载)
 * 导出全局函数 (window.*): openTrimPage, closeTrimPage, submitTrimPage
 */

/* ── Page state ── */
let trimPageState = {
  agentId: '', sessionId: '',
  messages: [], rounds: [], preambleCharCount: 0, preamblePercent: 0,
  mode: 'manual', ratio: 30, cutIndex: 0, unmet: false, ratioInitialized: false,
  ratioSupported: true,

  keepSkillInvokes: 5, loading: false,
};
// 打开序号：open / close 各自递增；预览响应归来序号不符即丢弃——
// 快开 A（慢响应）再开 B（快响应）时，A 的数据不允许覆盖 B 的页面状态。
let trimPageSeq = 0;

const trimPageEl = document.getElementById('trim-page');
const trimPageList = document.getElementById('trim-page-list');
const trimPageTitle = document.getElementById('trim-page-title');
const trimPageSubmitBtn = document.getElementById('trim-page-submit');
const trimPageModeBtns = document.getElementById('trim-page-mode');
const trimPageRatioConfig = document.getElementById('trim-page-ratio-config');
const trimPageManualConfig = document.getElementById('trim-page-manual-config');
const trimPageRatioSlider = document.getElementById('trim-page-ratio-slider');
const trimPageRatioInput = document.getElementById('trim-page-ratio-input');
const trimPageReadout = document.getElementById('trim-page-readout');
const trimPageSummaryToggle = document.getElementById('trim-page-summary-toggle');
const trimPageArchiveToggle = document.getElementById('trim-page-archive-toggle');
const trimPageArchiveRow = document.getElementById('trim-page-archive-row');
const trimPageKeepSkillToggle = document.getElementById('trim-page-keep-skill-toggle');
const trimPageKeepSkillControl = document.getElementById('trim-page-keep-skill-control');
const trimPageKeepSkillValue = document.getElementById('trim-page-keep-skill-value');
const trimPageKeepSkillDec = document.getElementById('trim-page-keep-skill-dec');
const trimPageKeepSkillInc = document.getElementById('trim-page-keep-skill-inc');

const TRIM_PAGE_RATIO_STORAGE_KEY = 'claw.trimPage.ratio';
const SKILL_INVOKE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, Infinity];

function L(zh, en) {
  return currentLanguage === 'zh' ? zh : en;
}

/**
 * 线程宿主判定（ADR-0032）：线程会话的精简是同一对话内的上下文接力，
 * 「归档原会话」是 Session 时代的列表语义——归档链中旧快照对用户无可见
 * 效果，与「归档这条对话」的预期错位。线程索引未就绪（首拉前）时保守
 * 回落 Session 语义，与摘要确认文案（workspace-actions）同口径。
 */
function isThreadCarriedSession(agentId, sessionId) {
  return typeof window.isThreadHostAgentId === 'function'
    && window.isThreadHostAgentId(agentId, sessionId);
}

function fmtChars(n) {
  if (n >= 10000) return (n / 1000).toFixed(0) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function clampRatio(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 30;
  return Math.min(95, Math.max(5, n));
}

function readStoredRatio() {
  try {
    const raw = localStorage.getItem(TRIM_PAGE_RATIO_STORAGE_KEY);
    return raw != null ? clampRatio(raw) : 30;
  } catch { return 30; }
}

function storeRatio(value) {
  try { localStorage.setItem(TRIM_PAGE_RATIO_STORAGE_KEY, String(value)); } catch { /* private mode */ }
}

/* ── Skill stepper（与旧对话框行为一致） ── */
function getSkillStepIndex(value) {
  const idx = SKILL_INVOKE_STEPS.indexOf(value);
  return idx >= 0 ? idx : 4; // default 5
}

function renderSkillStepper() {
  const enabled = trimPageKeepSkillToggle.checked;
  trimPageKeepSkillControl.classList.toggle('disabled', !enabled);
  const value = trimPageState.keepSkillInvokes;
  trimPageKeepSkillValue.textContent = value === Infinity ? '∞' : String(value);
}

trimPageKeepSkillToggle.addEventListener('change', () => {
  trimPageState.keepSkillInvokes = trimPageKeepSkillToggle.checked
    ? SKILL_INVOKE_STEPS[4]
    : null;
  renderSkillStepper();
});

trimPageKeepSkillDec.addEventListener('click', () => {
  const cur = getSkillStepIndex(trimPageState.keepSkillInvokes);
  if (cur > 0) {
    trimPageState.keepSkillInvokes = SKILL_INVOKE_STEPS[cur - 1];
    renderSkillStepper();
  }
});

trimPageKeepSkillInc.addEventListener('click', () => {
  const cur = getSkillStepIndex(trimPageState.keepSkillInvokes);
  if (cur < SKILL_INVOKE_STEPS.length - 1) {
    trimPageState.keepSkillInvokes = SKILL_INVOKE_STEPS[cur + 1];
    renderSkillStepper();
  }
});

/* ── Submit label：跟随「生成摘要 / 归档」勾选动态变化，与提交行为同源 ── */
function updateSubmitLabel() {
  const withSummary = trimPageSummaryToggle.checked;
  const withArchive = trimPageArchiveToggle.checked;
  trimPageSubmitBtn.textContent =
    withSummary && withArchive ? L('精简、生成摘要并归档', 'Trim, Summarize & Archive')
    : withSummary ? L('精简并生成摘要', 'Trim & Summarize')
    : withArchive ? L('精简并归档', 'Trim & Archive')
    : L('确认精简', 'Confirm Trim');
}

trimPageSummaryToggle.addEventListener('change', updateSubmitLabel);
trimPageArchiveToggle.addEventListener('change', updateSubmitLabel);

/* ── Safe cut set（设切点按钮可见性） ── */
function computeSafeCutSet() {
  const set = new Set();
  if (!window.TrimRatioCore) return set;
  for (const c of window.TrimRatioCore.safeCutCandidates(trimPageState.messages)) {
    set.add(c.cutIndex);
  }
  return set;
}

/* ── Open / close ── */
window.openTrimPage = async (agentId, sessionId, archiveAfter = false) => {
  const seq = ++trimPageSeq;
  // 线程会话不展示「归档原会话」（见 isThreadCarriedSession 注释）
  const onThread = isThreadCarriedSession(agentId, sessionId);
  if (trimPageArchiveRow) trimPageArchiveRow.style.display = onThread ? 'none' : '';
  trimPageState = {
    agentId, sessionId,
    messages: [], rounds: [], preambleCharCount: 0, preamblePercent: 0,
    mode: 'manual', ratio: readStoredRatio(), cutIndex: 0, unmet: false, ratioInitialized: false,
    ratioSupported: true,

    keepSkillInvokes: 5, loading: true,
  };
  trimPageKeepSkillToggle.checked = true;
  trimPageSummaryToggle.checked = false;
  trimPageArchiveToggle.checked = onThread ? false : Boolean(archiveAfter);
  renderSkillStepper();
  closeCompactMenu();

  trimPageTitle.textContent = L('精简对话', 'Trim conversation');
  updateSubmitLabel();
  trimPageSubmitBtn.disabled = true;

  trimPageRatioSlider.value = String(trimPageState.ratio);
  trimPageRatioInput.value = String(trimPageState.ratio);

  trimPageEl.style.display = '';
  trimPageList.innerHTML = `<div class="trim-loading">${L('加载中...', 'Loading...')}</div>`;
  trimPageReadout.textContent = '';

  try {
    const res = await fetch('/protoclaw/session_trim_preview?agentId=' + encodeURIComponent(agentId) + '&sessionId=' + encodeURIComponent(sessionId));
    if (!res.ok) throw new Error(await res.text().catch(() => 'failed'));
    const data = await res.json();
    if (seq !== trimPageSeq) return; // 页面已被关闭或换开了别的会话：丢弃过期响应
    trimPageState.rounds = data.rounds || [];
    for (const round of trimPageState.rounds) {
      round.toolCalls = (round.toolCalls || []).filter((call) => call && typeof call.name === 'string' && call.name !== 'undefined');
    }
    trimPageState.preamblePercent = typeof data.preamblePercent === 'number' ? data.preamblePercent : 0;
    trimPageState.preambleCharCount = typeof data.preambleCharCount === 'number' ? data.preambleCharCount : 0;
    // 远程旧端无 messages 字段（PR-1 前的远程 Claw）：比例模式置灰，按轮次模式照常
    trimPageState.ratioSupported = Array.isArray(data.messages);
    if (trimPageState.ratioSupported) trimPageState.messages = data.messages;
    trimPageState.loading = false;
    if (trimPageState.rounds.length === 0) {
      trimPageList.innerHTML = `<div class="trim-loading">${L('无可用轮次', 'No rounds available')}</div>`;
      return;
    }
    trimPageSubmitBtn.disabled = false;
    applyMode('manual');
    renderList();
    updateReadout();
    if (!trimPageState.ratioSupported) renderRatioUnsupported();
  } catch (err) {
    if (seq !== trimPageSeq) return; // 过期响应的报错也不渲染到后来的页面上
    trimPageList.innerHTML = `<div class="trim-loading">${L('加载失败：', 'Load failed: ')}${escapeHtml(err.message || err)}</div>`;
    trimPageReadout.textContent = '';
  }
};

window.closeTrimPage = () => {
  trimPageSeq++;
  trimPageEl.style.display = 'none';
  trimPageState = {
    agentId: '', sessionId: '',
    messages: [], rounds: [], preambleCharCount: 0, preamblePercent: 0,
    mode: 'manual', ratio: readStoredRatio(), cutIndex: 0, unmet: false, ratioInitialized: false,
    ratioSupported: true,

    keepSkillInvokes: 5, loading: false,
  };
};

/* ── Mode switching ── */
function applyMode(mode) {
  trimPageState.mode = mode;
  trimPageModeBtns.querySelectorAll('.trim-page-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  trimPageRatioConfig.style.display = mode === 'ratio' ? '' : 'none';
  trimPageManualConfig.style.display = mode === 'manual' ? '' : 'none';
}

trimPageModeBtns.addEventListener('click', (event) => {
  const btn = event.target.closest('.trim-page-mode-btn');
  if (!btn || !trimPageState.rounds.length) return;
  if (btn.dataset.mode === 'ratio' && !trimPageState.ratioSupported) return;
  applyMode(btn.dataset.mode);
  if (btn.dataset.mode === 'ratio' && !trimPageState.ratioInitialized) {
    applyRatioFromControl(); // 内部完成首次切点计算与渲染
  } else {
    renderList();
    updateReadout();
  }
});

function renderRatioUnsupported() {
  trimPageRatioConfig.innerHTML = `<div class="trim-page-config-label">${L('远程端版本过旧，暂不支持比例精简', 'Remote host is too old for ratio trimming')}</div>`;
  trimPageRatioConfig.style.opacity = '0.5';
  const ratioBtn = trimPageModeBtns.querySelector('[data-mode="ratio"]');
  if (ratioBtn) ratioBtn.disabled = true;
}

/* ── Ratio controls ── */
function applyRatioFromControl() {
  const ratio = clampRatio(trimPageRatioSlider.value);
  trimPageState.ratio = ratio;
  trimPageState.ratioInitialized = true;
  const result = window.TrimRatioCore.ratioToCut(
    trimPageState.messages, trimPageState.preambleCharCount, ratio / 100);
  trimPageState.cutIndex = result.cutIndex;
  trimPageState.unmet = result.unmet;
  renderList();
  updateReadout();
}

trimPageRatioSlider.addEventListener('input', () => {
  const ratio = clampRatio(trimPageRatioSlider.value);
  trimPageRatioInput.value = String(ratio);
  storeRatio(ratio);
  applyRatioFromControl();
});

trimPageRatioInput.addEventListener('change', () => {
  const ratio = clampRatio(trimPageRatioInput.value);
  trimPageRatioInput.value = String(ratio);
  trimPageRatioSlider.value = String(ratio);
  storeRatio(ratio);
  applyRatioFromControl();
});

// 悬停滑轨/数值框时滚轮微调（上滚 +1 / 下滚 -1），免去长按拖动
function onRatioWheelAdjust(event) {
  if (trimPageState.mode !== 'ratio' || !trimPageState.ratioSupported) return;
  event.preventDefault();
  const delta = event.deltaY < 0 ? 1 : -1;
  const ratio = clampRatio((parseInt(trimPageRatioSlider.value, 10) || 5) + delta);
  trimPageRatioSlider.value = String(ratio);
  trimPageRatioInput.value = String(ratio);
  storeRatio(ratio);
  applyRatioFromControl();
}
trimPageRatioSlider.addEventListener('wheel', onRatioWheelAdjust, { passive: false });
trimPageRatioInput.addEventListener('wheel', onRatioWheelAdjust, { passive: false });

/* ── Left pane: timeline rendering ── */

// 轴节点：系统上下文（时间轴起点，弱呈现）
function renderPreambleNode() {
  if (trimPageState.preamblePercent <= 0) return '';
  return `<div class="trim-tl-node preamble"><div class="trim-tl-sub">${L('系统上下文', 'System context')} · ${fmtPct(trimPageState.preamblePercent)}</div></div>`;
}

// 比例模式时间轴：每轮包含用户输入锚点、assistant 回复锚点与对应工具调用摘要
function aggregateRounds(messages) {
  const rounds = [];
  let cur = null;
  for (const m of messages) {
    if (m.roundIndex == null) continue;
    if (!cur || cur.roundIndex !== m.roundIndex) {
      cur = { roundIndex: m.roundIndex, startIndex: m.index, endIndex: m.index,
              userPreview: '', assistantPreview: '', toolSummaries: [], charCount: 0 };
      rounds.push(cur);
    }
    cur.endIndex = m.index;
    cur.charCount += m.charCount || 0;
    if (m.role === 'user' && !cur.userPreview) cur.userPreview = (m.preview || '').slice(0, 90);
    if (m.role === 'assistant') {
      if (m.preview && !cur.assistantPreview) cur.assistantPreview = m.preview.slice(0, 90);
      for (const tc of (m.toolCalls || [])) {
        const name = typeof tc?.name === 'string' ? tc.name.trim() : '';
        if (name && name !== 'undefined' && name !== 'null') cur.toolSummaries.push(name);
      }
    }
  }
  return rounds;
}

// 工具活动只显示工具名与重复次数；参数、路径和结果体量不参与轮卡片摘要
function foldToolSummaries(list) {
  const counts = new Map();
  for (const raw of list) {
    const summary = typeof raw === 'string' ? raw.trim() : '';
    const name = summary ? summary.split('(', 1)[0].trim() : '';
    if (!name || name === 'undefined' || name === 'null') continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  const entries = [...counts.entries()];
  const visible = entries.slice(0, 3).map(([name, count]) => count > 1 ? `${name} ×${count}` : name);
  if (entries.length > visible.length) visible.push(`+${entries.length - visible.length}`);
  return visible.join(' · ');
}

// 轮内详情：assistant 回复为锚点节点，连续工具调用+结果合并为工具段（引擎折叠同粒度）
function buildRoundDetail(messages, roundIndex) {
  const inRound = messages.filter((m) => m.roundIndex === roundIndex);
  const resultByCallId = new Map();
  for (const m of inRound) {
    if (m.role === 'tool' && m.toolCallId) resultByCallId.set(m.toolCallId, m);
  }
  const nodes = [];
  let pendingTools = null;
  const pushText = (m) => {
    nodes.push({ kind: 'text', role: m.role, preview: (m.preview || '').slice(0, 70), charCount: m.contentCharCount ?? m.charCount ?? 0, cutIndex: m.index + 1 });
  };
  const flushTools = () => {
    if (!pendingTools) return;
    const folded = foldToolSummaries(pendingTools.names);
    nodes.push({ kind: 'tool', label: folded || L('工具活动', 'tools'), charCount: pendingTools.charCount, cutIndex: pendingTools.endIndex + 1 });
    pendingTools = null;
  };
  for (const m of inRound) {
    if (m.role === 'user') {
      flushTools();
      continue;
    }
    const calls = m.role === 'assistant' && (m.toolCalls || []).length ? m.toolCalls : null;
    if (calls) {
      if (m.preview) { flushTools(); pushText(m); }
      if (!pendingTools) pendingTools = { names: [], charCount: 0, endIndex: m.index };
      for (const call of calls) {
        const name = typeof call?.name === 'string' ? call.name.trim() : '';
        if (name && name !== 'undefined' && name !== 'null') pendingTools.names.push(name);
        const result = call.id ? resultByCallId.get(call.id) : null;
        if (result) {
          pendingTools.charCount += result.charCount || 0;
          pendingTools.endIndex = Math.max(pendingTools.endIndex, result.index);
        }
      }
    } else if (m.role === 'assistant') {
      flushTools();
      pushText(m);
    }
  }
  flushTools();
  return nodes;
}

// 比例模式轮节点：folded（轴上空心淡化）/ partial（切线入轮，展开详情）/ kept（实心）
function renderRatioRoundNode(rd, opts) {
  const st = trimPageState;
  const folded = rd.endIndex < st.cutIndex;
  const partial = rd.startIndex < st.cutIndex && rd.endIndex >= st.cutIndex;
  const stateClass = folded ? ' folded' : '';
  const clickable = !folded && !partial && opts.safeCutSet.has(rd.startIndex);
  const pct = opts.totalChars > 0 ? fmtPct(rd.charCount / opts.totalChars) : '';
  const detail = partial ? buildRoundDetail(st.messages, rd.roundIndex) : [];
  const cutAfterUser = partial && st.messages.some((m) => m.roundIndex === rd.roundIndex && m.role === 'user' && m.index + 1 === st.cutIndex);
  const cutInDetail = partial && detail.some((node) => node.cutIndex === st.cutIndex);
  let detailHtml = '';
  if (partial && detail.length) {
    const parts = [];
    let fallbackInserted = false;
    for (const n of detail) {
      // 兜底切点（切点无对应节点边界时）插在第一个更大边界的节点前，
      // 位置与真实保留区一致，不误导「从详情头开始保留」
      if (!cutInDetail && !cutAfterUser && !fallbackInserted && n.cutIndex > st.cutIndex) {
        parts.push(renderCutNode(opts.readout));
        fallbackInserted = true;
      }
      const content = n.kind === 'text'
        ? `<div class="trim-tl-dnode text">${escapeHtml(n.preview || L('（文字回复）', '(text reply)'))} · ${fmtChars(n.charCount)}</div>`
        // chip 可点击 = 安全切点且保留区仍有对话消息；尾部注入 system 之后的
        // 切点保留区只剩注入消息，提交会让末轮对话全部被折叠
        : (opts.safeCutSet.has(n.cutIndex) && window.TrimRatioCore.keepZoneHasDialogue(st.messages, n.cutIndex)
          ? `<button type="button" class="trim-tl-chip" data-set-cut="${n.cutIndex}" title="${L('从此处保留', 'Keep from here')}">${escapeHtml(n.label)} · ${fmtChars(n.charCount)}</button>`
          : `<span class="trim-tl-chip">${escapeHtml(n.label)} · ${fmtChars(n.charCount)}</span>`);
      parts.push(content + (n.cutIndex === st.cutIndex ? renderCutNode(opts.readout) : ''));
    }
    if (!cutInDetail && !cutAfterUser && !fallbackInserted) parts.push(renderCutNode(opts.readout));
    detailHtml = `<div class="trim-tl-detail">${parts.join('')}</div>`;
  }
  return `<div class="trim-tl-node round${stateClass}${clickable ? ' clickable' : ''}"${clickable ? ` data-set-cut="${rd.startIndex}" title="${L('从此轮开始保留', 'Keep from this round')}"` : ''}>
    <div class="trim-tl-title">${escapeHtml(rd.userPreview || L('（无输入）', '(no input)'))}</div>
    <div class="trim-tl-sub">${L('第', 'Round')} ${rd.roundIndex + 1} ${L('轮', '')}${rd.toolSummaries.length ? ` · ${rd.toolSummaries.length} ${L('次调用', 'calls')}` : ''}${pct ? ` · ${pct}` : ''}</div>
    ${cutAfterUser ? renderCutNode(opts.readout) : ''}
    ${detailHtml}
  </div>`;
}

// 按轮次模式轮节点：勾选 = 精简（轴上空心淡化），与比例模式同一时间轴骨架
// 折叠态副行只报调用次数（数字），不列工具名——降低扫读压力
function renderManualRoundNode(r, idx) {
  const checked = r.suggestedTrim ? ' checked' : '';
  const stateClass = r.suggestedTrim ? ' folded' : '';
  const calls = (r.toolCalls || []).filter((tc) => tc && typeof tc.name === 'string' && tc.name !== 'undefined').length;
  const pct = fmtPct(r.charPercent || 0);
  return `<div class="trim-tl-node round manual${stateClass}" data-trim-index="${idx}">
    <div class="trim-tl-title"><input type="checkbox" class="trim-checkbox" data-trim-index="${idx}"${checked} /><span class="trim-tl-title-text">${escapeHtml(r.userPreview || L('（无输入）', '(no input)'))}</span></div>
    <div class="trim-tl-sub">${L('第', 'Round')} ${idx + 1} ${L('轮', '')}${calls ? ` · ${calls} ${L('次调用', 'calls')}` : ''} · ${pct}</div>
    <button class="trim-to-here-btn" type="button" data-trim-to="${idx}">${L('精简到此处', 'Trim to here')}</button>
  </div>`;
}

// 切点：轴上的橙色标记——上方已精简，下方保留
function renderCutNode(readout) {
  return `<div class="trim-tl-cut"><span>${L('保留从这里开始', 'Keep from here')}</span><span class="trim-tl-cut-meta">${L('释放', 'frees')} ${fmtPct(readout.releasedPercent)}</span></div>`;
}

function renderList(opts = {}) {
  const st = trimPageState;
  if (st.loading) return;
  if (!st.rounds.length) {
    trimPageList.innerHTML = `<div class="trim-loading">${L('无可用轮次', 'No rounds available')}</div>`;
    return;
  }
  const isRatioMode = st.mode === 'ratio' && st.ratioSupported;
  const safeCutSet = isRatioMode ? computeSafeCutSet() : null;
  const messages = st.messages;
  let html = renderPreambleNode();

  if (!isRatioMode || !messages.length) {
    // 按轮次模式：同一时间轴，勾选的轮轴点空心淡化
    html += st.rounds.map((r, idx) => renderManualRoundNode(r, idx)).join('');
  } else {
    // 比例模式：轴上找切点——上方已精简（空心），下方保留（实心）
    const readout = window.TrimRatioCore.computeReadout(messages, st.preambleCharCount, st.cutIndex);
    const rounds = aggregateRounds(messages);
    const totalChars = rounds.reduce((sum, r) => sum + r.charCount, 0);
    const opts = { safeCutSet, totalChars, readout };
    const renderOpts = opts;
    let cutRendered = false;
    for (const rd of rounds) {
      if (st.cutIndex > 0 && rd.startIndex === st.cutIndex) {
        html += renderCutNode(readout);
        cutRendered = true;
      }
      html += renderRatioRoundNode(rd, renderOpts);
      if (st.cutIndex > 0 && rd.startIndex < st.cutIndex && st.cutIndex <= rd.endIndex) {
        cutRendered = true; // partial round always renders an exact or fallback cut marker
      }
    }
    if (st.cutIndex > 0 && !cutRendered) html += renderCutNode(readout);
  }

  // 重绘与滚动策略：重绘销毁旧 DOM，一切位置先量后换。算法调值（滑杆/
  // 滚轮/数值框）视口保持不动，切点接近视口边缘时才以最小滚动量带回
  // 安全区——「切点钉屏幕」会把整个列表拖着走，微调时左侧跟着乱滚。
  // 点击设切点（keepScroll）视口完全不动；切点首次出现时居中引入。
  const scrollBody = trimPageList.closest('.trim-page-left') || trimPageList;
  const prevScrollTop = scrollBody.scrollTop;
  const hadCut = Boolean(trimPageList.querySelector('.trim-tl-cut'));
  trimPageList.innerHTML = `<div class="trim-timeline">${html}</div>`;

  if (isRatioMode) {
    const cut = trimPageList.querySelector('.trim-tl-cut');
    if (opts.keepScroll) {
      scrollBody.scrollTop = prevScrollTop;
    } else if (cut && !hadCut) {
      cut.scrollIntoView({ block: 'center' });
    } else if (cut) {
      const view = typeof scrollBody.getBoundingClientRect === 'function' ? scrollBody.getBoundingClientRect() : null;
      const rect = view && typeof cut.getBoundingClientRect === 'function' ? cut.getBoundingClientRect() : null;
      if (view && rect) {
        const margin = (view.bottom - view.top) * 0.15;
        if (rect.top < view.top + margin) {
          scrollBody.scrollTop = Math.max(0, scrollBody.scrollTop + rect.top - (view.top + margin));
        } else if (rect.bottom > view.bottom - margin) {
          scrollBody.scrollTop = Math.max(0, scrollBody.scrollTop + rect.bottom - (view.bottom - margin));
        } else {
          scrollBody.scrollTop = prevScrollTop;
        }
      } else {
        scrollBody.scrollTop = prevScrollTop;
      }
    } else {
      scrollBody.scrollTop = scrollBody.scrollHeight;
    }
  } else {
    scrollBody.scrollTop = prevScrollTop;
  }
}

/* ── Left pane events ── */
trimPageList.addEventListener('click', (event) => {
  // 设为切点（比例模式：轮行或轮内工具段，均为安全边界）
  const cutBtn = event.target.closest('[data-set-cut]');
  if (cutBtn) {
    const cutIndex = parseInt(cutBtn.dataset.setCut, 10);
    if (Number.isFinite(cutIndex) && window.TrimRatioCore) {
      trimPageState.cutIndex = cutIndex;
      trimPageState.unmet = false;
      const ratio = clampRatio(window.TrimRatioCore.cutToRatio(
        trimPageState.messages, trimPageState.preambleCharCount, cutIndex) * 100);
      trimPageState.ratio = ratio;
      trimPageRatioSlider.value = String(ratio);
      trimPageRatioInput.value = String(ratio);
      storeRatio(ratio);
      renderList({ keepScroll: true });
      updateReadout();
    }
    return;
  }
  const toHere = event.target.closest('.trim-to-here-btn[data-trim-to]');
  if (toHere) {
    const targetIdx = parseInt(toHere.dataset.trimTo, 10);
    const rounds = trimPageState.rounds;
    for (let i = 0; i < rounds.length; i++) {
      rounds[i].suggestedTrim = i <= targetIdx;
    }
    renderList();
    updateReadout();
  }
});

trimPageList.addEventListener('change', (event) => {
  const cb = event.target;
  if (!cb.classList.contains('trim-checkbox')) return;
  const idx = parseInt(cb.dataset.trimIndex, 10);
  const item = cb.closest('.trim-tl-node');
  if (cb.checked) item.classList.add('folded');
  else item.classList.remove('folded');
  trimPageState.rounds[idx].suggestedTrim = cb.checked;
  updateReadout();
});

/* ── Readout ── */
function updateReadout() {
  const st = trimPageState;
  if (!st.rounds.length || st.loading) {
    trimPageReadout.textContent = '';
    return;
  }
  if (st.mode === 'ratio' && st.ratioSupported && window.TrimRatioCore) {
    const readout = window.TrimRatioCore.computeReadout(st.messages, st.preambleCharCount, st.cutIndex);
    trimPageReadout.innerHTML = st.unmet
      ? `<div class="trim-page-readout-main">${L('无法达到该比例：对话文本精简后仍保留', 'Target unreachable: dialogue text is kept after trimming')}</div>
         <div class="trim-page-readout-sub">${L('保留', 'Keeps')} ${fmtPct(readout.keptPercent)} · ${readout.keptMessageCount} ${L('条消息', 'msgs')}</div>`
      : `<div class="trim-page-readout-main">${L('保留', 'Keeps')} <b>${fmtPct(readout.keptPercent)}</b> · ${readout.keptMessageCount} ${L('条消息', 'msgs')}</div>
         <div class="trim-page-readout-sub">${L('估算', 'Est.')} ${fmtChars(readout.keptCharCount)} / ${fmtChars(readout.totalCharCount)} ${L('字符 · 释放', 'chars · frees')} ${fmtPct(readout.releasedPercent)}</div>`;
    return;
  }
  // 按轮次模式读数（轮级口径，与旧页脚一致）
  const rounds = st.rounds;
  const trimmed = rounds.filter((r) => r.suggestedTrim);
  const freedPercent = trimmed.reduce((sum, r) => sum + (r.charPercent || 0), 0);
  trimPageReadout.innerHTML = `${L('共', '')} ${rounds.length} ${L('轮，精简', 'rounds, trim')} ${trimmed.length} ${L('轮 · 释放约', '· frees ~')} <span class="trim-footer-pct">${fmtPct(freedPercent)}</span> ${L('上下文', 'context')}`;
}

/* ── Submit（编排自 session-dialogs.js submitTrimCompact 原样迁移） ── */
window.submitTrimPage = async () => {
  const st = trimPageState;
  const { agentId, sessionId, keepSkillInvokes } = st;
  // 归档与摘要跟随勾选框实时值——入口形态只决定初始勾选，不锁死行为。
  // 线程会话提交时重查一次：索引在打开后才就绪时，钳制勾选漏传服务端。
  const archiveAfter = isThreadCarriedSession(agentId, sessionId)
    ? false
    : trimPageArchiveToggle.checked;
  if (!agentId || !sessionId || st.loading) return;

  let policy;
  let trimmedCount;
  if (st.mode === 'ratio' && st.ratioSupported) {
    if (!st.messages.length) return;
    if (st.cutIndex <= 0) {
      window.alert(L('切点未生效（保留区为空即不精简），请调整比例或改用按轮次模式', 'Nothing to trim: adjust the ratio or use the round mode'));
      return;
    }
    // 出口守卫：保留区必须含对话消息——末尾只剩 system 注入消息的切点提交后
    // 末轮对话全部被折叠（历史上由尾部任务提醒注入 + 小比例触发）
    if (window.TrimRatioCore && !window.TrimRatioCore.keepZoneHasDialogue(st.messages, st.cutIndex)) {
      window.alert(L('保留区内没有对话消息，请将切点上移到包含对话内容的位置', 'The keep zone holds no dialogue message; move the cut up to cover dialogue content'));
      return;
    }
    policy = { preservedMsgRanges: [[st.cutIndex, st.messages.length - 1]] };
    const boundaryMsg = st.messages[st.cutIndex - 1];
    trimmedCount = boundaryMsg && boundaryMsg.roundIndex != null ? boundaryMsg.roundIndex + 1 : 0;
  } else {
    if (!st.rounds.length) return;
    // Using preservedTurns instead of fullPreserveFromTurn supports non-contiguous
    // selections. Always set preservedTurns — an explicit signal of user intent;
    // preservedMsgRanges makes the result match the UI selection 1:1 even when
    // multiple user messages share the same turn value (queued inputs).
    const keptRounds = st.rounds.filter((r) => !r.suggestedTrim);
    policy = {
      preservedTurns: keptRounds.map((r) => r.turnStart),
      preservedMsgRanges: keptRounds.map((r) => [r.msgIndexStart, r.msgIndexEnd]),
    };
    trimmedCount = st.rounds.filter((r) => r.suggestedTrim).length;
  }
  if (keepSkillInvokes != null && keepSkillInvokes > 0) {
    policy.keepRecentSkillInvokes = keepSkillInvokes;
  }
  const appendSummary = trimPageSummaryToggle.checked;

  bumpNavigationGuard();
  const _navGuard = _navigationGuardEpoch;

  window.closeTrimPage();
  markSessionLoading(agentId, sessionId);
  const _oldRuntimeId = currentRuntimeAgentId;
  let archiveRollback = null;
  let trimSessionCommitted = false;
  if (archiveAfter && typeof markSessionArchivedForMutation === 'function') {
    archiveRollback = markSessionArchivedForMutation(agentId, sessionId, 'trim');
  }
  const sourceAgent = allAgents.find((item) => item.id === agentId) || null;
  const sourceSession = getWorkspaceSessionById(sourceAgent, sessionId);
  const trimOperation = archiveRollback?.operationId
    ? getSidebarOperation(archiveRollback.operationId)
    : beginSidebarOperation({
        type: 'create',
        kind: 'trim',
        phase: 'generating',
        agentId,
        sourceSessionId: sessionId,
        sourceRuntimeId: _oldRuntimeId || '',
        projectId: sourceSession?.projectId || '',
        projectDir: sourceSession?.openDirectory || '',
        projectName: getPathLeaf(sourceSession?.openDirectory || ''),
        title: sourceSession?.title || '',
      });

  try {
    const result = await createCompactedResumeSession(agentId, sessionId, '', null, null, policy, {
      reason: 'trim',
      trimCutRounds: trimmedCount,
      archiveOriginal: archiveAfter,
      appendSummary,
      operationId: trimOperation?.operationId || '',
    });
    if (typeof applySidebarMutationDeltaWithDiagnostics === 'function') {
      applySidebarMutationDeltaWithDiagnostics(trimOperation?.operationId, agentId, result);
    } else if (typeof applySessionMutationDelta === 'function') {
      applySessionMutationDelta(agentId, result);
    }
    const archiveSucceeded = !archiveAfter || result?.archive?.succeeded === true;
    if (!archiveSucceeded && archiveRollback) {
      archiveRollback();
      archiveRollback = null;
    }
    const isRemoteTrim = typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(sessionId);
    // 归档已提交：源 runtime 处置与新会话导航解耦，立即发起（内部含侧栏条目
    // 的乐观退场）。停靠在导航之后会让老条目等新会话页面完全加载完才开始关闭。
    if (archiveAfter && archiveSucceeded && !isRemoteTrim) {
      requestArchivedSourceRuntimeCleanup(agentId, sessionId, _oldRuntimeId);
    }
    const targetSessionId = String(result?.session?.id || '').trim();
    trimSessionCommitted = Boolean(targetSessionId);
    updateSidebarOperation(trimOperation?.operationId, {
      phase: 'target-starting',
      targetSessionId,
      title: result?.session?.title || trimOperation?.title || '',
      serverRevision: result?.revision ?? null,
    });
    // 线程接续（ADR-0032）：同步模式下响应返回时服务端已推进 head、
    // successor READY。视图不做导航切换——保持原会话身份，refreshThreads
    // 事实对账经 thread-store 唯一重绑实现原地换头（SSE head-advanced 已
    // 处理过则幂等），滚动位置与输入草稿由重绑链路保留。
    if (result?.threadSuccession?.applied === true) {
      finishSidebarOperation(trimOperation?.operationId, 'settled');
      clearSessionLoading(agentId);
      await window.refreshThreads(true).catch(() => {});
    } else {
      // The server has already committed the trimmed session and observed startup.
      // Delayed Viewer registration must not block or downgrade this operation.
      // 远程目标：响应中的 agent 是远程端 runtime 形态（裸 id），不进入本地
      // allAgents——切换走远程目录轮询（见下方 isRemoteTrim 分支）。
      const readyAgent = (isRemoteTrim ? null : result?.agent) || null;
      const targetStopped = false;
      const connectedTarget = readyAgent ? (upsertConnectedAgent(readyAgent) || readyAgent) : null;
      const nextRuntimeId = connectedTarget ? (getRuntimeId(connectedTarget) || null) : null;
      if (archiveAfter && archiveSucceeded) {
        // The server has committed both the successor and source archive. This is
        // the replacement operation's terminal success boundary; source runtime
        // disposal is deliberately not part of this session mutation.
        finishSidebarOperation(trimOperation?.operationId, 'settled');
      } else if (nextRuntimeId) {
        updateSidebarOperation(trimOperation?.operationId, { phase: 'target-ready', targetRuntimeId: nextRuntimeId });
      } else if (targetStopped) {
        updateSidebarOperation(trimOperation?.operationId, { phase: 'degraded', errorCode: 'target_runtime_stopped' });
      } else {
        finishSidebarOperation(trimOperation?.operationId, 'settled');
      }
      if (_navGuard !== _navigationGuardEpoch) {
        if (!archiveAfter && nextRuntimeId) finishSidebarOperation(trimOperation?.operationId, 'settled');
        archiveRollback = null;
        return;
      }
      if (isRemoteTrim) {
        // 远程精简（ADR-0011/0012）：新会话与 runtime 都在远程端，等待远程目录
        // 投影带出新 runtime 后按命名空间引用切换（与 R2-01 activate 同链路）。
        const remoteRuntimeRef = typeof window.RemoteConnections?.waitForRuntimeForSession === 'function'
          ? await window.RemoteConnections.waitForRuntimeForSession(targetSessionId, 50)
          : null;
        if (remoteRuntimeRef && _navGuard === _navigationGuardEpoch) {
          setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
          beginChatLoadingSession();
          await requestSwitch(remoteRuntimeRef, 'trim');
          if (!archiveAfter) finishSidebarOperation(trimOperation?.operationId, 'settled');
        } else {
          lastRenderedWorkspaceHtml = '';
          renderCurrentMainView();
        }
      } else if (nextRuntimeId) {
        setPreferredUnitMode('chat', allAgents.find((agent) => agent.id === agentId) || getCurrentAgentRecord());
        beginChatLoadingSession();
        await requestSwitch(nextRuntimeId, 'trim');
        if (!archiveAfter) finishSidebarOperation(trimOperation?.operationId, 'settled');
      } else {
        lastRenderedWorkspaceHtml = '';
        renderCurrentMainView();
      }
    }
    if (archiveAfter && !archiveSucceeded) {
      window.alert((currentLanguage === 'zh' ? '新会话已创建，但原会话归档失败：' : 'The new session was created, but the original could not be archived: ') + (result?.archive?.error || 'unknown error'));
    }
    loadAgents().catch(e => console.warn(e));
    archiveRollback = null;
  } catch (error) {
    console.error('Failed to trim compact session:', error);
    if (!trimSessionCommitted) {
      if (archiveRollback) {
        archiveRollback();
        archiveRollback = null;
      } else if (trimOperation?.operationId) {
        finishSidebarOperation(trimOperation.operationId, 'failed', { errorCode: 'trim_failed' });
      }
      window.alert((currentLanguage === 'zh' ? '精简失败：' : 'Trim failed: ') + (error?.message || error));
    } else {
      finishSidebarOperation(trimOperation?.operationId, 'settled');
      archiveRollback = null;
    }
    clearSessionLoading(agentId);
    clearChatLoadingSession();
  }
};
