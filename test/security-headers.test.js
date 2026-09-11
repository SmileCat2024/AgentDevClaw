import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { securityHeadersMiddleware, CONTENT_SECURITY_POLICY } from '../server/shared/security-headers.js';

function runMiddleware() {
  const headers = {};
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  let nextCalled = false;
  securityHeadersMiddleware({}, res, () => {
    nextCalled = true;
  });
  return { headers, nextCalled };
}

describe('security headers middleware', () => {
  it('sets anti-sniffing, clickjacking and referrer headers then continues', () => {
    const { headers, nextCalled } = runMiddleware();
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.equal(headers['Referrer-Policy'], 'no-referrer');
    assert.ok(headers['Permissions-Policy'].includes('microphone=(self)'));
    assert.equal(headers['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
    assert.ok(nextCalled);
  });

  it('locks down CSP sinks while allowing the static CDNs', () => {
    const { headers } = runMiddleware();
    const csp = headers['Content-Security-Policy'];
    assert.ok(csp.startsWith("default-src 'self'"));
    assert.ok(csp.includes('https://cdn.jsdelivr.net'));
    assert.ok(csp.includes('https://cdnjs.cloudflare.com'));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("connect-src 'self'"));
    // 防误收紧回归：blob Worker（desktop-notify）与聊天外链图片
    assert.ok(csp.includes("worker-src 'self' blob:"));
    assert.ok(/img-src [^;]*https:/.test(csp));
    assert.ok(!csp.includes('unsafe-eval'));
  });
});
