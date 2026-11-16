import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

const MODULE_PATH = 'public/src/modules/session-view-identity-state.js';
async function loadIdentityOwner(ctx) {
  const previousWindow = globalThis.window;
  globalThis.window = ctx;
  try {
    return await loadModuleOnce(MODULE_PATH, { installGlobals: false });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

function loadSessionViewHarness() {
  const ctx = createFrontendSandbox();
  ctx.loadSource('public/src/modules/session-view-state.js');
  ctx.run("currentRuntimeAgentId = 'runtime-a'; focusedAgentId = 'agent-a';");
  return ctx;
}

test('identity owner absorbs classic state and keeps real session-view patches and token guards live', async () => {
  const ctx = loadSessionViewHarness();
  const initialMessages = [{ role: 'user', content: 'before claim' }];
  ctx.initialMessages = initialMessages;
  ctx.run("applySessionViewPatch({ identity: { agentId: 'agent-a', sessionId: 'session-a' } });");
  ctx.run('applySessionViewPatch({ messages: initialMessages });');
  const preClaimMeta = ctx.run('_sessionMeta');
  const preClaimIdentity = ctx.run('_sessionViewIdentity');
  const preClaimGeneration = ctx.run('_sessionViewGeneration');
  const { module, cleanup } = await loadIdentityOwner(ctx);

  try {
    assert.strictEqual(module._sessionMeta, preClaimMeta);
    assert.strictEqual(module._sessionViewIdentity, preClaimIdentity);
    assert.equal(module._sessionViewGeneration, preClaimGeneration);
    assert.strictEqual(ctx._sessionMeta, preClaimMeta);
    assert.strictEqual(ctx._sessionViewIdentity, preClaimIdentity);

    const firstToken = ctx.run('captureSessionViewToken()');
    ctx.firstToken = firstToken;
    ctx.run("applySessionViewPatch({ identity: { agentId: 'agent-a', sessionId: 'session-b' } });");
    ctx.run("applySessionViewPatch({ identity: { agentId: 'agent-a', sessionId: 'session-a' } });");
    assert.equal(ctx.run('isSessionViewTokenCurrent(firstToken)'), false, 'A→B→A invalidates the original token even on the same runtime');
    const revisitedMessages = ctx.currentMessages;
    assert.equal(revisitedMessages.length, 0, 'changing Session identity clears its transcript');
    assert.equal(ctx.run("commitSessionViewPatch(firstToken, { messages: [{ content: 'stale revisit' }] })"), false);
    assert.strictEqual(ctx.currentMessages, revisitedMessages, 'a stale response cannot overwrite the cleared revisit view');

    const currentToken = ctx.run('captureSessionViewToken()');
    ctx.currentToken = currentToken;
    const updatedMessages = [{ role: 'assistant', content: 'current message observation' }];
    ctx.updatedMessages = updatedMessages;
    ctx.run('applySessionViewPatch({ messages: updatedMessages });');
    assert.equal(module._sessionViewMessagesRevision, currentToken.messagesRevision + 1);
    assert.equal(ctx.run('isSessionViewMessagesCurrent(currentToken)'), false, 'message revision detects an old snapshot independently');

    const requestToken = ctx.run('captureSessionViewToken()');
    ctx.requestToken = requestToken;
    const latestRequests = [{ id: 'latest' }];
    ctx.latestRequests = latestRequests;
    ctx.run('applySessionViewPatch({ inputRequests: latestRequests });');
    assert.equal(module._sessionViewInputRequestsRevision, requestToken.inputRequestsRevision + 1);
    assert.equal(ctx.run('isSessionViewInputRequestsCurrent(requestToken)'), false, 'input revision detects an old response independently');

    const committed = ctx.run("commitSessionViewPatch(requestToken, { messages: [{ content: 'accepted message' }], inputRequests: [{ id: 'stale' }] })");
    assert.equal(committed, true, 'a still-current identity token may commit non-input fields');
    assert.equal(ctx.currentMessages[0].content, 'accepted message');
    assert.strictEqual(ctx.currentInputRequests, latestRequests, 'the old input snapshot is dropped without discarding other fields');
    assert.strictEqual(ctx._sessionViewInputRequestsRevision, module._sessionViewInputRequestsRevision);
  } finally {
    cleanup();
  }
});

test('identity owner setter updates the claimed binding and classic accessor reads the same value', async () => {
  const ctx = loadSessionViewHarness();
  const { module, cleanup } = await loadIdentityOwner(ctx);
  try {
    module.setSessionViewGeneration(42);
    module.setSessionViewModelRuntimeId('runtime-z');
    assert.equal(module._sessionViewGeneration, 42);
    assert.equal(module._sessionViewModelRuntimeId, 'runtime-z');
    assert.equal(ctx._sessionViewGeneration, 42);
    assert.equal(ctx._sessionViewModelRuntimeId, 'runtime-z');
  } finally {
    cleanup();
  }
});
