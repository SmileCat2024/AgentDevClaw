/**
 * home-dashboard.js — 首页 Dashboard 渲染模块
 *
 * 当 agent 为 home 时，取代原来的 hero + launcher-grid blocks，
 * 展示全局概览 Dashboard：模型用量、IM 渠道、工作群、最近会话。
 *
 * 数据来源：
 *   - allAgents (全局)：agent 运行状态
 *   - GET /protoclaw/model_config：模型预设
 *   - GET /protoclaw/usage/summary：今日 token 用量
 *   - GET /protoclaw/im_workspace_bundle：IM 线路绑定
 *   - GET /protoclaw/group_chats：群聊列表
 *   - GET /protoclaw/prebuilt_sessions?agentId=programming-helper：编程小助手会话
 *
 * 依赖（全局变量，声明于 app-core.js / app-main.js）：
 *   - escapeHtml, allAgents, renderCurrentMainView
 *
 * 导出: renderHomeDashboard
 */

// ══════════════════════════════════════════════════════════════
//  数据缓存
// ══════════════════════════════════════════════════════════════

let hdState = {
  modelConfig: null,
  usageSummary: null,
  imBundle: null,
  groupChats: null,
  phSessions: null,       // programming-helper 会话
  loading: false,
  loadedAt: 0,
};

let HD_TTL = 15000;

function hdIsStale() {
  return !hdState.loadedAt || (Date.now() - hdState.loadedAt > HD_TTL);
}

let hdLoadPromise = null;

function hdLoadData(force) {
  if (hdLoadPromise && !force) return hdLoadPromise;
  if (!force && !hdIsStale()) return Promise.resolve();

  hdState.loading = true;
  hdLoadPromise = (async function () {
    let today = new Date();
    let todayStr = today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0');
    let usageParams = 'from=' + todayStr + '&to=' + todayStr + '&groupBy=model';

    let results = await Promise.allSettled([
      fetch('/protoclaw/model_config').then(function (r) { return r.json(); }),
      fetch('/protoclaw/usage/summary?' + usageParams).then(function (r) { return r.json(); }),
      fetch('/protoclaw/im_workspace_bundle').then(function (r) { return r.json(); }),
      fetch('/protoclaw/group_chats').then(function (r) { return r.json(); }),
      fetch('/protoclaw/prebuilt_sessions?agentId=programming-helper').then(function (r) { return r.json(); }),
    ]);

    if (results[0].status === 'fulfilled') hdState.modelConfig = results[0].value;
    if (results[1].status === 'fulfilled') hdState.usageSummary = results[1].value;
    if (results[2].status === 'fulfilled') hdState.imBundle = results[2].value;
    if (results[3].status === 'fulfilled') hdState.groupChats = results[3].value;
    if (results[4].status === 'fulfilled') hdState.phSessions = results[4].value;

    hdState.loading = false;
    hdState.loadedAt = Date.now();
    hdLoadPromise = null;

    if (typeof renderCurrentMainView === 'function') {
      renderCurrentMainView();
    }
  })().catch(function (err) {
    hdState.loading = false;
    hdLoadPromise = null;
    console.error('[HomeDashboard] load error:', err);
  });

  return hdLoadPromise;
}

// ══════════════════════════════════════════════════════════════
//  数据提取辅助
// ══════════════════════════════════════════════════════════════

function hdGetAgent(agentId) {
  return (allAgents || []).find(function (a) { return a.id === agentId && a.source === 'prebuilt'; }) || null;
}

function hdGetUsageTotals() {
  let s = hdState.usageSummary;
  if (!s || !s.totals) return { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 0 };
  let t = s.totals;
  return {
    totalTokens: t.totalTokens || 0,
    inputTokens: t.inputTokens || 0,
    outputTokens: t.outputTokens || 0,
    cacheReadTokens: t.cacheReadTokens || 0,
    requests: t.requests || 0,
  };
}

function hdGetUsageGroups() {
  let s = hdState.usageSummary;
  if (!s || !Array.isArray(s.groups)) return [];
  return s.groups.slice().sort(function (a, b) {
    return (b.totals && b.totals.totalTokens || 0) - (a.totals && a.totals.totalTokens || 0);
  });
}

function hdFormatTokens(value) {
  let n = Number.isFinite(value) ? value : 0;
  if (n >= 1000000000) return (n / 1000000000).toFixed(2) + 'B';
  if (n >= 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function hdGetPHSessions() {
  if (hdState.phSessions && Array.isArray(hdState.phSessions.sessions)) {
    return hdState.phSessions.sessions;
  }
  let agent = hdGetAgent('programming-helper');
  if (agent && agent.workspace_sessions && Array.isArray(agent.workspace_sessions.sessions)) {
    return agent.workspace_sessions.sessions;
  }
  return [];
}

function hdGetIMChannelLabel() {
  let labels = { qq: 'QQ', weixin: '微信', feishu: '飞书', wecom: '企业微信', rokid: 'Rokid 眼镜' };
  if (!hdState.imBundle) return '';
  let wc = hdState.imBundle.workspaceConfig || {};
  let selected = wc.selectedChannel || 'qq';
  return labels[selected] || selected;
}

function hdGetIMLines() {
  if (!hdState.imBundle) return [];
  let wc = hdState.imBundle.workspaceConfig || {};
  return Array.isArray(wc.lines) ? wc.lines : [];
}

function hdGetGroupChats() {
  if (hdState.groupChats && Array.isArray(hdState.groupChats.chats)) {
    return hdState.groupChats.chats;
  }
  return [];
}

function hdTimeAgo(updatedAt) {
  if (!updatedAt) return '';
  let ts = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt);
  if (!ts || isNaN(ts)) return '';
  let diff = Date.now() - ts;
  if (diff < 0) return '';
  let min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + 'm';
  let hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h';
  let day = Math.floor(hr / 24);
  return day + 'd';
}

// ══════════════════════════════════════════════════════════════
//  导航辅助
// ══════════════════════════════════════════════════════════════

function hdNavigate(agentId) {
  if (typeof window.handlePrebuiltAgentClick === 'function') {
    return window.handlePrebuiltAgentClick(agentId);
  } else if (typeof selectWorkspaceSurface === 'function') {
    selectWorkspaceSurface(agentId);
  }
  return Promise.resolve();
}

function hdOpenSession(sessionId) {
  if (typeof window.navigateToWorkspaceSession === 'function') {
    window.navigateToWorkspaceSession('programming-helper', sessionId).catch(function (err) {
      console.error('[HomeDashboard] open session error:', err);
    });
  } else if (typeof window.handlePrebuiltAgentClick === 'function') {
    hdNavigate('programming-helper').then(function () {
      if (typeof window.runWorkspaceAction === 'function') {
        window.runWorkspaceAction(JSON.stringify({ type: 'open_session', sessionId: sessionId }));
      }
    }).catch(function (err) {
      console.error('[HomeDashboard] open session error:', err);
    });
  }
}

function hdOpenSettings() {
  if (typeof openSettings === 'function') {
    openSettings();
  }
}

function hdOpenUsageInfo() {
  if (typeof window.openUsageInfo === 'function') {
    window.openUsageInfo();
  } else if (typeof openSettings === 'function') {
    openSettings();
  }
}

function hdOpenGroupChat(chatId) {
  hdNavigate('work-group').then(function () {
    if (window.WorkGroupUI && typeof window.WorkGroupUI.selectChat === 'function') {
      window.WorkGroupUI.selectChat(chatId);
    }
  }).catch(function (err) {
    console.error('[HomeDashboard] open group chat error:', err);
  });
}

window.hdNavigate = hdNavigate;
window.hdOpenSession = hdOpenSession;
window.hdOpenSettings = hdOpenSettings;
window.hdOpenUsageInfo = hdOpenUsageInfo;
window.hdOpenGroupChat = hdOpenGroupChat;

// ══════════════════════════════════════════════════════════════
//  子渲染函数
// ══════════════════════════════════════════════════════════════

function renderUsageCard() {
  let totals = hdGetUsageTotals();
  let groups = hdGetUsageGroups();
  let cacheRate = totals.totalTokens > 0
    ? Math.round((totals.cacheReadTokens / totals.totalTokens) * 100) + '%'
    : '—';

  let maxTokens = groups.length > 0 ? (groups[0].totals && groups[0].totals.totalTokens || 1) : 1;
  let barsHtml = groups.slice(0, 3).map(function (g) {
    let tokens = (g.totals && g.totals.totalTokens) || 0;
    let label = g.label || g.modelName || g.key || '未知';
    let percent = Math.max(4, Math.round((tokens / maxTokens) * 100));
    return '<div class="hd-bar-row">' +
      '<div class="hd-bar-label">' + escapeHtml(label) + '</div>' +
      '<div class="hd-bar-value">' + hdFormatTokens(tokens) + '</div>' +
      '<div class="hd-bar-track"><div class="hd-bar-fill" style="width:' + percent + '%"></div></div>' +
    '</div>';
  }).join('');

  return '' +
    '<article class="hd-card hd-usage-card">' +
      '<div class="hd-card-header">' +
        '<div>' +
          '<div class="hd-label">全局</div>' +
          '<h2 class="hd-card-title">今日模型用量</h2>' +
        '</div>' +
        '<button class="small-btn" type="button" onclick="hdOpenUsageInfo()">查看详情</button>' +
      '</div>' +
      '<div class="hd-usage-top">' +
        '<div class="hd-usage-value">' + hdFormatTokens(totals.totalTokens) + '</div>' +
        '<div class="hd-usage-stats">' +
          '<span><strong>' + totals.requests + '</strong> 请求</span>' +
          '<span><strong>' + escapeHtml(cacheRate) + '</strong> 缓存命中</span>' +
        '</div>' +
      '</div>' +
      (barsHtml ? '<div class="hd-bars">' + barsHtml + '</div>' : '<div class="hd-subtle hd-usage-empty">暂无今日用量</div>') +
    '</article>';
}

function renderIMCard() {
  let agent = hdGetAgent('qqbot');
  let isActive = !!(agent && agent.connected);
  let channelLabel = hdGetIMChannelLabel();
  let lines = hdGetIMLines();
  let agentLabels = { 'programming-helper': '编程小助手', 'qqbot': 'IM 渠道', 'work-group': '工作群' };
  let bigStatus = isActive ? (channelLabel ? channelLabel + ' 门户运行中' : '门户运行中') : '门户未启动';

  let linesHtml = lines.map(function (line) {
    let bound = line.boundSession;
    let value;
    if (bound && bound.agentId) {
      value = '绑定 ' + escapeHtml(agentLabels[bound.agentId] || bound.agentId);
    } else {
      value = '<span class="dim">空闲</span>';
    }
    return '<div class="hd-table-row">' +
      '<div class="th">' + escapeHtml(line.label || line.id) + '</div>' +
      '<div class="td">' + value + '</div>' +
    '</div>';
  }).join('');

  let channelsHtml = '';
  if (!linesHtml && hdState.imBundle) {
    let wc = hdState.imBundle.workspaceConfig || {};
    let ch = wc.channels || {};
    let parts = [];
    if (ch.qq && ch.qq.label) parts.push('QQ');
    if (hdState.imBundle.weixinConfig && hdState.imBundle.weixinConfig.configured) parts.push('微信');
    if (hdState.imBundle.feishuConfig && hdState.imBundle.feishuConfig.configured) parts.push('飞书');
    if (hdState.imBundle.rokidConfig && hdState.imBundle.rokidConfig.configured) parts.push('Rokid 眼镜');
    channelsHtml = '<div class="hd-subtle">' + (parts.length ? '已配置渠道：' + escapeHtml(parts.join(' · ')) : '暂无渠道配置') + '</div>';
  }

  return '' +
    '<article class="hd-card hd-im-card">' +
      '<div class="hd-card-header">' +
        '<div>' +
          '<div class="hd-label">通信线路</div>' +
          '<h2 class="hd-card-title">IM 渠道</h2>' +
        '</div>' +
        '<button class="small-btn" type="button" onclick="hdNavigate(\'qqbot\')">进入 IM</button>' +
      '</div>' +
      '<div class="hd-big-status' + (isActive ? '' : ' dim') + '">' + escapeHtml(bigStatus) + '</div>' +
      '<div class="hd-subtle">' + (channelLabel ? '主渠道：' + escapeHtml(channelLabel) : '点击进入 IM 工作空间进行配置') + '</div>' +
      (linesHtml ? '<div class="hd-table">' + linesHtml + '</div>' : channelsHtml) +
    '</article>';
}

function renderWorkGroupCard() {
  let chats = hdGetGroupChats();
  let activeChats = chats.filter(function (c) { return !c.archived; });
  let mainText = activeChats.length > 0
    ? activeChats.length + ' 个群聊'
    : '暂无群聊';

  let itemsHtml = activeChats.slice(0, 5).map(function (chat) {
    let name = chat.name || '未命名群聊';
    let memberCount = chat.memberCount || 0;
    let lastMsg = chat.lastMessage;
    let preview = '';
    let time = '';
    if (lastMsg) {
      let fromPrefix = lastMsg.from ? lastMsg.from + ': ' : '';
      preview = (fromPrefix + (lastMsg.text || '')).slice(0, 60);
      time = hdTimeAgo(lastMsg.timestamp);
    } else {
      preview = memberCount + ' 成员 · 暂无消息';
    }
    return '<div class="hd-chat-item" onclick="hdOpenGroupChat(\'' + escapeHtml(chat.id) + '\')">' +
      '<div class="hd-chat-top">' +
        '<strong>' + escapeHtml(name) + '</strong>' +
        '<span class="hd-chat-time">' + escapeHtml(time) + '</span>' +
      '</div>' +
      '<div class="hd-chat-preview">' + escapeHtml(preview) + '</div>' +
    '</div>';
  }).join('');

  if (!itemsHtml) {
    itemsHtml = '<div class="hd-subtle" style="padding:14px 0">暂无群聊，进入工作群创建</div>';
  }

  return '' +
    '<article class="hd-card hd-group-card">' +
      '<div class="hd-card-header">' +
        '<div>' +
          '<div class="hd-label">协作空间</div>' +
          '<h2 class="hd-card-title">工作群</h2>' +
        '</div>' +
        '<button class="small-btn" type="button" onclick="hdNavigate(\'work-group\')">进入群聊</button>' +
      '</div>' +
      '<div class="hd-group-main">' + escapeHtml(mainText) + '</div>' +
      '<div class="hd-chat-list">' + itemsHtml + '</div>' +
    '</article>';
}

/**
 * 渲染编程小助手最近会话 — 两栏网格布局。
 */
function renderSessionsSection() {
  let sessions = hdGetPHSessions();

  let sorted = sessions.slice().sort(function (a, b) {
    let ta = typeof a.updatedAt === 'number' ? a.updatedAt : Date.parse(a.updatedAt || '');
    let tb = typeof b.updatedAt === 'number' ? b.updatedAt : Date.parse(b.updatedAt || '');
    return (tb || 0) - (ta || 0);
  }).slice(0, 8);

  let itemsHtml = sorted.map(function (s) {
    let title = s.title || s.id || '未命名会话';
    let time = hdTimeAgo(s.updatedAt);
    let cwd = s.cwd || s.openDirectory || '';
    return '<div class="hd-session" onclick="hdOpenSession(\'' + escapeHtml(s.id) + '\')">' +
      '<div class="hd-session-top">' +
        '<strong>' + escapeHtml(title) + '</strong>' +
        '<span class="hd-session-time">' + escapeHtml(time) + '</span>' +
      '</div>' +
      (cwd ? '<div class="hd-session-sub">' + escapeHtml(cwd) + '</div>' : '') +
    '</div>';
  }).join('');

  if (!itemsHtml) {
    itemsHtml = '<div class="hd-subtle" style="padding:16px 0">暂无会话，进入编程小助手开始新对话。</div>';
  }

  return '' +
    '<section class="hd-card hd-sessions">' +
      '<div class="hd-card-header">' +
        '<div>' +
          '<div class="hd-label">编程小助手</div>' +
          '<h2 class="hd-card-title">最近活跃项目</h2>' +
        '</div>' +
        '<button class="small-btn primary" type="button" onclick="hdNavigate(\'programming-helper\')">进入工作空间</button>' +
      '</div>' +
      '<div class="hd-session-grid">' + itemsHtml + '</div>' +
    '</section>';
}

// ══════════════════════════════════════════════════════════════
//  主渲染入口
// ══════════════════════════════════════════════════════════════

function renderHomeDashboard() {
  if (hdIsStale() && !hdState.loading) {
    hdLoadData(false);
  }

  return '' +
    '<main class="hd-page">' +
      '<section class="hd-hero">' +
        '<div class="hd-hero-content">' +
          '<div class="hd-eyebrow">HOMEPAGE</div>' +
          '<h1>欢迎使用 AgentDevClaw</h1>' +
          '<p>查看模型配置、IM 线路、工作群协作和各工作空间的当前状态。</p>' +
        '</div>' +
        '<div class="hd-hero-actions">' +
          '<button class="primary" type="button" onclick="hdOpenSettings()">模型配置</button>' +
        '</div>' +
      '</section>' +

      '<section class="hd-grid">' +
        '<div class="hd-col-left">' +
          renderUsageCard() +
          renderIMCard() +
        '</div>' +
        renderWorkGroupCard() +
      '</section>' +

      renderSessionsSection() +
    '</main>';
}
