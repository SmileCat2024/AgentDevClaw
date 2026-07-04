/**
 * Front-end VM test helper.
 *
 * Provides a reusable sandbox for testing browser-bound JS modules
 * (public/src/*.js) in Node.js without a real browser.
 *
 * Usage:
 *   import { createFrontendSandbox } from './helpers/frontend-vm.js';
 *   const ctx = createFrontendSandbox();
 *   ctx.loadSource('../public/src/app-core.js');
 *   // access functions: ctx.run('getFeatureStatus({ enabled: true })')
 */

import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Create a browser-like VM sandbox context.
 *
 * @param {object} [overrides] — additional globals to inject
 * @returns {object} sandbox context with helper methods
 */
export function createFrontendSandbox(overrides = {}) {
  // Minimal DOM stubs
  const elementStub = {
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    appendChild() {},
    removeChild() {},
    insertAdjacentHTML() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    innerHTML: '',
    textContent: '',
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  };

  const documentStub = {
    getElementById() { return { ...elementStub }; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { ...elementStub }; },
    createTextNode(text) { return { textContent: text }; },
    addEventListener() {},
    body: { ...elementStub },
    head: { ...elementStub },
    documentElement: { ...elementStub },
    readyState: 'complete',
  };

  const localStorageData = {};
  const localStorageStub = {
    getItem(key) { return localStorageData[key] ?? null; },
    setItem(key, value) { localStorageData[key] = String(value); },
    removeItem(key) { delete localStorageData[key]; },
    clear() { Object.keys(localStorageData).forEach(k => delete localStorageData[k]); },
  };

  const windowStub = {
    document: documentStub,
    localStorage: localStorageStub,
    location: { href: 'http://127.0.0.1:1420', pathname: '/', search: '' },
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 720,
    scrollTo() {},
    requestAnimationFrame(cb) { return setTimeout(cb, 0); },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
  };

  const context = {
    // Browser globals
    window: windowStub,
    document: documentStub,
    localStorage: localStorageStub,
    location: windowStub.location,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    Map,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    encodeURIComponent,
    decodeURIComponent,
    // escapeHtml stub — real definition is in modules/markdown-utils.js
    escapeHtml(text) {
      if (text == null) return '';
      return String(text).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]);
    },
    // State defaults
    currentLanguage: 'zh',
    currentAgentId: null,
    currentRuntimeAgentId: null,
    currentMessages: [],
    allAgents: [],
    ...overrides,
  };

  vm.createContext(context);

  /**
   * Load and execute a front-end JS source file in the sandbox.
   * @param {string} relativePath — path relative to project root
   */
  context.loadSource = function (relativePath) {
    const fullPath = join(__dirname, '..', '..', relativePath);
    const source = fs.readFileSync(fullPath, 'utf8');
    vm.runInContext(source, context, { filename: fullPath });
  };

  /**
   * Run an expression in the sandbox and return the result.
   * @param {string} code — JS expression to evaluate
   * @returns {*} result
   */
  context.run = function (code) {
    return vm.runInContext(code, context);
  };

  return context;
}

/**
 * Extract a code block between two markers in a source file.
 * Useful when you only need a subset of a large file.
 *
 * @param {string} source — full source text
 * @param {string} startMarker — text to start from (inclusive)
 * @param {string} endMarker — text to end before (exclusive)
 * @returns {string} extracted block
 */
export function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start === -1) throw new Error(`Missing start marker: ${startMarker}`);
  if (end === -1) throw new Error(`Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}
