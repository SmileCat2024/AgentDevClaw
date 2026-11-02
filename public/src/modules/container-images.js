/**
 * container-images.js — 智能编码空间设置窗「容器镜像」页
 *
 * 域边界（ADR-0025 对象模型）：页面只呈现宿主工作空间域内的应用——编程小助手
 * 自己 + host 同域声明的子应用（Coder），与设置窗「Coder 策略」页同构。可见与
 * 可操作范围由服务端（server/routes/container-images.js）按名册 host 关系裁决，
 * 本模块纯消费，不做任何归属推导。
 *
 * 页面性质：这是**观测页**，主体是环境事实与镜像清单，不是配置项——所以不套
 * 配置行（左标签 + 右控件）形态。配方全部取既有先例（design-system.md §2）：
 * - 环境结论 → 状态卡（rc-status-card 结构：指示点 + 结论/细节 + 状态徽标）
 * - 镜像/容器 → 列表行（gateway-list 族，与同一设置窗的 MCP 网关页同配方）
 * - 诊断事实 → gateway-detail-row（label / value 两列）
 * - 按钮 → settings-btn 族；行内图标钮 → settings-icon-btn
 * 页面专属样式只有分组标题、次行事实、构建日志、提示条四类（components.css
 * 「PH Container Images 页」区段）。
 *
 * 生命周期：面板经 registerContainerImagesHost 声明挂载元素，元素在 DOM 中即
 * 页面激活（切 tab / 关弹窗会移除元素），轮询与删除确认态据此判断活跃。
 *
 * 依赖（全局）：escapeHtml, currentLanguage
 */

let _ciData = null;
let _ciLoading = false;
let _ciPollTimer = null;
let _ciDeleteArmed = null; // { imageId, revertTimer }
let _ciContainerId = 'ph-container-images-host';
let _ciHostAgentId = 'programming-helper';

const CI_POLL_MS = 2500;
const CI_DELETE_ARM_MS = 4000;

const CI_ICON_REFRESH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/></svg>';
const CI_ICON_DELETE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>';

// 宿主声明：面板提供挂载元素 id 与域宿主 agentId
window.registerContainerImagesHost = function (containerId, hostAgentId) {
  _ciContainerId = String(containerId || 'ph-container-images-host');
  _ciHostAgentId = String(hostAgentId || 'programming-helper');
};

function ciContainer() {
  return document.getElementById(_ciContainerId);
}

function ciIsZh() {
  return currentLanguage === 'zh';
}

function ciEscape(value) {
  return escapeHtml(String(value ?? ''));
}

function ciFormatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
  return Math.round(bytes / 1024 ** 2) + ' MB';
}

function ciFormatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toLocaleString(ciIsZh() ? 'zh-CN' : 'en-US', { hour12: false });
}

function ciFormatRelative(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return ciIsZh() ? '刚刚' : 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return ciIsZh() ? minutes + ' 分钟前' : minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ciIsZh() ? hours + ' 小时前' : hours + 'h ago';
  const days = Math.round(hours / 24);
  return ciIsZh() ? days + ' 天前' : days + 'd ago';
}

// ── 原子：状态行 / 列表行 / 诊断行 ────────────────────────────────

/**
 * 环境状态行：照 MCP 网关页的列表项形态（左=状态点 + 事实名 + 依据，
 * 右=状态徽标）。环境事实是「名称 + 现状 + 是否就绪」，用列表行表达比
 * 配置行准确，也避免三张大卡片只装三行短事实。
 */
function ciEnvRow({ tone, nameHtml, facts, badgeText, badgeTone }) {
  const detail = (facts || []).filter(Boolean).join('<span class="gateway-dot-sep">·</span>');
  return [
    '<div class="gateway-list-item">',
    '  <div class="gateway-list-row">',
    '    <div class="gateway-item-left">',
    '      <span class="ci-dot ' + tone + '"></span>',
    '      <div class="gateway-item-text">',
    '        <div class="gateway-item-name">' + nameHtml + '</div>',
    (detail ? '        <div class="gateway-item-detail">' + detail + '</div>' : ''),
    '      </div>',
    '    </div>',
    (badgeText
      ? '    <div class="gateway-item-right"><span class="gateway-status-slot">'
        + ciBadge(badgeText, badgeTone) + '</span></div>'
      : ''),
    '  </div>',
    '</div>',
  ].join('');
}

function ciBadge(text, tone) {
  const cls = tone === 'ok' || tone === 'bad' || tone === 'warn' ? ' ' + tone : '';
  return '<span class="ci-badge' + cls + '">' + ciEscape(text) + '</span>';
}

function ciGroupHead(labelHtml, actionsHtml) {
  return '<div class="ci-group-head"><div class="ci-group-label">' + labelHtml + '</div>'
    + (actionsHtml || '') + '</div>';
}

function ciDetailRow(label, valueHtml, mono = false) {
  if (!valueHtml) return '';
  return '<div class="gateway-detail-row"><span class="gateway-detail-label">' + ciEscape(label) + '</span>'
    + '<span class="gateway-detail-val' + (mono ? ' mono' : '') + '">' + valueHtml + '</span></div>';
}

// ── 环境观测 ─────────────────────────────────────────────────────

function ciRenderEnvironmentSection(data) {
  const isZh = ciIsZh();
  const rows = [];

  rows.push(ciEnvRow({
    tone: data.docker.reachable ? 'ok' : 'bad',
    nameHtml: ciEscape(isZh ? '容器运行时' : 'Container runtime'),
    facts: data.docker.reachable
      ? [ciEscape('Docker ' + (data.docker.version || '?')),
        data.docker.apiVersion ? ciEscape('API ' + data.docker.apiVersion) : '']
      : [ciEscape(isZh ? '启动 Docker Desktop 后点击刷新' : 'Start Docker Desktop, then refresh'),
        data.docker.error ? ciEscape(data.docker.error) : ''],
    badgeText: data.docker.reachable ? (isZh ? '已连接' : 'Connected') : (isZh ? '不可达' : 'Unreachable'),
    badgeTone: data.docker.reachable ? 'ok' : 'bad',
  }));

  const executorName = data.executor.configured === 'container'
    ? (isZh ? '容器' : 'Container')
    : (isZh ? '本地' : 'Local');
  rows.push(ciEnvRow({
    tone: 'info',
    nameHtml: ciEscape(isZh ? '执行环境 · ' + executorName : 'Execution environment · ' + executorName),
    facts: [
      data.executor.source === 'env'
        ? ciEscape('CLAW_RUNTIME_EXECUTOR' + (data.executor.agentFilter ? ' · ' + data.executor.agentFilter : ''))
        : ciEscape(isZh ? '未显式设置，按默认本地执行' : 'Not set explicitly; local by default'),
      data.executor.imageOverride
        ? ciEscape((isZh ? '镜像覆盖 ' : 'Image override ') + data.executor.imageOverride)
        : '',
    ],
  }));

  const gatewayReady = Boolean(data.gateway.viewerAddr) && Boolean(data.gateway.httpBind);
  rows.push(ciEnvRow({
    tone: gatewayReady ? 'ok' : 'bad',
    nameHtml: ciEscape(isZh ? '平台网关' : 'Platform gateway'),
    facts: gatewayReady
      ? [ciEscape(data.gateway.viewerAddr), ciEscape(isZh ? 'HTTP 绑定 ' : 'HTTP bind ') + ciEscape(data.gateway.httpBind)]
      : [ciEscape(isZh
        ? '缺少 AGENTDEV_VIEWER_ADDR 或 HTTP 绑定，容器无法连回平台'
        : 'Missing AGENTDEV_VIEWER_ADDR or HTTP bind; containers cannot reach the platform')],
    badgeText: gatewayReady ? (isZh ? '就绪' : 'Ready') : (isZh ? '未配置' : 'Missing'),
    badgeTone: gatewayReady ? 'ok' : 'bad',
  }));

  if (!data.host.devTree) {
    rows.push(ciEnvRow({
      tone: 'info',
      nameHtml: ciEscape(isZh ? '宿主代码 · 桌面安装态' : 'Host code · desktop install'),
      facts: [ciEscape(isZh
        ? '当前运行树不带 git 信息，不做镜像一致性核对'
        : 'No git metadata in this tree; image consistency is not checked')],
    }));
  }

  return '<div class="gateway-list">' + rows.join('') + '</div>';
}

// ── 镜像清单 ─────────────────────────────────────────────────────

function ciOccupancyFor(imageId) {
  return (_ciData?.containers || []).filter((c) => c.imageId === imageId);
}

/**
 * 镜像行：列表行（gateway-list 族）。左=名称与事实，右=一致性徽标 + 删除钮。
 * 一致性只提示不阻断（ADR-0037：版本对齐靠产品层核对，不拦启动）。
 */
function ciImageRow(image, agentId) {
  const isZh = ciIsZh();
  const inUse = ciOccupancyFor(image.id);
  const mainTag = image.primary
    ? image.tags.find((t) => t.endsWith(':' + agentId)) || image.tags[0]
    : image.tags[0];
  const otherTags = image.tags.filter((t) => t !== mainTag);
  const armed = _ciDeleteArmed?.imageId === image.id;

  const consistency = image.consistency || { state: 'unknown' };
  const consistencyMap = {
    ok: { text: isZh ? '一致' : 'Current', tone: 'ok', title: isZh ? '镜像与宿主代码一致' : 'Image matches host code' },
    stale: { text: isZh ? '已过期' : 'Stale', tone: 'warn', title: (isZh ? '镜像构建后代码已变动 · 镜像 ' : 'Code changed after build · image ') + (consistency.imageCommit || '?') },
    unknown: { text: isZh ? '不可判定' : 'Unknown', tone: 'none', title: ciUnknownReason(consistency.reason) },
  };
  const badge = consistencyMap[consistency.state] || consistencyMap.unknown;

  const detailParts = [
    '<span>' + ciEscape(image.revision || (isZh ? '无版本标记' : 'no revision')) + '</span>',
    '<span class="gateway-dot-sep">·</span>',
    '<span>' + ciEscape(ciFormatRelative(image.createdMs)) + '</span>',
    '<span class="gateway-dot-sep">·</span>',
    '<span>' + ciEscape(ciFormatSize(image.sizeBytes)) + '</span>',
  ];
  if (inUse.length) {
    detailParts.push('<span class="gateway-dot-sep">·</span>');
    detailParts.push('<span>' + ciEscape(isZh ? inUse.length + ' 个运行中容器使用' : inUse.length + ' running container(s)') + '</span>');
  }

  const deleteTitle = inUse.length
    ? (isZh ? '有 ' + inUse.length + ' 个运行中容器正在使用，不能删除' : 'In use by ' + inUse.length + ' running container(s)')
    : armed
      ? (isZh ? '再次点击确认删除' : 'Click again to confirm')
      : (isZh ? '删除镜像' : 'Delete image');

  // 删除：空闲态是行内图标钮（settings-icon-btn 配方）；待确认态换成文字钮，
  // 避免 28px 图标钮塞进「确认」两字挤压变形
  const deleteHtml = inUse.length
    ? '<button class="settings-icon-btn" type="button" disabled style="opacity:0.4;cursor:not-allowed;" title="'
      + ciEscape(deleteTitle) + '">' + CI_ICON_DELETE + '</button>'
    : armed
      ? '<button class="settings-btn settings-btn-secondary" type="button" style="padding:5px 10px;font-size:11px;min-height:30px;color:var(--error-color);" title="'
        + ciEscape(deleteTitle) + '" onclick="onCiDeleteClick(\'' + ciEscape(image.id) + '\', \'' + ciEscape(mainTag || image.id) + '\')">'
        + ciEscape(isZh ? '确认删除' : 'Delete') + '</button>'
      : '<button class="settings-icon-btn danger" type="button" title="' + ciEscape(deleteTitle)
        + '" onclick="onCiDeleteClick(\'' + ciEscape(image.id) + '\', \'' + ciEscape(mainTag || image.id) + '\')">'
        + CI_ICON_DELETE + '</button>';

  return [
    '<div class="gateway-list-item">',
    '  <div class="gateway-list-row">',
    '    <div class="gateway-item-text">',
    '      <div class="gateway-item-name" style="word-break:break-all;">' + ciEscape(mainTag || image.id) + '</div>',
    '      <div class="gateway-item-detail">' + detailParts.join('') + '</div>',
    (otherTags.length
      ? '      <div class="gateway-item-detail"><span>' + ciEscape((isZh ? '其他标签 ' : 'other tags ') + otherTags.join(', ')) + '</span></div>'
      : ''),
    '    </div>',
    '    <div class="gateway-item-right">',
    '      <span class="gateway-status-slot">' + ciBadge(badge.text, badge.tone) + '</span>',
    '      <div class="gateway-actions">' + deleteHtml + '</div>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join('');
}

function ciUnknownReason(reason) {
  const isZh = ciIsZh();
  const reasons = {
    host_dirty: isZh ? '宿主代码含本地改动，无法精确核对' : 'Host code has local edits; cannot verify precisely',
    image_dirty: isZh ? '镜像由含本地改动的代码构建' : 'Image built from dirty code',
    no_revision: isZh ? '镜像无版本标记' : 'Image has no revision label',
    host_not_dev_tree: isZh ? '宿主非开发树' : 'Host is not a dev tree',
  };
  return reasons[reason] || (isZh ? '无法精确核对' : 'Cannot verify precisely');
}

function ciRenderAgentGroup(group, data) {
  const isZh = ciIsZh();
  const canBuild = Boolean(data.buildAvailable && data.host.devTree);
  const label = ciEscape(group.name);

  const actions = [];
  if (canBuild) {
    const building = data.buildJob?.running && data.buildJob?.agentId === group.id;
    // 分组标题旁的动作：走 settings-btn 基座但收小到与 12px 标签同权（同
    // settings-catalog-toolbar .settings-btn 的紧凑档），避免在标题行显得笨重
    actions.push('<button class="settings-btn settings-btn-secondary" type="button"'
      + (data.buildJob?.running ? ' disabled style="opacity:0.5;cursor:not-allowed;"' : '')
      + ' style="min-height:28px;padding:4px 12px;font-size:12px;"'
      + ' title="npm run pack:container -- --agent=' + ciEscape(group.id) + '"'
      + ' onclick="onCiBuildClick(\'' + ciEscape(group.id) + '\')">'
      + ciEscape(building ? (isZh ? '构建中…' : 'Building…') : (isZh ? '构建镜像' : 'Build image')) + '</button>');
  }

  const body = group.images.length
    ? '<div class="gateway-list">' + group.images.map((image) => ciImageRow(image, group.id)).join('') + '</div>'
    : '<div class="gateway-list"><div class="gateway-list-empty">'
      + ciEscape(data.docker.reachable
        ? (isZh ? '尚未构建镜像' : 'No image built yet')
        : (isZh ? '容器运行时不可达，无法读取镜像' : 'Container runtime unreachable; cannot list images'))
      + '</div></div>';

  return '<div class="ci-group">' + ciGroupHead(label, actions.join('')) + body + '</div>';
}

function ciRenderImagesSection(data) {
  const isZh = ciIsZh();
  const groups = (data.agents || []).map((group) => ciRenderAgentGroup(group, data)).join('');
  const hint = data.buildAvailable
    ? ''
    : '<div class="ci-status-line">'
      + ciEscape(isZh
        ? '当前运行树没有构建脚本（桌面安装态），镜像需在源码树构建。'
        : 'This tree has no build script (desktop install); build images in the source tree.')
      + '</div>';
  return groups + hint;
}

// ── 运行中容器 ───────────────────────────────────────────────────

function ciRenderContainersSection(data) {
  const isZh = ciIsZh();
  const containers = Array.isArray(data.containers) ? data.containers : [];
  const stateLabel = (state) => {
    const labels = {
      running: isZh ? '运行中' : 'running',
      created: isZh ? '已创建' : 'created',
      exited: isZh ? '已退出' : 'exited',
      paused: isZh ? '已暂停' : 'paused',
    };
    return labels[state] || state || '—';
  };
  const body = containers.length
    ? '<div class="gateway-list">' + containers.map((c) => {
      const agent = (data.agents || []).find((a) => a.id === c.agentId);
      const detail = [
        '<span>' + ciEscape(agent?.name || c.agentId) + '</span>',
        '<span class="gateway-dot-sep">·</span>',
        '<span>' + ciEscape(c.sessionId || c.name) + '</span>',
        '<span class="gateway-dot-sep">·</span>',
        '<span>' + ciEscape(ciFormatRelative(c.createdMs)) + '</span>',
      ].join('');
      return '<div class="gateway-list-item"><div class="gateway-list-row">'
        + '<div class="gateway-item-text"><div class="gateway-item-name" style="word-break:break-all;">'
        + ciEscape(c.name) + '</div><div class="gateway-item-detail">' + detail + '</div></div>'
        + '<div class="gateway-item-right"><span class="gateway-status-slot">'
        + ciBadge(stateLabel(c.state), c.state === 'running' ? 'ok' : 'none')
        + '</span></div></div></div>';
    }).join('') + '</div>'
    : '<div class="gateway-list"><div class="gateway-list-empty">'
      + ciEscape(isZh ? '当前没有运行中的容器' : 'No containers running') + '</div></div>';

  return '<div class="ci-group">'
    + ciGroupHead(ciEscape(isZh ? '运行中容器' : 'Running containers')
      + '<span class="ci-group-tag">' + containers.length + '</span>')
    + body + '</div>';
}

// ── 构建任务 ─────────────────────────────────────────────────────

function ciRenderBuildSection() {
  const job = _ciData?.buildJob;
  if (!job) return '';
  const isZh = ciIsZh();
  const elapsed = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000));
  const state = job.running
    ? { ok: true, text: (isZh ? '构建中 · ' : 'Building · ') + elapsed + 's' }
    : job.exitCode === 0
      ? { ok: true, text: isZh ? '构建完成' : 'Build succeeded' }
      : { ok: false, text: (isZh ? '构建失败 · 退出码 ' : 'Build failed · exit ') + job.exitCode };

  return '<div class="ci-group">'
    + ciGroupHead(ciEscape(isZh ? '构建任务' : 'Build job')
      + '<span class="ci-group-tag">' + ciEscape(job.agentId) + '</span>')
    + ciDetailRow(isZh ? '状态' : 'State',
      '<span class="ci-badge ' + (state.ok ? 'ok' : 'bad') + '">' + ciEscape(state.text) + '</span>')
    + ciDetailRow(isZh ? '开始于' : 'Started', ciEscape(ciFormatTime(job.startedAt)))
    + (job.tail ? '<pre class="ci-build-tail">' + ciEscape(job.tail) + '</pre>' : '')
    + '</div>';
}

// ── 页面装配 ─────────────────────────────────────────────────────

function ciRender(container) {
  const isZh = ciIsZh();
  if (!_ciData) {
    container.innerHTML = '<div class="ph-settings-empty">'
      + (isZh ? '正在读取容器镜像信息…' : 'Loading container images…') + '</div>';
    return;
  }
  const data = _ciData;
  const canRefresh = true;
  container.innerHTML = [
    '<div class="settings-section">',
    '<div class="ci-group-head"><div class="ci-group-label">'
      + ciEscape(isZh ? '运行环境' : 'Runtime environment') + '</div>',
    canRefresh
      ? '<button class="settings-icon-btn" type="button" title="' + ciEscape(isZh ? '刷新' : 'Refresh')
        + '" onclick="onCiRefresh()">' + CI_ICON_REFRESH + '</button>'
      : '',
    '</div>',
    ciRenderEnvironmentSection(data),
    '</div>',
    '<div class="settings-section">',
    ciRenderImagesSection(data),
    '</div>',
    '<div class="settings-section">',
    ciRenderContainersSection(data),
    '</div>',
    ciRenderBuildSection(),
    '<div id="ci-status" class="ci-status-line"></div>',
  ].join('');
}

function ciSetStatus(text, isError) {
  const el = document.getElementById('ci-status');
  if (!el) return;
  el.className = 'ci-status-line' + (isError ? ' error' : '');
  el.textContent = text || '';
}

function ciSchedulePoll() {
  ciStopPoll();
  _ciPollTimer = setInterval(async () => {
    if (!ciContainer()) {
      ciStopPoll();
      return;
    }
    await ciFetchOverview(false);
    const running = Boolean(_ciData?.buildJob?.running);
    if (!running) {
      ciStopPoll();
      if (_ciData?.buildJob && ciContainer()) {
        ciSetStatus(ciIsZh() ? '构建已结束' : 'Build finished', _ciData.buildJob.exitCode !== 0);
        ciRender(ciContainer());
      }
    } else {
      ciRender(ciContainer());
    }
  }, CI_POLL_MS);
}

async function ciFetchOverview(render = true) {
  const container = ciContainer();
  if (!container || _ciLoading) return;
  _ciLoading = true;
  try {
    const res = await fetch('/protoclaw/container_images/overview?host=' + encodeURIComponent(_ciHostAgentId));
    if (!res.ok) {
      const isZh = ciIsZh();
      if (res.status === 404) {
        _ciData = null;
        container.innerHTML = '<div class="settings-section"><div class="ph-settings-empty">'
          + (isZh ? '容器镜像接口不可用：Claw 服务需要重启后加载新路由。'
            : 'Container images API unavailable: restart the Claw service to load the new routes.')
          + '</div></div>';
        return;
      }
      throw new Error('HTTP ' + res.status);
    }
    _ciData = await res.json();
    if (render) ciRender(container);
    if (_ciData?.buildJob?.running) ciSchedulePoll();
  } catch (error) {
    const isZh = ciIsZh();
    if (render && container) {
      container.innerHTML = '<div class="settings-section"><div class="ph-settings-empty" style="color:var(--error-color);">'
        + (isZh ? '读取失败：' : 'Load failed: ') + ciEscape(error?.message || error)
        + '</div></div>';
    }
  } finally {
    _ciLoading = false;
  }
}

function ciStopPoll() {
  if (_ciPollTimer) {
    clearInterval(_ciPollTimer);
    _ciPollTimer = null;
  }
}

function ciDisarmDelete() {
  if (_ciDeleteArmed) {
    clearTimeout(_ciDeleteArmed.revertTimer);
    _ciDeleteArmed = null;
  }
}

window.loadContainerImagesPanel = function () {
  ciDisarmDelete();
  void ciFetchOverview(true);
};

window.stopContainerImagesPanel = function () {
  ciStopPoll();
  ciDisarmDelete();
};

window.onCiRefresh = function () {
  void ciFetchOverview(true);
};

window.onCiDeleteClick = async function (imageId, displayRef) {
  const isZh = ciIsZh();
  if (!_ciDeleteArmed || _ciDeleteArmed.imageId !== imageId) {
    ciDisarmDelete();
    _ciDeleteArmed = {
      imageId,
      revertTimer: setTimeout(() => {
        _ciDeleteArmed = null;
        const container = ciContainer();
        if (container) ciRender(container);
      }, CI_DELETE_ARM_MS),
    };
    const container = ciContainer();
    if (container) ciRender(container);
    return;
  }
  ciDisarmDelete();
  ciSetStatus(isZh ? '正在删除…' : 'Deleting…');
  try {
    const res = await fetch('/protoclaw/container_images/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: _ciHostAgentId, imageRef: imageId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data?.error === 'image_in_use') {
        throw new Error((isZh ? '镜像正被容器使用（' : 'Image in use (') + (data.containers || []).join(', ') + ')');
      }
      if (data?.error === 'image_not_in_domain') {
        throw new Error(isZh ? '该镜像不属于当前工作空间的管理范围' : "Image is outside this workspace's management scope");
      }
      throw new Error(data?.error || 'HTTP ' + res.status);
    }
    ciSetStatus((isZh ? '已删除 ' : 'Deleted ') + displayRef);
  } catch (error) {
    ciSetStatus((isZh ? '删除失败：' : 'Delete failed: ') + (error?.message || error), true);
  }
  await ciFetchOverview(true);
};

window.onCiBuildClick = async function (agentId) {
  const isZh = ciIsZh();
  if (!agentId) return;
  ciSetStatus(isZh ? '正在启动构建（' + agentId + '）…' : 'Starting build (' + agentId + ')…');
  try {
    const res = await fetch('/protoclaw/container_images/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host: _ciHostAgentId, agentId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data?.error === 'agent_not_in_domain') {
        throw new Error(isZh ? '该应用不属于当前工作空间的管理范围' : "App is outside this workspace's management scope");
      }
      throw new Error(data?.error || 'HTTP ' + res.status);
    }
    ciSetStatus(isZh ? '构建已启动' : 'Build started');
    ciSchedulePoll();
    await ciFetchOverview(true);
  } catch (error) {
    ciSetStatus((isZh ? '构建启动失败：' : 'Build failed to start: ') + (error?.message || error), true);
  }
};
