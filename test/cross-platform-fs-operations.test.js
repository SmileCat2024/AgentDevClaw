/**
 * Tests for cross-platform file picker behavior in fs-operations.js
 *
 * On Windows: native PowerShell-based file picker works.
 * On non-Windows: routes return { useWebPicker: true, mode } so the
 *   frontend can show a web-based picker.
 *
 * IMPORTANT: We must NOT actually invoke the select_* route handlers on
 * Windows, because that would launch a real PowerShell file-picker dialog
 * and block the test. Instead we verify route registration and the
 * validate_empty_directory endpoint (which does not launch any dialog).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupFsOperationsRoutes } from '../server/routes/fs-operations.js';

/**
 * Create a minimal Express app with fs-operations routes for testing.
 */
function createTestApp() {
  const app = express();
  app.use(express.json());
  setupFsOperationsRoutes(app);
  return app;
}

/**
 * Send a POST request to the test server and return the response.
 */
function postJson(app, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            server.close();
            try {
              resolve({ status: res.statusCode, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode, body: data });
            }
          });
        },
      );
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

describe('File picker cross-platform behavior', () => {
  it('should register all expected routes', () => {
    const handlers = {};
    const app = {
      post(path, ...middleware) {
        handlers[path] = middleware[middleware.length - 1];
      },
    };
    setupFsOperationsRoutes(app);
    assert.ok(handlers['/protoclaw/select_empty_directory']);
    assert.ok(handlers['/protoclaw/select_files']);
    assert.ok(handlers['/protoclaw/select_directory']);
    assert.ok(handlers['/protoclaw/validate_empty_directory']);
  });

  // NOTE: select_empty_directory / select_files / select_directory are not
  // tested via HTTP on Windows because they launch a native PowerShell dialog.
  // On non-Windows they return { useWebPicker: true } instantly with no side
  // effects, so it would be safe there — but we keep the test platform-agnostic.

  it('validate_empty_directory rejects non-existent path', async () => {
    const app = createTestApp();
    const result = await postJson(app, '/protoclaw/validate_empty_directory', {
      path: '/nonexistent/path/that/does/not/exist',
    });
    assert.strictEqual(result.status, 400);
  });

  it('validate_empty_directory rejects missing path body', async () => {
    const app = createTestApp();
    const result = await postJson(app, '/protoclaw/validate_empty_directory', {});
    assert.strictEqual(result.status, 400);
  });

  it('validate_empty_directory accepts empty directory', async () => {
    const app = createTestApp();
    const emptyDir = mkdtempSync(join(tmpdir(), 'picker-valid-'));
    try {
      const result = await postJson(app, '/protoclaw/validate_empty_directory', {
        path: emptyDir,
      });
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.valid, true);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('validate_empty_directory rejects non-empty directory', async () => {
    const app = createTestApp();
    const dir = mkdtempSync(join(tmpdir(), 'picker-nonempty-'));
    try {
      writeFileSync(join(dir, 'file.txt'), 'content');
      const result = await postJson(app, '/protoclaw/validate_empty_directory', {
        path: dir,
      });
      assert.strictEqual(result.status, 400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
