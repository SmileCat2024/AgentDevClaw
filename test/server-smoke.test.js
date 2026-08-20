/**
 * Server module smoke test
 *
 * Validates that all server-side route modules and shared modules
 * can be imported without errors (catching circular deps, missing
 * exports, module-level exceptions).
 *
 * Also verifies that route setup functions register the expected
 * Express endpoints when called with a mock app.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Helper: create a mock Express app that records route registrations ──

function createMockApp() {
  const routes = [];
  const methods = ['get', 'post', 'put', 'delete', 'all', 'patch', 'head', 'options'];

  const app = (req, res, next) => { app.handle(req, res, next); };

  app.use = (...args) => { routes.push({ method: 'use', args }); };
  app.listen = () => app;

  for (const m of methods) {
    app[m] = (path, ...handlers) => {
      routes.push({ method: m, path, handlers });
    };
  }

  // Express static and json are needed by some setup functions
  app.static = () => (req, res, next) => next();

  return { app, routes };
}

function expressFactory() {
  const fn = () => createMockApp().app;
  fn.json = () => (req, res, next) => next();
  fn.raw = () => (req, res, next) => next();
  fn.static = () => (req, res, next) => next();
  fn.urlencoded = () => (req, res, next) => next();
  fn.Router = () => createMockApp().app;
  return fn;
}

// ── Import smoke test ──

describe('Server module imports', () => {
  it('should import all shared modules without error', async () => {
    const modules = [
      '../server/shared/constants.js',
      '../server/shared/string-helpers.js',
      '../server/shared/feature-utils.js',
      '../server/shared/fs-helpers.js',
      '../server/shared/agent-access.js',
      '../server/shared/session-access.js',
      '../server/shared/im-channels.js',
    ];

    for (const mod of modules) {
      const imported = await import(mod);
      assert.ok(imported, `Module ${mod} should import`);
    }
  });

  it('should import all route modules without error', async () => {
    const modules = [
      '../server/routes/system-feature-config.js',
      '../server/routes/fs-operations.js',
      '../server/routes/model-config.js',
      '../server/routes/group-chat.js',
      '../server/routes/dispatch.js',
      '../server/routes/im.js',
      '../server/routes/session-helpers.js',
      '../server/routes/session-token-refresh.js',
      '../server/routes/feature-repository.js',
      '../server/routes/flow.js',
      '../server/routes/assembly-helpers.js',
      '../server/routes/project-docset.js',
      '../server/routes/workspace.js',
      '../server/routes/workspace-creators.js',
      '../server/routes/agent-discovery.js',
      '../server/routes/agent-connected.js',
      '../server/routes/agent-startup.js',
      '../server/routes/agent-lifecycle.js',
      '../server/routes/oauth-codex.js',
      '../server/routes/proxy-config.js',
    ];

    for (const mod of modules) {
      const imported = await import(mod);
      assert.ok(imported, `Module ${mod} should import`);
    }
  });

  it('should import all standalone server modules without error', async () => {
    const modules = [
      '../server/call-arbiter.js',
      '../server/claw-core.mjs',
      '../server/conversation-renderer.js',
      '../server/model-preset-resolver.js',
      '../server/runtime-call-envelope.js',
      '../server/usage-ledger.js',
      '../server/claw-mcp.js',
      '../server/oauth-codex.js',
      '../server/coder-tickets.js',
      '../server/coder-ticket-intake.js',
    ];

    for (const mod of modules) {
      const imported = await import(mod);
      assert.ok(imported, `Module ${mod} should import`);
    }
  });
});

// ── Route registration smoke test ──

describe('Route registration smoke test', () => {
  it('setupFsOperationsRoutes should register 4 endpoints', async () => {
    const { setupFsOperationsRoutes } = await import('../server/routes/fs-operations.js');
    const { app, routes } = createMockApp();
    setupFsOperationsRoutes(app);

    const postRoutes = routes.filter(r => r.method === 'post');
    assert.equal(postRoutes.length, 4);
    assert.ok(postRoutes.some(r => r.path === '/protoclaw/select_empty_directory'));
    assert.ok(postRoutes.some(r => r.path === '/protoclaw/select_files'));
    assert.ok(postRoutes.some(r => r.path === '/protoclaw/select_directory'));
    assert.ok(postRoutes.some(r => r.path === '/protoclaw/validate_empty_directory'));
  });

  it('setupSystemFeatureConfigRoutes should register endpoints', async () => {
    const { setupSystemFeatureConfigRoutes } = await import('../server/routes/system-feature-config.js');
    const { app, routes } = createMockApp();
    const express = expressFactory();
    setupSystemFeatureConfigRoutes(app, express);
    assert.ok(routes.length > 0, 'Should register at least one route');
  });

  it('setupModelConfigRoutes should register endpoints', async () => {
    const { setupModelConfigRoutes } = await import('../server/routes/model-config.js');
    const { app, routes } = createMockApp();
    const express = expressFactory();
    setupModelConfigRoutes(app, express);
    assert.ok(routes.length > 0, 'Should register at least one route');
    assert.ok(
      routes.some(route => route.method === 'post' && route.path === '/protoclaw/opencode/models'),
      'Should register the OpenCode model catalogue route',
    );
    assert.ok(routes.some(route => route.method === 'get' && route.path === '/protoclaw/agent_process_mode'));
    assert.ok(routes.some(route => route.method === 'put' && route.path === '/protoclaw/agent_process_mode'));
  });

  it('setupFeatureRepositoryRoutes should register endpoints', async () => {
    const { setupFeatureRepositoryRoutes } = await import('../server/routes/feature-repository.js');
    const { app, routes } = createMockApp();
    const express = expressFactory();
    setupFeatureRepositoryRoutes(app, express);
    assert.ok(routes.length > 0, 'Should register at least one route');
  });

  it('setupFlowRoutes should register endpoints', async () => {
    const { setupFlowRoutes } = await import('../server/routes/flow.js');
    const { app, routes } = createMockApp();
    const express = expressFactory();
    setupFlowRoutes(app, express, {
      readWorkspaceState: async () => ({}),
      resolveAssemblyFeatureArchives: async () => ({}),
    });
    assert.ok(routes.length > 0, 'Should register at least one route');
  });

  it('setupUsageRoutes should register endpoints', async () => {
    const { setupUsageRoutes } = await import('../server/usage-ledger.js');
    const { app, routes } = createMockApp();
    const express = expressFactory();
    setupUsageRoutes(app, express);
    assert.ok(routes.length > 0, 'Should register at least one route');
  });

  it('setupOAuthCodexRoutes should register 5 endpoints', async () => {
    const { setupOAuthCodexRoutes } = await import('../server/routes/oauth-codex.js');
    const { app, routes } = createMockApp();
    const express = expressFactory();
    setupOAuthCodexRoutes(app, express);

    assert.ok(routes.length >= 5, `Expected >=5 routes, got ${routes.length}`);
    assert.ok(routes.some(r => r.method === 'post' && r.path === '/protoclaw/oauth/codex/start'));
    assert.ok(routes.some(r => r.method === 'get' && r.path === '/protoclaw/oauth/codex/status/:sessionId'));
    assert.ok(routes.some(r => r.method === 'get' && r.path === '/protoclaw/oauth/codex/tokens/:providerName'));
    assert.ok(routes.some(r => r.method === 'delete' && r.path === '/protoclaw/oauth/codex/tokens/:providerName'));
    assert.ok(routes.some(r => r.method === 'post' && r.path === '/protoclaw/oauth/codex/refresh/:providerName'));
    assert.ok(routes.some(r => r.method === 'get' && r.path === '/protoclaw/oauth/codex/defaults'));
  });

  it('setupProxyConfigRoutes should register config and connectivity endpoints', async () => {
    const { setupProxyConfigRoutes } = await import('../server/routes/proxy-config.js');
    const { app, routes } = createMockApp();
    const express = expressFactory();
    setupProxyConfigRoutes(app, express);

    assert.ok(routes.some(r => r.method === 'get' && r.path === '/protoclaw/proxy_config'));
    assert.ok(routes.some(r => r.method === 'put' && r.path === '/protoclaw/proxy_config'));
    assert.ok(routes.some(r => r.method === 'post' && r.path === '/protoclaw/proxy_test'));
  });

  it('setupToolStateRoutes should register tool_state endpoint', async () => {
    const { setupToolStateRoutes } = await import('../server/routes/tool-state.js');
    const { app, routes } = createMockApp();
    setupToolStateRoutes(app);
    assert.ok(routes.some(r => r.method === 'post' && r.path === '/protoclaw/agent/tool_state'));
  });
});

// ── Export contract smoke test ──

describe('Module export contracts', () => {
  it('claw-core.mjs should export expected functions', async () => {
    const mod = await import('../server/claw-core.mjs');
    const expected = ['loadProviders', 'listProviders', 'dispatch', 'cleanText'];
    for (const name of expected) {
      assert.equal(typeof mod[name], 'function', `claw-core should export ${name}`);
    }
  });

  it('call-arbiter.js should export CallArbiter class', async () => {
    const mod = await import('../server/call-arbiter.js');
    assert.equal(typeof mod.CallArbiter, 'function');
  });

  it('runtime-call-envelope.js should export expected functions', async () => {
    const mod = await import('../server/runtime-call-envelope.js');
    const expected = ['getRuntimeInboxSnapshot', 'getRuntimeExecutionState', 'findEnvelopeById'];
    for (const name of expected) {
      assert.equal(typeof mod[name], 'function', `runtime-call-envelope should export ${name}`);
    }
  });

  it('conversation-renderer.js should export expected functions', async () => {
    const mod = await import('../server/conversation-renderer.js');
    const expected = ['renderConversationHtml', 'escapeHtml', 'groupByTurn'];
    for (const name of expected) {
      assert.equal(typeof mod[name], 'function', `conversation-renderer should export ${name}`);
    }
  });
});
