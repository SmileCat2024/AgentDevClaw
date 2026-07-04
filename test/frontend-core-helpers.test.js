/**
 * Example front-end module tests using the VM sandbox framework.
 *
 * Tests pure/near-pure functions from public/src/app-core.js.
 * This demonstrates the scaffold pattern for future front-end testing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * Helper: create a sandbox with app-core.js loaded.
 * app-core.js is the shared utilities module — it defines i18n, status helpers,
 * date formatters, and runtime cache functions used across the front-end.
 */
function createCoreSandbox(overrides = {}) {
  const ctx = createFrontendSandbox();
  ctx.getCurrentAgentRecord = () => null;
  ctx.loadSource('public/src/app-core.js');
  // Apply overrides AFTER loading source.
  // `let`/`const` in VM don't become context properties, so use runInContext.
  for (const [key, value] of Object.entries(overrides)) {
    ctx[key] = value;
    // Also set inside the VM context for `let`-declared globals
    ctx.run(`if (typeof ${key} !== 'undefined') ${key} = ${JSON.stringify(value)};`);
  }
  return ctx;
}

// ── getFeatureStatus ──

describe('app-core: getFeatureStatus', () => {
  it('returns explicit status when present', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('getFeatureStatus({ status: "enabled" })'), 'enabled');
    assert.equal(ctx.run('getFeatureStatus({ status: "disabled" })'), 'disabled');
    assert.equal(ctx.run('getFeatureStatus({ status: "partial" })'), 'partial');
  });

  it('returns enabled when feature.enabled is true and no status', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('getFeatureStatus({ enabled: true })'), 'enabled');
  });

  it('returns partial when no status and not enabled', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('getFeatureStatus({ enabled: false })'), 'partial');
    assert.equal(ctx.run('getFeatureStatus({})'), 'partial');
  });

  it('returns partial for null/undefined feature', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('getFeatureStatus(null)'), 'partial');
    assert.equal(ctx.run('getFeatureStatus(undefined)'), 'partial');
  });
});

// ── getStatusBadgeClass ──

describe('app-core: getStatusBadgeClass', () => {
  it('builds badge class from status', () => {
    const ctx = createCoreSandbox();
    assert.equal(
      ctx.run('getStatusBadgeClass("enabled")'),
      'feature-badge status-enabled'
    );
    assert.equal(
      ctx.run('getStatusBadgeClass("disabled")'),
      'feature-badge status-disabled'
    );
  });

  it('defaults to enabled when status is falsy', () => {
    const ctx = createCoreSandbox();
    assert.equal(
      ctx.run('getStatusBadgeClass(null)'),
      'feature-badge status-enabled'
    );
    assert.equal(
      ctx.run('getStatusBadgeClass("")'),
      'feature-badge status-enabled'
    );
    assert.equal(
      ctx.run('getStatusBadgeClass(undefined)'),
      'feature-badge status-enabled'
    );
  });

  it('escapes HTML-special characters in status', () => {
    const ctx = createCoreSandbox();
    const result = ctx.run('getStatusBadgeClass("<script>")');
    assert.ok(!result.includes('<script>'));
    assert.ok(result.includes('&lt;script&gt;'));
  });
});

// ── localizeWorkspaceValue ──

describe('app-core: localizeWorkspaceValue', () => {
  it('returns string values as-is', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('localizeWorkspaceValue("hello")'), 'hello');
    assert.equal(ctx.run('localizeWorkspaceValue(42)'), '42');
    assert.equal(ctx.run('localizeWorkspaceValue(true)'), 'true');
  });

  it('returns fallback for null/undefined', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('localizeWorkspaceValue(null, "default")'), 'default');
    assert.equal(ctx.run('localizeWorkspaceValue(undefined, "default")'), 'default');
  });

  it('extracts value by currentLanguage from object', () => {
    const ctx = createCoreSandbox({ currentLanguage: 'zh' });
    const result = ctx.run('localizeWorkspaceValue({ zh: "中文", en: "English" })');
    assert.equal(result, '中文');
  });

  it('falls back to zh then en then fallback for objects', () => {
    const ctx = createCoreSandbox({ currentLanguage: 'fr' });
    assert.equal(
      ctx.run('localizeWorkspaceValue({ zh: "中文", en: "English" })'),
      '中文'
    );
    assert.equal(
      ctx.run('localizeWorkspaceValue({ en: "English" })'),
      'English'
    );
    // When currentLanguage matches a key, it takes priority
    assert.equal(
      ctx.run('localizeWorkspaceValue({ fr: "Français" })'),
      'Français'
    );
    // Fallback only when no matching language key at all
    assert.equal(
      ctx.run('localizeWorkspaceValue({ de: "Deutsch" }, "fallback")'),
      'fallback'
    );
  });
});

// ── formatWorkspaceDate ──

describe('app-core: formatWorkspaceDate', () => {
  it('returns dash for empty input', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('formatWorkspaceDate("")'), '-');
    assert.equal(ctx.run('formatWorkspaceDate(null)'), '-');
    assert.equal(ctx.run('formatWorkspaceDate(undefined)'), '-');
  });

  it('returns original string for invalid date', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('formatWorkspaceDate("not-a-date")'), 'not-a-date');
  });

  it('formats valid ISO date string', () => {
    const ctx = createCoreSandbox();
    const result = ctx.run('formatWorkspaceDate("2024-06-15T10:30:00Z")');
    assert.ok(result.includes('2024') || result.includes('6') || result.includes('15'));
    assert.ok(result !== '-');
  });
});

// ── isUiOnlyAgentId ──

describe('app-core: isUiOnlyAgentId', () => {
  it('returns true for known UI-only agent IDs', () => {
    const ctx = createCoreSandbox({
      allAgents: [
        { id: 'feature-setup', source: 'prebuilt', launchMode: 'ui-only' },
      ],
    });
    assert.equal(ctx.run('isUiOnlyAgentId("feature-setup")'), true);
  });

  it('returns true for workspace host agents (programming-helper, qqbot)', () => {
    // isUiOnlyAgentId checks isWorkspaceSurfaceUnit which includes both
    // ui-only units and workspace host units (programming-helper, qqbot, etc.)
    const ctx = createCoreSandbox({
      allAgents: [
        { id: 'programming-helper', source: 'prebuilt' },
      ],
    });
    assert.equal(ctx.run('isUiOnlyAgentId("programming-helper")'), true);
  });

  it('returns false for unknown/null IDs when allAgents is empty', () => {
    const ctx = createCoreSandbox();
    assert.equal(ctx.run('isUiOnlyAgentId("nonexistent")'), false);
    assert.equal(ctx.run('isUiOnlyAgentId(null)'), false);
  });
});

// ── getRuntimeCacheTodoPlanSignature ──

describe('app-core: getRuntimeCacheTodoPlanSignature', () => {
  it('produces stable signature for same plan', () => {
    const ctx = createCoreSandbox();
    const sig1 = ctx.run('getRuntimeCacheTodoPlanSignature([{subject:"a",status:"pending"}])');
    const sig2 = ctx.run('getRuntimeCacheTodoPlanSignature([{subject:"a",status:"pending"}])');
    assert.ok(typeof sig1 === 'string');
    assert.ok(sig1.length > 0);
    assert.equal(sig1, sig2, 'same plan should produce same signature');
  });

  it('produces different signatures for different plans', () => {
    const ctx = createCoreSandbox();
    const sig1 = ctx.run('getRuntimeCacheTodoPlanSignature([{subject:"a",status:"pending"}])');
    const sig2 = ctx.run('getRuntimeCacheTodoPlanSignature([{subject:"b",status:"pending"}])');
    assert.notEqual(sig1, sig2);
  });
});

// ── Sandbox infrastructure ──

describe('frontend-vm sandbox', () => {
  it('provides localStorage stub that persists', () => {
    const ctx = createFrontendSandbox();
    ctx.run('localStorage.setItem("key", "value")');
    assert.equal(ctx.run('localStorage.getItem("key")'), 'value');
    ctx.run('localStorage.removeItem("key")');
    assert.equal(ctx.run('localStorage.getItem("key")'), null);
  });

  it('provides document stub with createElement', () => {
    const ctx = createFrontendSandbox();
    const el = ctx.run('document.createElement("div")');
    assert.ok(el);
    assert.ok(typeof el.appendChild === 'function');
  });

  it('provides escapeHtml stub', () => {
    const ctx = createFrontendSandbox();
    assert.equal(ctx.run('escapeHtml("<b>")'), '&lt;b&gt;');
  });

  it('supports overriding currentLanguage', () => {
    const ctx = createFrontendSandbox({ currentLanguage: 'en' });
    assert.equal(ctx.run('currentLanguage'), 'en');
  });
});
