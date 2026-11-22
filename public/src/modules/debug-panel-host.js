/**
 * debug-panel-host.js — 面板编排入口（P4 T2 渲染层批次：classic → ESM）
 *
 * 从 debug-panels.js 拆出。必须是 debug 面板族的编排层。包含：
 *   - renderFeaturePanel（经 ClawPanels 注册表调用各面板 render；
 *     mountBody 型容器面板经挂载/卸载通道，不走 innerHTML；
 *     stub 型懒面板显示装载态并触发按需装载，ADR-0044 P3）
 *   - toggleFeaturePanel
 *   - syncRailButtons（rail 按钮注册表派生，ADR-0044 P2b）
 *
 * 依赖形态：
 *   - 已迁 ESM 直接 import：翻译（t）、转义 / 公式增强（markdown-utils）、
 *     DOM 引用（domRefs）、面板宽度（panel-layout-state）、渲染入口状态
 *     （render-entry-state 的 activeFeaturePanel 与其 setter）、语言
 *     （getCurrentLanguage）、Feature 详情弹窗清理（debug-features-hooks 的
 *     renderFeatureDetailOverlay；两模块只互相调用、顶层不求值，属调用期环）。
 *   - 仍 classic 的显式 window 晚绑定（行尾注明定义域）：getFeaturePanelEmptyHtml
 *     （app-core）、_cascadeCentralWidth（app-ui）、chat-viewport 的视口锚点族、
 *     applyRailConfig（rail-customize）。
 *   - 注册表与宿主命名空间：window.ClawPanels（right-panel-registry 转发壳，
 *     唯一注册表）、window.ClawHost（插件宿主）、window.ClawSelect（下拉增强）。
 *
 * 时序审计（R4，首屏链已在模块相由 boot.js 触发）：
 *   - 顶层语句共四处，全部从加载相推迟到模块求值相：
 *     1. featurePanelBody 的 scroll 监听（顶部渐隐遮罩）——只在用户滚动时触发；
 *     2. window.ClawFW.panelBodyContentEl 挂载（面板自刷内容层的宿主 API）；
 *     3. ClawHost.setPanelTeardownHook / onPluginLoadSettled 订阅——插件装载 / 卸载
 *        都发生在 boot 之后，订阅晚于它们不可能的早于模块求值；
 *     4. 兼容桥注册（见文件尾）。
 *     四处均无 classic 相触达点：首屏渲染（applyLanguage → renderCurrentMainView
 *     → syncRailButtons）本身就在模块相、且晚于本模块求值（boot.js 是最后一个
 *     module 标签）。
 */
import { t } from '../i18n.js';
import { escapeHtml, enhanceMathInElement } from './markdown-utils.js';
import { domRefs } from './p2-bootstrap-dom.js';
import { getFeaturePanelWidth } from './panel-layout-state.js';
import { activeFeaturePanel, setActiveFeaturePanel } from './render-entry-state.js';
import { getCurrentLanguage } from './i18n-environment-state.js';
import { renderFeatureDetailOverlay } from './debug-features-hooks.js';

const { featurePanel, featurePanelTitle, featurePanelBody } = domRefs;

// ═══════════════════════════════════════════════════════════════
// 面板入口
// ═══════════════════════════════════════════════════════════════

let featurePanelRenderVersion = 0;

// 顶部渐隐遮罩：面板 body 向上滚动（上方有滚走的内容）时显示，与底部
// scrollable 渐隐对称。程序设置 scrollTop 同样触发 scroll 事件，class 自动同步。
featurePanelBody.addEventListener('scroll', () => {
  featurePanel.classList.toggle('scrolled', featurePanelBody.scrollTop > 4);
}, { passive: true });

// 面板内容签名缓存：panelId → 上次提交的 HTML。
// 轮询携带相同数据时跳过 innerHTML 替换，保住滚动位置、details 展开、
// ClawSelect 增强层与输入焦点（防打断的关键）。
const _panelBodyHtmlCache = new Map();

// ═══════════════════════════════════════════════════════════════
// 内容层契约：容器（.feature-panel-body）是无留白的通用滚动壳，
// 字符串面板默认包一层 .feature-panel-content（24px / 窄屏 16px 留白），
// 与容器瘦身前的视觉等价。全幅面板（threads / git 这类自带边距设计的）
// 在元数据上声明 fullBleed:true 豁免；容器型面板（mountBody）天然全幅，
// 不经 innerHTML 路径。面板侧自刷内容时应写入内容层而不是 body 本身
// （宿主提供 panelBodyContentEl() 定位）。
// ═══════════════════════════════════════════════════════════════

function wrapPanelContent(html) {
  return '<div class="feature-panel-content">' + html + '</div>';
}

/** 定位当前面板应写入的内容层（字符串面板在位时为 .feature-panel-content）。 */
function panelBodyContentEl() {
  return featurePanelBody.querySelector('.feature-panel-content') || featurePanelBody;
}

// 面板自刷后重算签名缓存用（内容层形态对调用方透明）。
window.ClawFW = window.ClawFW || {};
window.ClawFW.panelBodyContentEl = panelBodyContentEl;

/**
 * 面板自行原地更新了 body 内的部分内容（不经 renderFeaturePanel 全量替换）
 * 之后调用：重新求值当前面板的 render() 并记入签名缓存，使下一次
 * renderFeaturePanel 的内容签名对比视为"未变"而跳过 innerHTML 替换——
 * 否则滞后一拍的签名会让轮询 repaint 把面板整体重建（打断滚动/焦点）。
 * 面板未打开或 body 已归属其他面板时不做任何事。
 */
function syncPanelBodyHtmlCache() {
  const panelId = activeFeaturePanel;
  const panel = panelId && window.ClawPanels.get(panelId);
  if (!panel || featurePanelBody.dataset.panel !== panelId) return;
  if (panel.stub) return; // 懒面板无 render 可求值，签名缓存不适用
  if (typeof panel.mountBody === 'function') return; // 容器型面板不参与签名缓存
  try {
    _panelBodyHtmlCache.set(panelId, panel.render());
  } catch (_) { /* 求值失败保留旧签名，下一次 repaint 全量替换自愈 */ }
}

function runAfterPanelOpenFrame(callback) {
  const raf = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (fn) => setTimeout(fn, 0);
  raf(() => raf(callback));
}

// ═══════════════════════════════════════════════════════════════
// 容器型面板（ADR-0044 P2c）+ 现场实例（scene）通用机制
// ═══════════════════════════════════════════════════════════════
//
// 面板元数据声明 mountBody(bodyEl, ctx) 时，body 的渲染权移交面板：
// 打开时宿主给出容器（featurePanelBody）调 mountBody，轮询重渲染对它
// 是 no-op，关闭/切换时调 unmountBody 后宿主收回容器。innerHTML 路径
// 永远不触碰它的 DOM——这是 React 等自管渲染库挂进右栏的通道。
// 与字符串型面板的关键区别：不参与内容签名去重/preserveOnReRender
//（天然保留），刷新节奏由面板自管（onOpen 里启动，unmountBody 里清理）。
//
// ── 现场实例（scenes 能力，面板可选声明）─────────────────────────
//
// 面板在注册元数据上声明 `scenes: { overlayContext, renderStrip,
// activateDefault }` 即可拥有多现场形态：同一面板按 context.instanceKey
// 同时存在多份实例，keepAlive 实例在切换/收起时被暂存保活而不是卸载，
// 重新选中时原 DOM 原样接回（React 状态不丢）。宿主只认 instanceKey /
// keepAlive 这两个通用字段，不感知任何具体面板的现场语义：
//   - overlayContext(base) → 覆盖字段（identity / instanceKey / keepAlive /
//     panelTitle 等 + 面板域自有字段），null/缺席 = 无现场形态（默认）
//   - renderStrip(stripEl) → 自绘头部现场页签条（宿主只提供槽位）
//   - activateDefault() → rail 图标点击时的「回默认现场」接管，返回
//     false = 走常规开关
// 面板实例协议补充：onContextUpdate(node, context) 在实例被重新选中或
// 上下文变化（如接续换代）时回调，面板自行 diff。首个接入：文件面板的
// 固定文件现场（modules/files-scenes.js）。

let mountedContainer = null; // { id, instanceKey?, keepAlive?, node?, settingsKey?, unmount }
const stashedInstances = new Map(); // `${panelId}::${instanceKey}` → 同构记录（保活暂存）

/** 现场实例的隐藏暂存区（挂在 body 下的常驻容器，节点移动而非重建）。 */
function sceneStashRoot() {
  let root = document.getElementById('feature-panel-scene-stash');
  if (!root) {
    root = document.createElement('div');
    root.id = 'feature-panel-scene-stash';
    root.hidden = true;
    document.body.appendChild(root);
  }
  return root;
}

function stashInstance(mounted) {
  mounted.node.hidden = true;
  mounted.node.classList.add('feature-panel-instance-stashed');
  sceneStashRoot().appendChild(mounted.node);
  stashedInstances.set(`${mounted.id}::${mounted.instanceKey}`, mounted);
}

/**
 * 收回当前挂载的容器：keepAlive 的现场实例暂存保活（切换面板、收起右栏
 * 都不销毁），其余正常卸载。「显式关闭现场」不走这里——那是
 * releaseSceneInstance 的职责。
 */
function unmountContainerPanel(reason) {
  if (!mountedContainer) return;
  const mounted = mountedContainer;
  mountedContainer = null;
  if (mounted.keepAlive && mounted.instanceKey) {
    stashInstance(mounted);
  } else {
    if (typeof mounted.unmount === 'function') {
      try {
        mounted.unmount();
      } catch (err) {
        console.error(`[panel:${mounted.id}] unmountBody failed (${reason})`, err);
      }
    }
    mounted.node?.remove();
  }
  featurePanelBody.innerHTML = '';
  delete featurePanelBody.dataset.panel;
}

/**
 * 显式释放一个现场实例（面板域关闭现场时调用）：暂存中或在位挂载都精确
 * 卸载一次，不影响其他实例。返回是否找到了该实例。
 */
export function releaseSceneInstance(panelId, instanceKey) {
  if (!panelId || !instanceKey) return false;
  const stashKey = `${panelId}::${instanceKey}`;
  const stashed = stashedInstances.get(stashKey);
  if (stashed) {
    stashedInstances.delete(stashKey);
    stashed.node.remove();
    try { stashed.unmount?.(); } catch (err) {
      console.error(`[panel:${panelId}] unmountBody failed (release-scene)`, err);
    }
    return true;
  }
  if (mountedContainer?.id === panelId && mountedContainer.instanceKey === instanceKey) {
    const mounted = mountedContainer;
    mountedContainer = null;
    try { mounted.unmount?.(); } catch (err) {
      console.error(`[panel:${panelId}] unmountBody failed (release-scene)`, err);
    }
    mounted.node.remove();
    featurePanelBody.innerHTML = '';
    delete featurePanelBody.dataset.panel;
    return true;
  }
  return false;
}

/**
 * 把当前在位的实例原地升级为持久现场（用户点「固定」时面板域调用）：
 * instanceKey 原地改写、容器节点不重建，React DOM 与内部状态原样保留。
 * 守卫是「在位实例尚未 keepAlive」：live 默认现场（带 live instanceKey）与
 * 无现场形态的容器都可转正；已 keepAlive 的固定现场拒绝——它的 DOM 归属
 * 已按旧 key 记入暂存索引，改写会让索引与事实失配。
 */
export function adoptSceneInstance(panelId, instanceKey) {
  if (!panelId || !instanceKey) return false;
  if (!mountedContainer || mountedContainer.id !== panelId || mountedContainer.keepAlive) return false;
  mountedContainer.instanceKey = instanceKey;
  mountedContainer.keepAlive = true;
  mountedContainer.node.dataset.panelInstance = instanceKey;
  return true;
}

function pluginPanelContext(panelId) {
  const spec = window.ClawHost?.panels.getSettingsBinding?.(panelId);
  if (!spec) {
    const minimal = { panelId };
    const overlay = window.ClawPanels.get(panelId)?.scenes?.overlayContext?.(minimal);
    return overlay ? { ...minimal, ...overlay } : minimal;
  }
  const agentId = window.getCurrentHostAgentRecord?.()?.id || window.focusedAgentId;
  const view = window.getCurrentSessionViewIdentity?.();
  const runtimeId = window.currentRuntimeAgentId;
  const sessionId = runtimeId && view?.agentId === agentId ? view.sessionId : '';
  const query = new URLSearchParams({ agentId: agentId || '', digest: spec.digest });
  if (sessionId) query.set('sessionId', sessionId);
  const ready = !!agentId && (!runtimeId || !!sessionId) && !window.RemoteConnections?.getEntryHostAgentId?.(runtimeId);
  const bind = (url) => {
    if (!ready) throw new Error('Plugin settings require a resolved local view');
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin) throw new Error('Plugin requests must use the local origin');
    target.searchParams.delete('sessionId');
    for (const [key, value] of query) target.searchParams.set(key, value);
    return target.pathname + target.search;
  };
  const context = {
    panelId,
    settingsKey: JSON.stringify([spec.packageName, runtimeId, query.toString(), ready]),
    async getPluginSettings() {
      const url = `/protoclaw/plugin_settings?packageName=${encodeURIComponent(spec.packageName)}`;
      const response = await window.fetch(bind(url));
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Plugin settings: ${response.status}`);
      return body.settings;
    },
    pluginRequestUrl: bind,
  };
  const overlay = window.ClawPanels.get(panelId)?.scenes?.overlayContext?.(context);
  return overlay ? { ...context, ...overlay } : context;
}

function mountContainerPanel(panel, panelId, context) {
  if (!context.instanceKey) {
    mountedContainer = { id: panelId, settingsKey: context.settingsKey, unmount: panel.unmountBody || null };
    try {
      panel.mountBody(featurePanelBody, context);
    } catch (err) {
      console.error(`[panel:${panelId}] mountBody failed`, err);
      mountedContainer = null; // 挂载失败视作未挂载，防幽灵 unmount
    }
    featurePanel.classList.add('body-ready');
    return;
  }
  // 现场实例：独立容器节点按 instanceKey 挂载；曾暂存的实例原样接回
  const stashKey = `${panelId}::${context.instanceKey}`;
  const stashed = stashedInstances.get(stashKey);
  if (stashed) {
    stashedInstances.delete(stashKey);
    stashed.node.hidden = false;
    stashed.node.classList.remove('feature-panel-instance-stashed');
    featurePanelBody.innerHTML = '';
    featurePanelBody.appendChild(stashed.node);
    mountedContainer = stashed;
    panel.onContextUpdate?.(stashed.node, context);
  } else {
    const node = document.createElement('div');
    node.className = 'feature-panel-instance';
    node.dataset.panelInstance = context.instanceKey;
    featurePanelBody.innerHTML = '';
    featurePanelBody.appendChild(node);
    mountedContainer = {
      id: panelId,
      instanceKey: context.instanceKey,
      keepAlive: !!context.keepAlive,
      node,
      settingsKey: context.settingsKey,
      unmount: () => panel.unmountBody?.(node),
    };
    try {
      panel.mountBody(node, context);
    } catch (err) {
      console.error(`[panel:${panelId}] mountBody failed`, err);
      mountedContainer = null; // 挂载失败视作未挂载，防幽灵 unmount
    }
  }
  featurePanel.classList.add('body-ready');
  // 底部渐变与字符串面板同口径（内层滚动容器同样检查）
  const innerScroll = featurePanelBody.querySelector('.logf-list');
  featurePanel.classList.toggle('scrollable',
    featurePanelBody.scrollHeight > featurePanelBody.clientHeight + 4
    || (innerScroll && innerScroll.scrollHeight > innerScroll.clientHeight + 4));
}

export function renderFeaturePanel(options = {}) {
  // ── 泛化焦点保持：任何 featurePanelBody 内的 input/textarea 都保护 ──
  const activeElement = document.activeElement;
  let focusRestore = null;
  if (activeElement && featurePanelBody.contains(activeElement)) {
    const tag = activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // 构建 CSS 选择器，在 innerHTML 替换后重新定位元素
      let selector = tag.toLowerCase();
      const role = activeElement.getAttribute('data-files-role');
      const id = activeElement.id;
      const cls = typeof activeElement.className === 'string' ? activeElement.className.trim() : '';
      if (role) {
        selector += `[data-files-role="${role}"]`;
      } else if (id) {
        selector += `#${id}`;
      } else if (cls) {
        selector += '.' + cls.split(/\s+/).join('.');
      }
      focusRestore = {
        selector,
        value: activeElement.value,
        selectionStart: typeof activeElement.selectionStart === 'number' ? activeElement.selectionStart : null,
        selectionEnd: typeof activeElement.selectionEnd === 'number' ? activeElement.selectionEnd : null,
      };
    }
  }

  if (!activeFeaturePanel || !window.ClawPanels.get(activeFeaturePanel)) {
    featurePanelRenderVersion += 1;
    _panelBodyHtmlCache.clear();
    unmountContainerPanel('close'); // keepAlive 现场实例暂存保活，其余卸载
    featurePanel.classList.remove('open');
    featurePanel.classList.remove('body-ready');
    document.querySelector('.main-content')?.classList.remove('panel-open');
    featurePanelTitle.textContent = t('panel_structure');
    const closedStrip = document.getElementById('feature-panel-scenes');
    if (closedStrip) closedStrip.innerHTML = '';
    featurePanelBody.innerHTML = wrapPanelContent(window.getFeaturePanelEmptyHtml()); // 桥接期：定义于 app-core
    document.querySelectorAll('.rail-button[data-panel]').forEach(button => button.classList.remove('active'));
    // 清理可能残留的 Feature 详情弹窗 portal
    renderFeatureDetailOverlay(null);
    return;
  }

  const panel = window.ClawPanels.get(activeFeaturePanel);
  const panelId = activeFeaturePanel;
  // 切换到非 hooks 面板时，清理 Feature 详情弹窗
  if (panelId !== 'hooks') {
    renderFeatureDetailOverlay(null);
  }
  const prevPanelId = featurePanelBody.dataset.panel;
  featurePanelBody.dataset.panel = panelId;
  const renderVersion = featurePanelRenderVersion + 1;
  featurePanelRenderVersion = renderVersion;
  // 仅在面板打开转换时同步宽度变量：打开状态下的重渲染（如 poll 数据更新）
  // 不得覆写宽度，否则拖动调整中会被闪回全局 featurePanelWidth（尤其收回区拖动）。
  const wasOpen = featurePanel.classList.contains('open');
  featurePanel.classList.add('open');
  document.querySelector('.main-content')?.classList.add('panel-open');
  if (!wasOpen) {
    featurePanel.style.setProperty('--feature-panel-width', getFeaturePanelWidth() + 'px');
  }
  const isContainerPanel = typeof panel.mountBody === 'function';
  const panelContext = isContainerPanel ? pluginPanelContext(panelId) : null;
  featurePanelTitle.textContent = panelContext?.panelTitle
    ?? (typeof panel.title === 'function' ? panel.title() : panel.title);
  // 现场页签槽位：声明 scenes.renderStrip 的面板自绘内容，其余面板清空
  const scenesStrip = document.getElementById('feature-panel-scenes');
  if (scenesStrip) {
    if (isContainerPanel && panel.scenes?.renderStrip) panel.scenes.renderStrip(scenesStrip);
    else scenesStrip.innerHTML = '';
  }
  document.querySelectorAll('.rail-button[data-panel]').forEach(button => {
    button.classList.toggle('active', button.dataset.panel === activeFeaturePanel);
  });

  const commitPanelBody = () => {
    if (renderVersion !== featurePanelRenderVersion || activeFeaturePanel !== panelId) {
      return;
    }

    // ── 懒面板（ADR-0044 P3）：stub 占位，真实现随插件按需装载 ──
    // 加载中显示占位并发起 ensurePlugin；失败显式错误态（不自动重试，
    // 恢复靠刷新页面——与 APP 插件装载失败同口径）。装载落定后
    // onPluginLoadSettled 订阅触发重渲染，real 已替换 stub，走正常路径。
    if (panel.stub) {
      unmountContainerPanel('stub'); // 防御：stub 面板不应有挂载中的容器
      const loadState = window.ClawHost && window.ClawHost.getPluginLoadState(panel.stub.pluginId);
      if (loadState === 'failed') {
        featurePanelBody.innerHTML = wrapPanelContent(
          '<div class="feature-panel-empty"><div>' + escapeHtml(t('panel_lazy_failed')) + '</div></div>');
        featurePanel.classList.add('body-ready');
        return;
      }
      featurePanelBody.innerHTML = wrapPanelContent(
        '<div class="feature-panel-empty"><div>' + escapeHtml(t('panel_lazy_loading')) + '</div></div>');
      featurePanel.classList.add('body-ready');
      if (window.ClawHost) window.ClawHost.ensurePlugin(panel.stub.pluginId, panel.stub.url);
      return;
    }

    // ── 容器型面板（ADR-0044 P2c）──
    // 挂载中的容器面板与当前面板/现场不一致时先收回：keepAlive 现场实例
    // 暂存保活，其余卸载。覆盖「容器→容器」切换（含同面板换现场），也覆盖
    // 「容器→字符串」切换（innerHTML 路径会销毁其 DOM，必须先给 unmountBody
    // 清理定时器/订阅的机会）。「字符串→容器」无挂载，直挂。
    const context = panelContext;
    if (mountedContainer && (
      mountedContainer.id !== panelId
      || (context.instanceKey
        ? mountedContainer.instanceKey !== context.instanceKey
        : mountedContainer.settingsKey !== context.settingsKey)
    )) {
      unmountContainerPanel('switch');
    }
    if (typeof panel.mountBody === 'function') {
      if (!mountedContainer) {
        mountContainerPanel(panel, panelId, context);
      } else {
        // 已挂载的重渲染（轮询/接续触发）：上下文交给面板自行 diff
        panel.onContextUpdate?.(mountedContainer.node, context);
        featurePanel.classList.add('body-ready');
      }
      return;
    }

    // 面板声明 preserveOnReRender 时，如果当前 body 已经属于该面板且有内容，
    // 跳过 innerHTML 替换以保留交互状态（事件监听器、输入焦点等）。
    // 注意：必须用 prevPanelId 判断，因为 dataset.panel 已经被设为新值。
    // 切换面板时 prevPanelId !== panelId，不会跳过首次渲染。
    if (panel.preserveOnReRender && prevPanelId === panelId && featurePanelBody.children.length > 0) {
      featurePanel.classList.add('body-ready');
      return;
    }

    // ── 滚动位置保持：innerHTML 替换会重置所有 scrollTop ──
    // 日志面板等使用内部滚动容器（.logf-list）的面板，body 本身不滚，
    // 必须一并保存/恢复内层滚动位置，否则全量重建后视图跳回顶部。
    const _savedBodyScrollTop = featurePanelBody.scrollTop;
    const _prevInnerScroll = featurePanelBody.querySelector('.logf-list');
    const _savedInnerScrollTop = _prevInnerScroll ? _prevInnerScroll.scrollTop : null;

    const nextHtml = panel.render();

    // 内容签名去重：同面板、HTML 未变且 body 非空时跳过 DOM 替换。
    // 面板切换（prevPanelId !== panelId）与 deferBody 清空（children 为 0）不适用。
    if (prevPanelId === panelId && featurePanelBody.children.length > 0 && _panelBodyHtmlCache.get(panelId) === nextHtml) {
      featurePanel.classList.add('body-ready');
      return;
    }
    _panelBodyHtmlCache.set(panelId, nextHtml);

    featurePanelBody.innerHTML = panel.fullBleed ? nextHtml : wrapPanelContent(nextHtml);
    if (featurePanelBody.querySelector('.markdown-body')) {
      enhanceMathInElement(featurePanelBody);
    }

    // ClawSelect 增强：渲染后接管 data-claw-select 下拉
    if (window.ClawSelect && featurePanelBody.querySelector('select[data-claw-select]')) {
      window.ClawSelect.enhanceAll(featurePanelBody);
    }

    // 恢复滚动位置
    featurePanelBody.scrollTop = _savedBodyScrollTop;
    if (_savedInnerScrollTop != null) {
      const innerScroll = featurePanelBody.querySelector('.logf-list');
      if (innerScroll) innerScroll.scrollTop = _savedInnerScrollTop;
    }

    if (focusRestore) {
      const el = featurePanelBody.querySelector(focusRestore.selector);
      if (el) {
        // 恢复用户正在输入的值（重新渲染的 HTML 可能带有过期值）
        if (focusRestore.value != null && el.value !== focusRestore.value) {
          el.value = focusRestore.value;
        }
        el.focus();
        if (focusRestore.selectionStart != null && focusRestore.selectionEnd != null && typeof el.setSelectionRange === 'function') {
          el.setSelectionRange(focusRestore.selectionStart, focusRestore.selectionEnd);
        }
      }
    }

    featurePanel.classList.add('body-ready');

    // 底部渐变：内容溢出时显示渐隐遮罩。
    // 日志面板使用内部滚动容器（.logf-list），body 本身不再溢出，需一并检查内层。
    const innerScroll = featurePanelBody.querySelector('.logf-list');
    featurePanel.classList.toggle('scrollable',
      featurePanelBody.scrollHeight > featurePanelBody.clientHeight + 4
      || (innerScroll && innerScroll.scrollHeight > innerScroll.clientHeight + 4));
  };

  if (options.deferBody === true) {
    featurePanel.classList.remove('body-ready');
    unmountContainerPanel('defer'); // 幂等：defer 打开时无挂载，防御 defer 语义将来扩展
    featurePanelBody.innerHTML = '';
    runAfterPanelOpenFrame(commitPanelBody);
    return;
  }

  commitPanelBody();
}

/**
 * 面板生命周期统一经注册表元数据分发（ADR-0044 P2）：onOpen / onClose
 * 声明在 panels.register 的元数据上，编排层按事件名取钩子调用。
 * 钩子抛错只记录不中断——面板生命周期的失败不应拖垮开关面板本身。
 */
function notifyPanelLifecycle(panelId, hookName) {
  if (!panelId) return;
  const meta = window.ClawPanels.get(panelId);
  const hook = meta && typeof meta[hookName] === 'function' ? meta[hookName] : null;
  if (!hook) return;
  try {
    hook();
  } catch (err) {
    console.error(`[panel:${panelId}] ${hookName} failed`, err);
  }
}

export function toggleFeaturePanel(panelId) {
  // 捕获滚动锚点：panel 开/关是一次重大宽度突变，需要在布局应用后
  // 恢复阅读位置（跟随模式锁底 / 非跟随锚定到正在读的行）。
  const _anchor = (typeof window.captureChatViewportAnchor === 'function') // 桥接期：定义于 chat-viewport
    ? window.captureChatViewportAnchor() : null;
  let _suppressApplied = false;
  if (_anchor && typeof window.suppressChatViewportObservers === 'function') {
    window.suppressChatViewportObservers(500);
    _suppressApplied = true;
  }

  const wasOpen = activeFeaturePanel === panelId;
  const shouldDeferBody = !activeFeaturePanel && !wasOpen;
  const previousPanel = activeFeaturePanel;

  // Lifecycle: 切换面板时关闭前一个面板
  if (previousPanel && previousPanel !== panelId) {
    notifyPanelLifecycle(previousPanel, 'onClose');
  }

  setActiveFeaturePanel(wasOpen ? null : panelId);
  renderFeaturePanel({ deferBody: shouldDeferBody });

  // 面板打开使中央区低于阈值时做级联适配（收左栏 → 缩右栏）。
  // 纯动作：复用 toggle 开头捕获的 _anchor，在下方 rAF 中一并恢复滚动。
  if (typeof window._cascadeCentralWidth === 'function') { // 桥接期：定义于 app-ui
    window._cascadeCentralWidth();
  }

  // Lifecycle: 打开新面板 / 关闭当前面板
  if (!wasOpen) {
    notifyPanelLifecycle(panelId, 'onOpen');
  } else {
    notifyPanelLifecycle(panelId, 'onClose');
  }

  // 面板 class 已切换（宽度变化写入样式），下一帧布局应用新宽度后恢复滚动位置。
  if (_anchor && typeof window.applyChatViewportAnchor === 'function') {
    requestAnimationFrame(() => {
      window.applyChatViewportAnchor(_anchor);
      if (_suppressApplied && typeof window.resumeChatViewportObservers === 'function') {
        window.resumeChatViewportObservers();
      }
      if (_anchor.mode === 'follow' && typeof window.scheduleFollowLatestSettlePass === 'function') {
        window.scheduleFollowLatestSettlePass();
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// rail 按钮注册表派生（ADR-0044 P2b）
// ═══════════════════════════════════════════════════════════════
//
// 右栏按钮不再手写于 index.html：注册元数据带 icon 的面板在此生成按钮。
// id 约定 rail-<panelId>、徽标 rail-<panelId>-badge（todo-plan / bg-panel /
// generative-ui-panel 经 getElementById 引用，不可破坏）。order 字段标记
// 可自定义面板（进自定义弹窗、可拖拽排序），无 order 的面板按钮生成但由
// rail-customize 强制隐藏（行为等价此前的 CUSTOMIZABLE_PANEL_ORDER 屏蔽）。

function railButtonTitle(panel) {
  const lang = getCurrentLanguage() === 'en' ? 'en' : 'zh';
  const meta = panel.label;
  if (meta && typeof meta === 'object') return meta[lang] || meta.en || panel.id;
  return typeof panel.title === 'function' ? panel.title() : panel.title;
}

function createRailButton(panel) {
  const btn = document.createElement('button');
  btn.className = 'rail-button';
  btn.id = 'rail-' + panel.id;
  btn.type = 'button';
  btn.title = railButtonTitle(panel);
  btn.dataset.panel = panel.id;
  btn.innerHTML = panel.icon + (panel.badge
    ? '<span class="rail-badge" id="rail-' + panel.id + '-badge"></span>'
    : '');
  btn.addEventListener('click', () => {
    // scenes 面板可接管图标点击（如「回到默认现场」）；返回 false 走常规开关
    if (panel.scenes?.activateDefault?.()) return;
    toggleFeaturePanel(panel.id);
  });
  return btn;
}

/**
 * 按注册表同步 rail 按钮（幂等，轻量，可高频调用）：
 *   - 注册面板带 icon 且按钮缺席 → 生成并按序插入（customizable 的 order
 *     在前，其余按注册序垫底，统一插到 rail-spacer 之前）
 *   - 按钮指向的面板已不在注册表（或不再有 icon）→ 移除按钮
 * 面板可用性（when 过滤）不在此处管——renderCurrentMainView 对按钮
 * display 的控制照旧。语言切换后 title 重算经再次调用本函数完成。
 */
export function syncRailButtons() {
  const rail = document.getElementById('right-rail');
  if (!rail) return;
  const panels = window.ClawPanels.getAll().filter((p) => p.icon);
  const panelById = new Map(panels.map((p) => [p.id, p]));

  let domChanged = false;

  // 孤儿按钮清理：面板被摘除（如插件卸载）时按钮随之消失
  rail.querySelectorAll('.rail-button[data-panel]').forEach((btn) => {
    const meta = panelById.get(btn.dataset.panel);
    if (!meta || btn.id !== 'rail-' + meta.id) {
      btn.remove();
      domChanged = true;
    }
  });

  const anchor = rail.querySelector('.rail-spacer');
  const insertAt = (el) => rail.insertBefore(el, anchor || null);

  // 生成顺序先按插件默认 order；applyRailConfig 随后依据工作空间服务端配置重放用户排序。
  const ordered = [...panels].sort((a, b) =>
    (a.order ?? Infinity) - (b.order ?? Infinity) || 0);
  for (const panel of ordered) {
    let btn = document.getElementById('rail-' + panel.id);
    if (!btn || !rail.contains(btn)) {
      btn = createRailButton(panel);
      insertAt(btn);
      domChanged = true;
      continue;
    }
    // 已存在的按钮刷新 title（语言切换）
    btn.title = railButtonTitle(panel);
  }

  // 按钮集合变化后重放 rail-customize 配置：用户的自定义排序与可见性
  // （localStorage）只作用于 DOM 里的按钮，而 rail-customize 的初始化
  // 早于首次按钮生成，新生成的按钮不经 applyConfig 处理——否则会出现
  // 「用户隐藏的面板重新显示」与「自定义面板按钮滞留 rail 顶部」两类
  // 回归（applyConfig 同时负责 custBtn 在面板区末尾的归位）。
  if (domChanged && typeof window.applyRailConfig === 'function') { // 桥接期：定义于 rail-customize
    window.applyRailConfig();
  }
}

// ═══════════════════════════════════════════════════════════════
// 面板摘除联动（ADR-0044 效果归属）
// ═══════════════════════════════════════════════════════════════

// 面板从注册表被摘除（如所属插件卸载）时，若它正打开，走空面板渲染把
// body 清空、open class 撤下、按钮 active 态复位。注册表不知道打开状态，
// 这层清理只能由编排层完成，经 setPanelTeardownHook 注入给 claw-host。
if (window.ClawHost && typeof window.ClawHost.setPanelTeardownHook === 'function') {
  window.ClawHost.setPanelTeardownHook((panelId) => {
    if (activeFeaturePanel !== panelId) return;
    setActiveFeaturePanel(null);
    renderFeaturePanel();
  });
}

// 懒面板装载落定联动（ADR-0044 P3）：打开中的面板若由刚落定的插件提供，
// 重渲染一次——成功落定时 stub 已被 real 替换（real.owner === pluginId），
// 切真面板内容；失败落定时 stub 仍在（stub.pluginId === pluginId），进错误态。
// 其他插件的装载落定与当前面板无关，不触发。
if (window.ClawHost && typeof window.ClawHost.onPluginLoadSettled === 'function') {
  window.ClawHost.onPluginLoadSettled((pluginId) => {
    if (!activeFeaturePanel) return;
    const panel = window.ClawPanels.get(activeFeaturePanel);
    if (!panel) return;
    if ((panel.stub && panel.stub.pluginId === pluginId) || panel.owner === pluginId) {
      // stub→real 落定：打开时的 onOpen 落在 stub 元数据上（无钩子，no-op），
      // 真实现就位后补发一次——auto-refresh 等随打开启动的资源由此启动
      // （行为等价迁移的关键一环；失败落定 panel 仍是 stub，不补发）
      if (panel.owner === pluginId) {
        notifyPanelLifecycle(activeFeaturePanel, 'onOpen');
      }
      renderFeaturePanel();
    }
  });
}

// ── 兼容桥（仍有 classic / 未迁移消费方的入口）────────────────────────
// renderFeaturePanel ← app-ui.js（面板入口闭包与 renderCurrentMainView 链）、
//   i18n-environment-state（ESM，applyLanguage 的 window 调用）、todo-plan /
//   debug-preflight（ESM，按 window 取）、悬置域（resources-viewer / wg-*）。
// toggleFeaturePanel ← wg-popover（悬置域）。
// syncRailButtons ← app-ui.js、i18n-environment-state、feature-ui-registry。
// syncPanelBodyHtmlCache ← panel-plugins/git.js（面板自刷后重算签名缓存）。
// 注册相位：模块顶层（deferred ESM 相）。上述消费点全部在函数体内、且都在
// boot 之后；首屏渲染的 syncRailButtons 调用发生在 boot（晚于本模块求值），
// classic 相（加载期顶层）对本域零读写。
// 注销条件：app-ui / rail-customize / 悬置域迁移后改 import；
// i18n-environment-state / todo-plan / debug-preflight / git 面板的窗口取用改 import。
const bridged = { renderFeaturePanel, toggleFeaturePanel, syncRailButtons, syncPanelBodyHtmlCache };
window.KernelState.defineKey('debug-panel-host', 'renderFeaturePanel', renderFeaturePanel);
window.KernelState.defineKey('debug-panel-host', 'toggleFeaturePanel', toggleFeaturePanel);
window.KernelState.defineKey('debug-panel-host', 'syncRailButtons', syncRailButtons);
window.KernelState.defineKey('debug-panel-host', 'syncPanelBodyHtmlCache', syncPanelBodyHtmlCache);
window.KernelState.claim('debug-panel-host', {
  get: (key) => bridged[key],
  set: (key, value) => { bridged[key] = value; },
});
