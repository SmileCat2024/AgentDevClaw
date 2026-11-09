/**
 * feature-ui-registry.js — 动态插件面板声明装载（ADR-0045 P1）
 *
 * 与 panel-plugins.js（静态清单，随产品分发）互补：从 server 声明 API
 * （/api/feature-ui/declarations）拉取"插件包素材 × 装配事实"合成的
 * 面板声明，转成 ClawHost.panels 的懒 stub。声明不再下发（卸载/禁用）
 * 时按钮占位一并退场；同面板版本变化（url 变）时替换 stub。
 *
 * server 声明 meta 是纯数据（label: {zh, en} / order / when / icon），
 * 这里补齐宿主消费的 title 函数（对齐 panel-plugins.js 静态声明的形态）。
 *
 * 全局状态纪律：本模块无顶层状态，对外暴露 window.ClawFW.featureUi
 * （refresh / stop），供插件页装配操作后主动刷新与测试清理。
 */
(function () {
  'use strict';

  const DECLARATIONS_API = '/api/feature-ui/declarations';
  const POLL_INTERVAL_MS = 30000;

  let lastSnapshot = new Map(); // panelId → { panelId, url }（diff 退场/换版用）
  let inflight = null;
  let pollTimer = null;

  function toHostMeta(decl) {
    const meta = (decl && decl.meta) || {};
    const out = Object.assign({}, meta);
    const label = meta.label || {};
    // server 只发纯数据；title 函数在宿主侧生成（currentLanguage 是
    // classic script 顶层 let，模块作用域链可见——与静态清单同款用法）
    if (typeof meta.title !== 'function' && (label.zh || label.en)) {
      out.title = () => (currentLanguage === 'zh' ? (label.zh || label.en) : (label.en || label.zh));
    }
    return out;
  }

  function applyDeclarations(declarations) {
    const next = new Map();
    let changed = false;
    for (const decl of declarations) {
      if (decl && decl.panelId && decl.url && decl.pluginId) next.set(decl.panelId, decl);
    }

    // 退场：上次有、这次无（卸载/禁用后 server 停发）
    for (const id of lastSnapshot.keys()) {
      if (!next.has(id)) {
        try {
          changed = window.ClawHost.panels.undeclare(id) || changed;
        } catch (err) {
          console.error('[feature-ui-registry] 面板声明退场失败：', id, err);
        }
      }
    }

    // 新增 / 换版（url 变了先退再声明；打开中的面板走 teardown 清理）
    for (const [id, decl] of next) {
      const prev = lastSnapshot.get(id);
      if (prev && prev.url === decl.url) continue;
      if (prev) {
        try {
          changed = window.ClawHost.panels.undeclare(id) || changed;
        } catch (err) { /* 退场失败不阻塞重声明 */ }
      }
      try {
        window.ClawHost.panels.declare(id, toHostMeta(decl), { pluginId: decl.pluginId, url: decl.url });
        changed = true;
      } catch (err) {
        console.error('[feature-ui-registry] 面板声明失败：', id, err);
      }
    }

    lastSnapshot = new Map(Array.from(next.entries()).map(([id, decl]) => [id, { panelId: id, url: decl.url }]));
    if (changed) {
      if (typeof window.syncRailButtons === 'function') window.syncRailButtons();
      if (typeof renderCurrentMainView === 'function') renderCurrentMainView();
    }
  }

  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const res = await fetch(DECLARATIONS_API);
        const payload = await res.json();
        if (!payload.ok) throw new Error(payload.error || 'declarations api returned not ok');
        applyDeclarations(payload.declarations || []);
      } catch (err) {
        console.error('[feature-ui-registry] 拉取面板声明失败：', err);
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  window.ClawFW = window.ClawFW || {};
  window.ClawFW.featureUi = { refresh, stop };

  refresh();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
})();
