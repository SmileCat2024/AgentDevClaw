import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

function createElement(tagName = 'div') {
  const listeners = new Map();
  const node = {
    tagName,
    className: '',
    textContent: '',
    innerHTML: '',
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    classList: {
      add(name) { node.className = `${node.className} ${name}`.trim(); },
      remove(name) { node.className = node.className.split(/\s+/).filter((item) => item !== name).join(' '); },
      contains(name) { return node.className.split(/\s+/).includes(name); },
    },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) { return node.attributes[name] ?? null; },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, reference) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    remove() { this.parentNode?.removeChild(this); },
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(callback);
    },
    removeEventListener(type, callback) {
      listeners.set(type, (listeners.get(type) || []).filter((item) => item !== callback));
    },
    querySelector(selector) { return find(node, selector); },
    querySelectorAll(selector) { return findAll(node, selector); },
  };
  return node;
}

function matches(node, selector) {
  return selector.startsWith('.') && node.className.split(/\s+/).includes(selector.slice(1));
}

function find(node, selector) {
  return findAll(node, selector)[0] || null;
}

function findAll(node, selector) {
  const found = [];
  for (const child of node.children) {
    if (matches(child, selector)) found.push(child);
    found.push(...findAll(child, selector));
  }
  return found;
}

function createToastEnvironment() {
  const timers = [];
  const container = createElement();
  container.id = 'toast-container';
  const body = createElement('body');
  // i18n-environment-state 会 claim 域状态并注册 applyTheme/applyLanguage 桥键
  // （P4 T1 由 theme-lang 并入），因此桩必须对齐真实 KernelState 的两个入口。
  const windowStub = { KernelState: { claim() {}, defineKey() {} } };
  const documentStub = {
    body,
    getElementById(id) { return id === 'toast-container' ? container : null; },
    querySelector() { return null; },
    createElement,
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    timers,
    windowStub,
    documentStub,
    container,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  };
}

async function loadToast(t) {
  const env = createToastEnvironment();
  t.mock.method(globalThis, 'setTimeout', env.setTimeout);
  t.mock.method(globalThis, 'clearTimeout', env.clearTimeout);
  const loaded = await loadModuleOnce('public/src/modules/toast-notify.js', {
    window: {
      ...env.windowStub,
      setTimeout: env.setTimeout,
      clearTimeout: env.clearTimeout,
    },
    document: env.documentStub,
  });
  t.after(loaded.cleanup);
  return { ...env, ...loaded };
}

test('real ESM exports and window expose the same ClawToast API object', async (t) => {
  const { module } = await loadToast(t);
  assert.equal(module.default, module.ClawToast);
  assert.equal(window.ClawToast, module.ClawToast);
  assert.deepEqual(Object.keys(module.ClawToast), ['show', 'update', 'dismiss', 'dismissAll']);
});

test('toast labels read the current language dynamically', async (t) => {
  const env = await loadToast(t);
  const { module } = env;
  const i18n = await import('../public/src/modules/i18n-environment-state.js');

  i18n.setCurrentLanguage('zh');
  module.ClawToast.show({ id: 'language', status: 'success', title: '完成', description: '详情' });
  assert.equal(env.container.querySelector('.toast-detail-btn').innerHTML.startsWith('详情'), true);

  module.ClawToast.dismiss('language');
  env.timers.find((timer) => timer.delay === 250)?.callback();
  i18n.setCurrentLanguage('en');
  module.ClawToast.show({ id: 'language-en', description: 'Details', title: 'Done' });
  assert.equal(env.container.querySelector('.toast-detail-btn').innerHTML.startsWith('Details'), true);
});

test('show, update, and dismiss operate on visible toast DOM', async (t) => {
  const { module, container, timers } = await loadToast(t);
  const toast = module.ClawToast;
  toast.show({ id: 'task', title: 'Working', description: 'Initial details' });
  const card = container.querySelector('.toast-card');
  assert.ok(card);
  assert.equal(card.querySelector('.toast-title').textContent, 'Working');
  assert.equal(card.querySelector('.toast-desc').textContent, 'Initial details');

  toast.update('task', { status: 'error', title: 'Failed', description: 'Updated details' });
  assert.equal(card.getAttribute('data-status'), 'error');
  assert.equal(card.querySelector('.toast-title').textContent, 'Failed');
  assert.equal(card.querySelector('.toast-desc').textContent, 'Updated details');

  toast.dismiss('task');
  assert.equal(card.classList.contains('toast-leaving'), true);
  timers.find((timer) => timer.delay === 250)?.callback();
  assert.equal(card.parentNode, null);
});

test('an info toast with an explicit autoDismiss duration is dismissed', async (t) => {
  const { module, container, timers } = await loadToast(t);
  module.ClawToast.show({ id: 'staged-input', status: 'info', title: 'Staged', autoDismiss: 5000 });

  assert.equal(timers[0].delay, 5000, 'the info toast must schedule the requested timeout');
  timers[0].callback();
  const card = container.querySelector('.toast-card');
  assert.equal(card.classList.contains('toast-leaving'), true,
    'the scheduled timeout must initiate dismissal of the visible notice');
});
