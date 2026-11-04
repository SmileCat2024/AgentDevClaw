/**
 * claw-host.js — 前端宿主 API（插件化底座）
 *
 * 分层心智：系统提供基础组件，APP 在这之上完全自定义。
 *   - 基础组件（primitive）：宿主启动即注册，全生命周期可用，插件不可覆盖。
 *   - APP 组件（plugin）：插件在自己的装载时机注册，随卸载移除。
 * 两者寿命不同，注册表分开存，卸载只清 plugin 层。
 *
 * 三个命名空间：
 *   blocks   block 渲染器（type → renderer），替代 renderWorkspaceBlock 的 if 链
 *   panels   右栏面板（收编 right-panel-registry，注册行为不变）
 *   slots    底部槽位挂载（app-chat-input 模式泛化，按签名比对避免重建 DOM）
 *
 * 装载与卸载见 loadPlugin / unloadPlugin：插件模块约定导出
 *   { id, blocks?: {type: renderer}, mount?(host), unmount?() }
 * 模块装载后由宿主调用 mount(host)，卸载前调用 unmount() 再摘除其注册项。
 */
(function () {
  'use strict';

  const VERSION = '1.0';

  // ── blocks ────────────────────────────────────────────────────────
  const primitives = new Map(); // type -> renderer（宿主，不可覆盖）
  const pluginBlocks = new Map(); // type -> { renderer, owner }
  const refreshers = new Map(); // type -> refresh fn（插件声明，随卸载移除）

  function registerPrimitive(type, renderer) {
    const key = String(type || '').trim();
    if (!key) throw new TypeError('block type is required');
    if (typeof renderer !== 'function') throw new TypeError(`block "${key}" needs a render function`);
    if (pluginBlocks.has(key)) {
      throw new Error(`block "${key}" 已被插件注册，宿主组件不得沿用同名 type`);
    }
    primitives.set(key, renderer);
    return renderer;
  }

  function registerBlock(type, renderer, owner) {
    const key = String(type || '').trim();
    if (!key) throw new TypeError('block type is required');
    if (typeof renderer !== 'function') throw new TypeError(`block "${key}" needs a render function`);
    if (primitives.has(key)) {
      throw new Error(`block "${key}" 是宿主基础组件，插件不得覆盖`);
    }
    if (pluginBlocks.has(key)) {
      throw new Error(`block "${key}" 已被插件 "${pluginBlocks.get(key).owner}" 注册`);
    }
    pluginBlocks.set(key, { renderer, owner: owner || null });
    return renderer;
  }

  function renderBlock(agent, block) {
    const type = String(block?.type || '');
    const entry = primitives.get(type) || pluginBlocks.get(type)?.renderer;
    if (!entry) {
      // 显式失败态而非静默空串：装载失败与「该 APP 没内容」必须可区分。
      // 该 APP 的插件仍在装载中时显示占位，避免把正常装载期间报成错误；
      // 是否「装载中」由本模块持有的状态判定，不依赖宿主注入。
      const pluginId = ownerOfAgent?.(agent);
      if (pluginId && loadState.get(pluginId) === 'loading') {
        return '<div class="workspace-block-loading">加载中…</div>';
      }
      console.error('[claw-host] 未注册的 block type：', type);
      return '<div class="workspace-block-error">未知区块类型：' + type.replace(/[<>&]/g, '') + '</div>';
    }
    return entry(agent, block) || '';
  }

  function unregisterBlocksOf(owner) {
    let removed = 0;
    for (const [type, entry] of pluginBlocks) {
      if (entry.owner === owner) {
        pluginBlocks.delete(type);
        refreshers.delete(type);
        removed += 1;
      }
    }
    return removed;
  }

  function registerRefresher(type, fn, owner) {
    const key = String(type || '').trim();
    if (!key) throw new TypeError('block type is required');
    if (typeof fn !== 'function') throw new TypeError(`refresher for "${key}" must be a function`);
    if (refreshers.has(key)) throw new Error(`refresher for "${key}" is already registered`);
    refreshers.set(key, { fn, owner: owner || null });
    return fn;
  }

  function refresh(type) {
    const entry = refreshers.get(String(type || ''));
    if (!entry) return false;
    entry.fn();
    return true;
  }

  /** 插件声明的事件处理器批量注册到分发器（ClawFW.actions），带 owner 以便卸载摘除。 */
  function registerActions(actions, owner) {
    const dispatcher = window.ClawFW?.actions;
    if (!dispatcher) {
      console.error('[claw-host] action 分发器未加载，插件交互不可用');
      return 0;
    }
    let count = 0;
    for (const [name, fn] of Object.entries(actions || {})) {
      dispatcher.register(name, fn, owner);
      count += 1;
    }
    return count;
  }

  function unregisterActionsOf(owner) {
    const dispatcher = window.ClawFW?.actions;
    if (!dispatcher || typeof dispatcher.unregisterOwner !== 'function') return 0;
    return dispatcher.unregisterOwner(owner);
  }

  // ── panels ────────────────────────────────────────────────────────
  // 收编 right-panel-registry 的既有语义（when 过滤、注册校验、Meta 元数据），
  // 不改变注册方行为；旧入口 window.ClawPanels 继续可用。
  const panels = new Map();

  function normalizeValues(values) {
    if (values == null) return null;
    return (Array.isArray(values) ? values : [values]).map((value) => String(value));
  }

  function matches(values, actual) {
    return values === null || (actual != null && values.includes(String(actual)));
  }

  function registerPanel(id, panel) {
    const key = String(id || '').trim();
    if (!key) throw new TypeError('Panel ID is required');
    if (!panel || typeof panel.render !== 'function') {
      throw new TypeError(`Panel "${key}" must provide a render function`);
    }
    if (panels.has(key)) throw new Error(`Panel "${key}" is already registered`);
    const when = panel.when || {};
    panels.set(key, {
      ...panel,
      id: key,
      when: { agentIds: normalizeValues(when.agentIds), surfaces: normalizeValues(when.surfaces) },
    });
    return panels.get(key);
  }

  function getAvailablePanels(context = {}) {
    return Array.from(panels.values()).filter(
      (panel) => matches(panel.when.agentIds, context.agentId) && matches(panel.when.surfaces, context.surface),
    );
  }

  // ── slots ─────────────────────────────────────────────────────────
  // 槽位挂载：宿主提供位置，APP 决定放什么。按签名比对，语义不变不动 DOM，
  // 避免轮询重渲染重建正在输入的输入框。
  const slots = new Map(); // slotId -> { signature, html }

  function mountSlot(slotId, signature, render) {
    const key = String(slotId || '').trim();
    if (!key) throw new TypeError('slotId is required');
    if (typeof render !== 'function') throw new TypeError(`slot "${key}" needs a render function`);
    const el = document.getElementById(key);
    if (!el) {
      console.error('[claw-host] 槽位元素不存在：', key);
      return false;
    }
    const sig = String(signature ?? '');
    const prev = slots.get(key);
    if (prev && prev.signature === sig) return false;
    el.innerHTML = render() || '';
    slots.set(key, { signature: sig, html: el.innerHTML });
    return true;
  }

  function clearSlot(slotId) {
    const key = String(slotId || '').trim();
    const el = document.getElementById(key);
    if (el) el.innerHTML = '';
    slots.delete(key);
  }

  // ── 插件装载与卸载 ─────────────────────────────────────────────────
  const loaded = new Map(); // pluginId -> { module, owner }
  // pluginId -> 'loading' | 'loaded' | 'failed'。失败后不再自动重试：渲染是
  // 高频路径，重试会造成请求风暴；恢复手段是刷新页面。
  const loadState = new Map();
  const loadCallbacks = [];
  // agent → pluginId 的解析由宿主清单提供（claw-host 不认识 APP 清单格式）。
  let ownerOfAgent = null;
  function setPluginResolver(fn) {
    ownerOfAgent = typeof fn === 'function' ? fn : null;
  }

  /**
   * 按模块对象完成注册（block / refresher / action）。
   * 与动态 import 分开，是因为注册步骤本身不依赖模块来源；
   * loadPlugin 取到模块后即调用它。
   */
  async function activatePlugin(key, mod) {
    const owner = mod.id || key;
    for (const [type, renderer] of Object.entries(mod.blocks || {})) {
      registerBlock(type, renderer, owner);
    }
    for (const [type, fn] of Object.entries(mod.refreshers || {})) {
      registerRefresher(type, fn, owner);
    }
    if (mod.actions) registerActions(mod.actions, owner);
    if (typeof mod.mount === 'function') await mod.mount(api);
    loaded.set(key, { module: mod, owner });
    return mod;
  }

  async function loadPlugin(pluginId, url) {
    const key = String(pluginId || '').trim();
    if (!key) throw new TypeError('pluginId is required');
    if (loaded.has(key)) return loaded.get(key).module;
    const module = await import(url);
    return activatePlugin(key, module.default || module);
  }

  /**
   * 渲染路径触发的幂等装载：同一插件在 loading / loaded / failed 时都不再发起。
   * 完成后回调通知（宿主据此重渲染，把占位或错误态换成真实内容）。
   * 返回是否本次真正发起了装载。
   */
  function ensurePlugin(pluginId, url) {
    const key = String(pluginId || '').trim();
    if (!key) return false;
    const state = loadState.get(key);
    if (state === 'loading' || state === 'loaded' || state === 'failed') return false;
    loadState.set(key, 'loading');
    loadPlugin(key, url)
      .then(() => {
        loadState.set(key, 'loaded');
        notifyLoadSettled(key);
      })
      .catch((err) => {
        loadState.set(key, 'failed');
        console.error('[claw-host] 插件装载失败：', key, url, err);
        notifyLoadSettled(key);
      });
    return true;
  }

  function notifyLoadSettled(pluginId) {
    for (const cb of loadCallbacks) {
      try { cb(pluginId); } catch (err) { console.error('[claw-host] 装载回调异常：', err); }
    }
  }

  /** 注册装载落定回调（宿主用于重渲染），返回取消函数。 */
  function onPluginLoadSettled(cb) {
    if (typeof cb !== 'function') return () => {};
    loadCallbacks.push(cb);
    return () => {
      const index = loadCallbacks.indexOf(cb);
      if (index >= 0) loadCallbacks.splice(index, 1);
    };
  }

  function getPluginLoadState(pluginId) {
    return loadState.get(String(pluginId || '').trim()) || null;
  }

  /**
   * 卸载插件：先给插件自身清理机会（unmount），再由宿主按 owner 摘除它注册的一切
   * （blocks / refreshers / actions）。插件忘记清理也不能留下悬空注册项——
   * 这是「随时挂上、卸载」承诺的兜底。
   */
  async function unloadPlugin(pluginId) {
    const key = String(pluginId || '').trim();
    const entry = loaded.get(key);
    if (!entry) return false;
    if (typeof entry.module.unmount === 'function') await entry.module.unmount();
    unregisterBlocksOf(entry.owner);
    unregisterActionsOf(entry.owner);
    loaded.delete(key);
    return true;
  }

  function isPluginLoaded(pluginId) {
    return loaded.has(String(pluginId || '').trim());
  }

  const api = {
    version: VERSION,
    blocks: {
      registerPrimitive,
      register: registerBlock,
      render: renderBlock,
      has: (type) => primitives.has(String(type)) || pluginBlocks.has(String(type)),
      isPrimitive: (type) => primitives.has(String(type)),
      unregisterOwner: unregisterBlocksOf,
      registerRefresher,
      refresh,
    },
    panels: {
      register: registerPanel,
      get: (id) => panels.get(String(id)),
      getAll: () => Array.from(panels.values()),
      getAvailable: getAvailablePanels,
      has: (id) => panels.has(String(id)),
    },
    slots: { mount: mountSlot, clear: clearSlot },
    // 工作空间动作：插件不该直接引用宿主全局函数（runWorkspaceAction 等），
    // 统一经此入口调用。宿主实现变更时只改这里，插件不受影响。
    workspace: {
      runAction(rawAction, triggerButton) {
        return window.runWorkspaceAction(rawAction, triggerButton);
      },
      // 当前选中的 agent 记录（宿主封装；插件不直接依赖该全局实现）
      currentAgent() {
        return typeof getCurrentAgentRecord === 'function' ? getCurrentAgentRecord() : null;
      },
      // 整屏重渲染（插件改了自己的导航状态后由宿主重建视图）
      rerender() {
        if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
      },
      // 切换首页/对话等视图模式（setPreferredUnitMode 是 app-ui 的顶层函数，
      // 插件不裸引用：宿主签名变更时只改此处）
      setUnitMode(mode, agent) {
        if (typeof setPreferredUnitMode === 'function') setPreferredUnitMode(mode, agent);
      },
      // 工作空间状态（服务端下发的 workspace_state，插件按需读取）
      workspaceState(agent) {
        return typeof getAgentWorkspaceState === 'function' ? getAgentWorkspaceState(agent) : null;
      },
      // 该工作空间的会话列表（按目录/项目聚合，插件做只读投影）
      sessions(agent) {
        return typeof getWorkspaceSessions === 'function' ? getWorkspaceSessions(agent) : [];
      },
      // Feature 仓库数据（宿主侧多处复用：配置面板、装配台、Studio 首页）
      featureRepository(agent, block) {
        return typeof getFeatureRepositoryData === 'function'
          ? getFeatureRepositoryData(agent, block)
          : null;
      },
    },
    // 宿主能力统一经注入暴露，插件避免绑定到宿主内部符号名。
    // 顶层 let/const 可由模块按裸标识符解析，但不会成为 window 属性；
    // 注入面使宿主改名或替换实现时只需调整此处。
    env: {
      get language() {
        return (typeof currentLanguage === 'string' ? currentLanguage : 'zh');
      },
      isZh() {
        return (typeof currentLanguage === 'string' ? currentLanguage : 'zh') === 'zh';
      },
      escapeHtml(value) {
        return window.escapeHtml ? window.escapeHtml(value) : String(value ?? '');
      },
      // KaTeX 排版增强（指南正文用；对话页同款）
      enhanceMathInElement(el) {
        return typeof enhanceMathInElement === 'function' ? enhanceMathInElement(el) : undefined;
      },
      // 图片缩放层（指南正文里点击图片复用对话页行为）
      openImageZoom(src) {
        return typeof openImageZoom === 'function' ? openImageZoom(src) : undefined;
      },
      // 工作空间日期格式化（统一口径，避免插件各写一份）
      formatDate(value) {
        return typeof formatWorkspaceDate === 'function' ? formatWorkspaceDate(value) : '';
      },
      markdown: {
        render: (text) => (window.renderMarkdown ? window.renderMarkdown(text) : String(text ?? '')),
        splitBlocks: (text) => (window.splitMarkdownBlocks ? window.splitMarkdownBlocks(text) : []),
        isEditableBlock: (block) => (window.isEditableMarkdownBlock ? window.isEditableMarkdownBlock(block) : false),
        replaceBlock: (src, idx, text) => (window.replaceMarkdownBlock
          ? window.replaceMarkdownBlock(src, idx, text)
          : src),
      },
    },
    loadPlugin,
    // 已取得的模块对象直接激活（不重新 import）：供宿主内部与测试复用同一注册路径
    activatePlugin,
    ensurePlugin,
    onPluginLoadSettled,
    getPluginLoadState,
    setPluginResolver,
    unloadPlugin,
    isPluginLoaded,
  };

  window.ClawHost = api;
})();
