/**
 * Tests for session-token-refresh module extraction.
 *
 * TDD: written BEFORE the module is created to specify expected behavior.
 *
 * Covers:
 * 1. transformMessagesForTokenCount — pure message transformation logic
 * 2. setupTokenRefreshRoute — route registration
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  transformMessagesForTokenCount,
  setupTokenRefreshRoute,
} from '../server/routes/session-token-refresh.js';

// ─── Mock helpers ──────────────────────────────────────────────────

function makeMockApp() {
  const routes = [];
  const app = {
    get: (p, ...h) => routes.push(`GET ${p}`),
    post: (p, ...h) => routes.push(`POST ${p}`),
    put: (p, ...h) => routes.push(`PUT ${p}`),
    delete: (p, ...h) => routes.push(`DELETE ${p}`),
  };
  app._routes = routes;
  return app;
}

// ─── 1. transformMessagesForTokenCount ─────────────────────────────

describe('transformMessagesForTokenCount', () => {
  it('should pass through simple user and assistant messages unchanged', () => {
    const input = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.deepEqual(result, [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ]);
  });

  it('should prepend system content to the first user message', () => {
    const input = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'What is 2+2?' },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'You are helpful.\n\nWhat is 2+2?');
  });

  it('should accumulate multiple system messages before the first user', () => {
    const input = [
      { role: 'system', content: 'Rule 1.' },
      { role: 'system', content: 'Rule 2.' },
      { role: 'user', content: 'Go' },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Rule 1.\n\nRule 2.\n\nGo');
  });

  it('should change tool role to user', () => {
    const input = [
      { role: 'user', content: 'Run it' },
      { role: 'assistant', content: 'Calling tool' },
      { role: 'tool', content: 'Tool output here' },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result[2].role, 'user');
    assert.equal(result[2].content, 'Tool output here');
  });

  it('should prepend system to tool messages (tool becomes user first)', () => {
    const input = [
      { role: 'system', content: 'System prompt' },
      { role: 'tool', content: 'Tool result' },
    ];
    const result = transformMessagesForTokenCount(input);
    // tool → role changes to 'user' → then system prepend triggers
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'System prompt\n\nTool result');
  });

  it('should flatten array content blocks using .text', () => {
    const input = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' },
        ],
      },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result[0].content, 'First part\nSecond part');
  });

  it('should JSON.stringify non-string content blocks without .text', () => {
    const input = [
      {
        role: 'user',
        content: [
          { type: 'image', data: 'base64...' },
        ],
      },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result[0].content, JSON.stringify({ type: 'image', data: 'base64...' }));
  });

  it('should JSON.stringify object content', () => {
    const input = [
      { role: 'assistant', content: { nested: 'value' } },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result[0].content, JSON.stringify({ nested: 'value' }));
  });

  it('should JSON.stringify system content that is not a string', () => {
    const input = [
      { role: 'system', content: { rules: ['a', 'b'] } },
      { role: 'user', content: 'Go' },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result[0].content, JSON.stringify({ rules: ['a', 'b'] }) + '\n\nGo');
  });

  it('should create synthetic user message when only system messages exist', () => {
    const input = [
      { role: 'system', content: 'Only system here' },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.equal(result[0].content, 'Only system here');
  });

  it('should return empty array for empty input', () => {
    assert.deepEqual(transformMessagesForTokenCount([]), []);
  });

  it('should skip messages with null content', () => {
    const input = [
      { role: 'user', content: null },
      { role: 'assistant', content: 'Valid' },
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'Valid');
  });

  it('should skip null/undefined message entries', () => {
    const input = [
      null,
      { role: 'user', content: 'Hi' },
      undefined,
    ];
    const result = transformMessagesForTokenCount(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'Hi');
  });

  it('should accumulate new system messages between user turns', () => {
    const input = [
      { role: 'system', content: 'Sys1' },
      { role: 'user', content: 'First' },
      { role: 'system', content: 'Sys2' },
      { role: 'user', content: 'Second' },
    ];
    const result = transformMessagesForTokenCount(input);
    // Trace: Sys1 accumulated → First gets 'Sys1\n\nFirst' (systemParts cleared)
    //         Sys2 accumulated → Second gets 'Sys2\n\nSecond'
    assert.equal(result.length, 2);
    assert.deepEqual(result, [
      { role: 'user', content: 'Sys1\n\nFirst' },
      { role: 'user', content: 'Sys2\n\nSecond' },
    ]);
  });
});

// ─── 2. setupTokenRefreshRoute ─────────────────────────────────────

describe('setupTokenRefreshRoute', () => {
  it('should register exactly one POST route', () => {
    const app = makeMockApp();
    setupTokenRefreshRoute(app, { json: () => (req, res, next) => next() });
    assert.equal(app._routes.length, 1);
    assert.ok(app._routes.includes('POST /protoclaw/refresh_session_token_count'));
  });

  it('should be a function', () => {
    assert.equal(typeof setupTokenRefreshRoute, 'function');
  });
});
