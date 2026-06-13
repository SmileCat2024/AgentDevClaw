/**
 * Tests for ToolRegistry superseded tracking
 *
 * Covers: same-name override pushes old entry to superseded list,
 * getEntries returns superseded entries with correct state,
 * remove() only removes the active entry, multi-level override chain.
 *
 * Uses the real ToolRegistry imported from agentdev dist.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from 'agentdev';

function makeTool(name, description = '') {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ result: 'ok' }),
  };
}

describe('ToolRegistry superseded tracking', () => {
  it('registers a single tool as enabled', () => {
    const tr = new ToolRegistry();
    tr.register(makeTool('foo', 'original'), 'feature-a');

    const entries = tr.getEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].tool.name, 'foo');
    assert.equal(entries[0].state, 'enabled');
    assert.equal(entries[0].enabled, true);
    assert.equal(entries[0].source, 'feature-a');
  });

  it('pushes old entry to superseded when same name is registered again', () => {
    const tr = new ToolRegistry();
    tr.register(makeTool('foo', 'original'), 'feature-a');
    tr.register(makeTool('foo', 'overridden'), 'feature-b');

    const entries = tr.getEntries();
    assert.equal(entries.length, 2);

    // Active entry is the second one
    const active = entries.find(e => e.state === 'enabled');
    assert.ok(active);
    assert.equal(active.tool.description, 'overridden');
    assert.equal(active.source, 'feature-b');

    // Superseded entry is the first one
    const superseded = entries.find(e => e.state === 'superseded');
    assert.ok(superseded);
    assert.equal(superseded.tool.description, 'original');
    assert.equal(superseded.source, 'feature-a');
    assert.equal(superseded.enabled, false);
  });

  it('preserves both superseded entries in a three-level override chain', () => {
    const tr = new ToolRegistry();
    tr.register(makeTool('foo', 'v1'), 'src-1');
    tr.register(makeTool('foo', 'v2'), 'src-2');
    tr.register(makeTool('foo', 'v3'), 'src-3');

    const entries = tr.getEntries();
    assert.equal(entries.length, 3);

    const active = entries.filter(e => e.state === 'enabled');
    assert.equal(active.length, 1);
    assert.equal(active[0].tool.description, 'v3');
    assert.equal(active[0].source, 'src-3');

    const superseded = entries.filter(e => e.state === 'superseded');
    assert.equal(superseded.length, 2);
    const descriptions = superseded.map(e => e.tool.description).sort();
    assert.deepEqual(descriptions, ['v1', 'v2']);
  });

  it('remove() only removes the active entry, superseded entries remain', () => {
    const tr = new ToolRegistry();
    tr.register(makeTool('foo', 'original'), 'src-a');
    tr.register(makeTool('foo', 'overridden'), 'src-b');

    // Remove the active 'foo'
    const removed = tr.remove('foo');
    assert.equal(removed, true);

    const entries = tr.getEntries();
    // Active entry becomes 'removed', superseded stays 'superseded'
    const activeRemoved = entries.find(e => e.source === 'src-b');
    assert.ok(activeRemoved);
    assert.equal(activeRemoved.state, 'removed');

    const superseded = entries.find(e => e.source === 'src-a');
    assert.ok(superseded);
    assert.equal(superseded.state, 'superseded');
  });

  it('does not create superseded entries for different tool names', () => {
    const tr = new ToolRegistry();
    tr.register(makeTool('alpha'), 'src-a');
    tr.register(makeTool('beta'), 'src-b');

    const entries = tr.getEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries.every(e => e.state === 'enabled'), true);
    assert.equal(entries.some(e => e.state === 'superseded'), false);
  });

  it('tracks superseded across multiple independent tool names', () => {
    const tr = new ToolRegistry();
    tr.register(makeTool('foo', 'foo-v1'), 'src-a');
    tr.register(makeTool('bar', 'bar-v1'), 'src-b');
    tr.register(makeTool('foo', 'foo-v2'), 'src-c');
    tr.register(makeTool('bar', 'bar-v2'), 'src-d');

    const entries = tr.getEntries();
    assert.equal(entries.length, 4);

    const fooEntries = entries.filter(e => e.tool.name === 'foo');
    assert.equal(fooEntries.length, 2);
    assert.equal(fooEntries.filter(e => e.state === 'enabled').length, 1);
    assert.equal(fooEntries.filter(e => e.state === 'superseded').length, 1);

    const barEntries = entries.filter(e => e.tool.name === 'bar');
    assert.equal(barEntries.length, 2);
    assert.equal(barEntries.filter(e => e.state === 'enabled').length, 1);
    assert.equal(barEntries.filter(e => e.state === 'superseded').length, 1);
  });
});
