/**
 * right-panel-registry.js — Claw host registry for right-rail panels.
 *
 * 实现已收编到 claw-host.js 的 panels 命名空间（同一份 Map，不并存两套）。
 * 本文件保留 window.ClawPanels 旧入口，供既有调用方无改动继续使用。
 */
window.ClawPanels = {
  register: (id, panel) => window.ClawHost.panels.register(id, panel),
  get: (id) => window.ClawHost.panels.get(id),
  getAll: () => window.ClawHost.panels.getAll(),
  getAvailable: (context) => window.ClawHost.panels.getAvailable(context),
  has: (id) => window.ClawHost.panels.has(id),
};
