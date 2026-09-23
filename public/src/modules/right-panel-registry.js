/**
 * right-panel-registry.js — Claw host registry for right-rail panels.
 */
(function () {
  'use strict';

  const panels = new Map();

  function normalizeValues(values) {
    if (values == null) return null;
    return (Array.isArray(values) ? values : [values]).map((value) => String(value));
  }

  function matches(values, actual) {
    return values === null || (actual != null && values.includes(String(actual)));
  }

  function register(id, panel) {
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
      when: {
        agentIds: normalizeValues(when.agentIds),
        surfaces: normalizeValues(when.surfaces),
      },
    });
    return panels.get(key);
  }

  function getAvailable(context = {}) {
    return Array.from(panels.values()).filter((panel) =>
      matches(panel.when.agentIds, context.agentId)
      && matches(panel.when.surfaces, context.surface)
    );
  }

  window.ClawPanels = {
    register,
    get: (id) => panels.get(String(id)),
    getAvailable,
    has: (id) => panels.has(String(id)),
  };
})();
