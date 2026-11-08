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
 *   { id, blocks?, refreshers?, actions?, panels?, mount?(host), unmount?() }
 * 模块装载后由宿主调用 mount(host)——host 是绑定该插件 owner 的 api（注册
 * 方法自动归属，另提供 host.effect(disposer) 登记副作用清理）；卸载前调用
 * unmount() 再按 owner 摘除其注册项与 effect 清单。
 */
(function () {
  'use strict';

  const VERSION = '1.0';

  // ── blocks ────────────────────────────────────────────────────────
  const primitives = new Map(); // type -> renderer（宿主，不可覆盖）
  const pluginBlocks = new Map(); // type -> { renderer, owner }
  const refreshers = new Map(); // type -> refresh fn（插件声明，随卸载移除）
  // 面板偏好内存缓存：agentId -> Map(panelId -> prefs 对象)；
  // 同页面会话内 get 免二次请求，set 乐观更新 + 整块 PUT（幂等自愈）
  const panelPrefsCacheByAgent = new Map();

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

  /** refresher 可独立于 block 注册（refresher-only），摘除必须独立遍历，
   *  不能只依赖 unregisterBlocksOf 里按同名 block 的连带删除。 */
  function unregisterRefreshersOf(owner) {
    let removed = 0;
    for (const [type, entry] of refreshers) {
      if (entry.owner === owner) {
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

  // 懒面板声明（ADR-0044 P3）：清单侧先注册元数据占位（stub），rail 按钮与
  // 自定义清单立即可用；真实现（render/mountBody）随插件模块按需装载后
  // 经 registerPanel 替换 stub。插件卸载时 stub 恢复，可再次装载。
  const panelStubs = new Map(); // panelId -> { meta, pluginId, url }

  function normalizeValues(values) {
    if (values == null) return null;
    return (Array.isArray(values) ? values : [values]).map((value) => String(value));
  }

  function matches(values, actual) {
    return values === null || (actual != null && values.includes(String(actual)));
  }

  function registerPanel(id, panel, owner) {
    const key = String(id || '').trim();
    if (!key) throw new TypeError('Panel ID is required');
    // 双轨渲染（ADR-0044 P2c）：render（HTML 字符串型）或
    // mountBody（容器型，body 渲染权移交面板）至少提供其一
    if (!panel
        || (typeof panel.render !== 'function' && typeof panel.mountBody !== 'function')) {
      throw new TypeError(`Panel "${key}" must provide a render or mountBody function`);
    }
    const existing = panels.get(key);
    if (existing) {
      // stub → real 是唯一的受控替换路径：懒声明占位等到了它的实现。
      // real → real 仍是冲突（两个插件抢同一面板）。
      if (!existing.stub) throw new Error(`Panel "${key}" is already registered`);
      if (!panelStubs.has(key)) throw new Error(`Panel "${key}" has no lazy declaration`);
    }
    const when = panel.when || {};
    panels.set(key, {
      ...panel,
      id: key,
      owner: owner || null,
      when: { agentIds: normalizeValues(when.agentIds), surfaces: normalizeValues(when.surfaces) },
    });
    return panels.get(key);
  }

  /**
   * 懒面板声明：清单侧启动即调用，注册元数据占位（stub）。stub 不带
   * render/mountBody，按钮与显隐过滤照常工作；打开时由编排层触发
   * ensurePlugin 装载真实现，registerPanel 把 stub 替换为 real。
   * loader = { pluginId, url } 指明实现所在的插件模块。
   */
  function declarePanel(id, meta, loader) {
    const key = String(id || '').trim();
    if (!key) throw new TypeError('Panel ID is required');
    if (!loader || !loader.pluginId || !loader.url) {
      throw new TypeError(`Panel "${key}" lazy declaration needs { pluginId, url }`);
    }
    if (panels.has(key)) throw new Error(`Panel "${key}" is already registered`);
    const when = (meta && meta.when) || {};
    const stub = {
      ...(meta || {}),
      id: key,
      owner: null,
      stub: { pluginId: String(loader.pluginId), url: loader.url },
      when: { agentIds: normalizeValues(when.agentIds), surfaces: normalizeValues(when.surfaces) },
    };
    panelStubs.set(key, { meta: stub, pluginId: stub.stub.pluginId, url: stub.stub.url });
    panels.set(key, stub);
    return stub;
  }

  /** real 摘除后恢复对应 stub（若该面板有懒声明），面板可再次按需装载。 */
  function restorePanelStub(key) {
    const stubEntry = panelStubs.get(key);
    if (!stubEntry) return false;
    if (!panels.has(key)) panels.set(key, stubEntry.meta);
    return true;
  }

  /**
   * declarePanel 的逆操作：懒声明本身退场（stub 与注册项一起移除）。
   * 用于动态声明源（feature-ui-registry）：插件卸载/禁用后 server 不再
   * 下发该面板声明时，把按钮占位一并撤掉。已装载的 real 面板同样摘除。
   */
  function undeclarePanel(id) {
    const key = String(id || '').trim();
    panelStubs.delete(key);
    if (!panels.has(key)) return false;
    panels.delete(key);
    teardownPanel(key);
    return true;
  }

  /**
   * 面板摘除钩子：宿主编排层（debug-panel-host）注入。面板从注册表消失时
   * 若它正打开，需要走一次空面板渲染把 body 清空、按钮态复位——注册表
   * 不知道打开状态，这个清理只能由编排层完成（对齐 setPluginResolver 的注入模式）。
   */
  let panelTeardownHook = null;
  function setPanelTeardownHook(fn) {
    panelTeardownHook = typeof fn === 'function' ? fn : null;
  }

  function teardownPanel(key) {
    if (typeof panelTeardownHook !== 'function') return;
    try {
      panelTeardownHook(key);
    } catch (err) {
      // 钩子异常不得阻断摘除：面板照样从注册表消失，只是编排层清理可能不完整。
      console.error('[claw-host] 面板摘除钩子异常（继续摘除）：', key, err);
    }
  }

  function unregisterPanel(id) {
    const key = String(id || '').trim();
    if (!panels.has(key)) return false;
    panels.delete(key);
    // 懒声明面板摘除 real 后恢复 stub 占位（按钮不消失，可再次装载）
    restorePanelStub(key);
    teardownPanel(key);
    return true;
  }

  function unregisterPanelsOf(owner) {
    const removed = [];
    for (const [key, panel] of panels) {
      if (panel.owner === owner) {
        panels.delete(key);
        removed.push(key);
      }
    }
    for (const key of removed) {
      restorePanelStub(key);
      teardownPanel(key);
    }
    return removed.length;
  }

  function getAvailablePanels(context = {}) {
    return Array.from(panels.values()).filter(
      (panel) => matches(panel.when.agentIds, context.agentId) && matches(panel.when.surfaces, context.surface),
    );
  }

  // ── slots ─────────────────────────────────────────────────────────
  // 槽位挂载：宿主提供位置，APP 决定放什么。按签名比对，语义不变不动 DOM，
  // 避免轮询重渲染重建正在输入的输入框。
  const slots = new Map(); // slotId -> { signature, html, owner }

  function mountSlot(slotId, signature, render, owner) {
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
    slots.set(key, { signature: sig, html: el.innerHTML, owner: owner || null });
    return true;
  }

  function clearSlot(slotId) {
    const key = String(slotId || '').trim();
    const el = document.getElementById(key);
    if (el) el.innerHTML = '';
    slots.delete(key);
  }

  /** 按插件摘除槽位：DOM 清空与记录删除一起做（卸载即界面消失）。 */
  function unregisterSlotsOf(owner) {
    const keys = [];
    for (const [key, entry] of slots) {
      if (entry.owner === owner) keys.push(key);
    }
    for (const key of keys) clearSlot(key);
    return keys.length;
  }

  // ── effect 撤销面 ─────────────────────────────────────────────────
  // 插件在 mount 里把超出注册面的副作用清理（定时器、事件源、observer）登记
  // 进来；卸载与激活失败回滚时宿主统一执行。注册面兜底由此升级为对任意
  // 副作用的契约（ADR-0044 决策 3）。effect 只在绑定 owner 的 api 上暴露
  // （makeOwnerBoundApi），无主 effect 无人执行，顶层不提供。
  const effects = new Map(); // owner -> Set<disposer>

  function registerEffect(owner, disposer) {
    if (typeof disposer !== 'function') return false;
    let set = effects.get(owner);
    if (!set) {
      set = new Set();
      effects.set(owner, set);
    }
    set.add(disposer);
    return true;
  }

  async function runEffectsOf(owner) {
    const set = effects.get(owner);
    if (!set) return 0;
    effects.delete(owner); // 先取走清单再执行：disposer 重入登记的进下一轮，天然幂等
    for (const dispose of set) {
      try {
        const result = dispose();
        if (result && typeof result.then === 'function') await result;
      } catch (err) {
        // 单个 disposer 抛错不得阻断其余清理（与 unmount 抛错误摘除必达同语义）。
        console.error('[claw-host] effect 清理异常（继续其余清理）：', owner, err);
      }
    }
    return set.size;
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
  /**
   * 绑定 owner 的宿主 api：插件 mount(host) 拿到的是这份——其中的注册方法
   * （blocks / panels / slots / effect）自动带上当前插件 owner，插件不必显式
   * 传参，宿主内部也无「当前激活插件」可变全局（async mount 交织下会串）。
   * 显式传 owner 参数的调用方优先（宿主内部与测试）。
   */
  function makeOwnerBoundApi(owner) {
    return {
      ...api,
      blocks: {
        ...api.blocks,
        register: (type, renderer, explicit) => api.blocks.register(type, renderer, explicit ?? owner),
        registerRefresher: (type, fn, explicit) => api.blocks.registerRefresher(type, fn, explicit ?? owner),
      },
      panels: {
        ...api.panels,
        register: (id, panel, explicit) => api.panels.register(id, panel, explicit ?? owner),
      },
      slots: {
        ...api.slots,
        mount: (slotId, signature, render, explicit) => api.slots.mount(slotId, signature, render, explicit ?? owner),
      },
      effect: (disposer) => registerEffect(owner, disposer),
    };
  }

  async function activatePlugin(key, mod) {
    const owner = mod.id || key;
    for (const [type, renderer] of Object.entries(mod.blocks || {})) {
      registerBlock(type, renderer, owner);
    }
    for (const [type, fn] of Object.entries(mod.refreshers || {})) {
      registerRefresher(type, fn, owner);
    }
    if (mod.actions) registerActions(mod.actions, owner);
    if (mod.panels) {
      for (const [panelId, panel] of Object.entries(mod.panels)) {
        registerPanel(panelId, panel, owner);
      }
    }
    if (typeof mod.mount === 'function') {
      try {
        await mod.mount(makeOwnerBoundApi(owner));
      } catch (err) {
        // mount 抛错时回滚本轮注册项（声明式 + mount 内经绑定 api 动态注册的
        // 都带 owner，一并可摘）：半激活插件不在 loaded 表里，unloadPlugin
        // 够不着，不回滚就泄漏到刷新页面。
        unregisterBlocksOf(owner);
        unregisterRefreshersOf(owner);
        unregisterActionsOf(owner);
        unregisterPanelsOf(owner);
        unregisterSlotsOf(owner);
        await runEffectsOf(owner);
        throw err;
      }
    }
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
        // 落定时插件可能已被显式卸载（loadState 被清空）：过期落定不得回写，
        // 否则恢复的 stub 会被 failed/loaded 态拦截，懒面板卡死在占位。
        if (loadState.get(key) === 'loading') loadState.set(key, 'loaded');
        notifyLoadSettled(key);
      })
      .catch((err) => {
        if (loadState.get(key) === 'loading') loadState.set(key, 'failed');
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
   * 卸载插件：先给插件自身清理机会（unmount），再由宿主按 owner 摘除它注册的
   * 一切——blocks / refreshers / actions / panels / slots 与 effect 清单。
   * 摘除顺序：注册项先消失（DOM 面即刻撤下），effect 清单最后执行（定时器、
   * 订阅收尾）。插件忘记清理也不能留下悬空注册项——这是「随时挂上、卸载」
   * 承诺的兜底。
   */
  async function unloadPlugin(pluginId) {
    const key = String(pluginId || '').trim();
    const entry = loaded.get(key);
    if (!entry) return false;
    try {
      if (typeof entry.module.unmount === 'function') await entry.module.unmount();
    } catch (err) {
      // 插件 unmount 抛错不得跳过宿主摘除：否则插件僵尸化——loaded 表与
      // 注册表都残留，重装同名 type 直接报错。记录后继续，清理必达。
      console.error('[claw-host] 插件 unmount 异常（继续摘除注册项）：', key, err);
    }
    unregisterBlocksOf(entry.owner);
    unregisterRefreshersOf(entry.owner);
    unregisterActionsOf(entry.owner);
    unregisterPanelsOf(entry.owner);
    unregisterSlotsOf(entry.owner);
    await runEffectsOf(entry.owner);
    loaded.delete(key);
    // 卸载后允许渲染路径重新拉起（懒面板 stub 恢复后再点开走 ensurePlugin）。
    // loadState 只拦幂等渲染触发，不影响 loadPlugin 的显式重装载路径。
    loadState.delete(key);
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
      declare: declarePanel,
      undeclare: undeclarePanel,
      unregister: unregisterPanel,
      get: (id) => panels.get(String(id)),
      getAll: () => Array.from(panels.values()),
      getAvailable: getAvailablePanels,
      has: (id) => panels.has(String(id)),
    },
    slots: { mount: mountSlot, clear: clearSlot },
    // 面板偏好（ADR-0046 决策 3）：按 panelId 命名空间的服务端 KV，随工作空间走。
    // 面板作者经 host.panelPrefs(panelId) 拿 { get, set }；存储与多空间隔离由宿主
    // 负责（api：/api/feature-ui/panel-prefs，与呈现配置同一份工作空间文件）。
    panelPrefs(panelId) {
      const id = String(panelId || '').trim();
      if (!id) throw new Error('panelPrefs(panelId): panelId 不能为空');
      // 聚焦工作空间（顶层 let 裸读，与 workspace.focusedRuntimeId 同模式）；
      // 无聚焦时落主空间。读发生在面板交互时（非渲染关键路径），暂态空值可接受。
      const prefsAgentId = () => (String(focusedAgentId || '').trim() || 'programming-helper');
      // 面板级内存缓存：同页面会话内 get 免二次请求；set 合并整块 PUT（幂等）
      const cache = () => {
        panelPrefsCacheByAgent.set(prefsAgentId(), panelPrefsCacheByAgent.get(prefsAgentId()) || new Map());
        return panelPrefsCacheByAgent.get(prefsAgentId());
      };
      const ensureLoaded = () => {
        const agentCache = cache();
        if (agentCache.has(id)) return Promise.resolve(agentCache.get(id));
        return fetch('/api/feature-ui/ui-prefs?agentId=' + encodeURIComponent(prefsAgentId()))
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
          .then((body) => {
            const prefs = (body?.prefs?.panelPrefs && body.prefs.panelPrefs[id]) || {};
            agentCache.set(id, prefs);
            return prefs;
          })
          .catch(() => { agentCache.set(id, {}); return {}; });
      };
      return {
        get(key) {
          return ensureLoaded().then((prefs) => prefs[key]);
        },
        set(key, value) {
          const agentId = prefsAgentId();
          return ensureLoaded().then((prefs) => {
            const next = { ...prefs, [String(key)]: value };
            cache().set(id, next);
            return fetch('/api/feature-ui/panel-prefs', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ agentId, panelId: id, prefs: next }),
            }).then((res) => {
              if (!res.ok) throw new Error('HTTP ' + res.status);
            }).catch((err) => {
              // 落盘失败保留乐观态，下次 set 整块重 PUT 自愈
              console.warn('[claw-host] panelPrefs.set 落盘失败（下次写入重试）：', err);
            });
          });
        },
      };
    },
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
      // 当前聚焦会话的 runtime 寻址键（user-turn 等会话输入 API 的路径参数）；
      // 无运行中会话时返回 ''。同步读取（stale check 同源 currentRuntimeAgentId）。
      focusedRuntimeId() {
        return String(currentRuntimeAgentId || '').trim();
      },
      // 按 id 查 agent 条目（含 workspace_sessions 投影；找不到返回 null）
      agentById(agentId) {
        const id = String(agentId || '');
        if (!id || !Array.isArray(allAgents)) return null;
        return allAgents.find((item) => item?.id === id) || null;
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
      // 幂等键（与宿主请求通道同一生成实现；coder 插件的 interrupt 等直连请求用）
      newIdempotencyKey() {
        return typeof newIdempotencyKey === 'function' ? newIdempotencyKey() : '';
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
    setPanelTeardownHook,
    unloadPlugin,
    isPluginLoaded,
  };

  window.ClawHost = api;
})();
