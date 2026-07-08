/**
 * Tests for server/routes/fs-operations.js
 *
 * Covers: runCommand (cross-platform execution + quoting),
 * validateEmptyDirectory (via Express route).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runCommand, setupFsOperationsRoutes } from '../server/routes/fs-operations.js';

// ── runCommand ──

describe('runCommand', () => {
  // On Windows, runCommand routes through cmd.exe which adds its own quoting layer.
  // We use temp script files instead of -e to avoid quoting issues.
  function makeScript(dir, name, code) {
    const script = join(dir, name);
    writeFileSync(script, code);
    return script;
  }

  it('should capture stdout from a successful command', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rc-out-'));
    try {
      const script = makeScript(d, 'out.js', 'process.stdout.write("hello")');
      const { stdout } = await runCommand('node', [script]);
      assert.equal(stdout, 'hello');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('should capture stderr without failing when exit code is 0', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rc-err-'));
    try {
      const script = makeScript(d, 'err.js', 'process.stderr.write("warn");process.stdout.write("ok")');
      const { stdout, stderr } = await runCommand('node', [script]);
      assert.equal(stdout, 'ok');
      assert.ok(stderr.includes('warn'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('should reject on non-zero exit code', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rc-exit-'));
    try {
      const script = makeScript(d, 'exit.js', 'process.exit(1)');
      await assert.rejects(() => runCommand('node', [script]));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('should include stderr in error message on failure', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rc-fail-'));
    try {
      const script = makeScript(d, 'fail.js', 'process.stderr.write("custom-error-msg");process.exit(1)');
      await assert.rejects(
        () => runCommand('node', [script]),
        (err) => {
          assert.ok(err.message.includes('custom-error-msg'));
          return true;
        },
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('should respect cwd option', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rc-cwd-'));
    try {
      const script = makeScript(d, 'cwd.js', 'process.stdout.write(process.cwd())');
      const { stdout } = await runCommand('node', [script], { cwd: d });
      assert.equal(stdout.replace(/\\/g, '/'), d.replace(/\\/g, '/'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── validateEmptyDirectory (via route handler) ──

describe('setupFsOperationsRoutes', () => {
  function createMockApp() {
    const handlers = {};
    const app = {
      post(path, ...middleware) {
        // Extract the actual handler (last function in the chain)
        const handler = middleware[middleware.length - 1];
        handlers[path] = { middleware, handler };
      },
    };
    return { app, handlers };
  }

  function mockRes() {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { res.statusCode = code; return res; },
      json(data) { res.body = data; return res; },
    };
    return res;
  }

  it('should register all expected routes', () => {
    const { app, handlers } = createMockApp();
    setupFsOperationsRoutes(app);
    assert.ok(handlers['/protoclaw/select_empty_directory']);
    assert.ok(handlers['/protoclaw/select_files']);
    assert.ok(handlers['/protoclaw/select_directory']);
    assert.ok(handlers['/protoclaw/validate_empty_directory']);
  });

  it('validate_empty_directory should reject missing path', async () => {
    const { app, handlers } = createMockApp();
    setupFsOperationsRoutes(app);

    const req = { body: { path: '' } };
    const res = mockRes();
    // The route has express.json() middleware; call the actual handler
    const { handler } = handlers['/protoclaw/validate_empty_directory'];
    await handler(req, res, () => {});
    assert.equal(res.statusCode, 400);
  });

  it('validate_empty_directory should reject non-existent path', async () => {
    const { app, handlers } = createMockApp();
    setupFsOperationsRoutes(app);

    const req = { body: { path: join(tmpdir(), 'nonexistent-dir-12345') } };
    const res = mockRes();
    const { handler } = handlers['/protoclaw/validate_empty_directory'];
    // Simulate next() for error middleware
    let nextErr = null;
    await handler(req, res, (err) => { nextErr = err; });
    assert.ok(nextErr);
    assert.equal(nextErr.statusCode, 400);
  });

  it('validate_empty_directory should accept empty directory', async () => {
    const { app, handlers } = createMockApp();
    setupFsOperationsRoutes(app);

    const emptyDir = mkdtempSync(join(tmpdir(), 'empty-valid-'));
    try {
      const req = { body: { path: emptyDir } };
      const res = mockRes();
      const { handler } = handlers['/protoclaw/validate_empty_directory'];
      await handler(req, res, () => {});
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.valid, true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('validate_empty_directory should reject non-empty directory', async () => {
    const { app, handlers } = createMockApp();
    setupFsOperationsRoutes(app);

    const nonEmptyDir = mkdtempSync(join(tmpdir(), 'nonempty-valid-'));
    try {
      writeFileSync(join(nonEmptyDir, 'file.txt'), 'content');
      const req = { body: { path: nonEmptyDir } };
      const res = mockRes();
      const { handler } = handlers['/protoclaw/validate_empty_directory'];
      let nextErr = null;
      await handler(req, res, (err) => { nextErr = err; });
      assert.ok(nextErr);
      assert.equal(nextErr.statusCode, 400);
    } finally {
      rmSync(nonEmptyDir, { recursive: true, force: true });
    }
  });
});
