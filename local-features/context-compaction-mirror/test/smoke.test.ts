/**
 * ContextCompactionMirrorFeature smoke test (node:test format)
 *
 * Validates that the feature disables all tools on the first call
 * and does not touch them on subsequent calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCompactionMirrorFeature } from '../src/index.js';

describe('ContextCompactionMirrorFeature', () => {

  it('should disable all tools on first call', async () => {
    const disabled: string[] = [];
    const feature = new ContextCompactionMirrorFeature();

    await feature.onInitiate({
      logger: { info() {} },
    } as any);

    await feature.disableAllToolsOnFirstCall({
      isFirstCall: true,
      agent: {
        getTools() {
          return {
            getEntries() {
              return [
                { tool: { name: 'read_file' } },
                { tool: { name: 'shell_exec' } },
              ];
            },
            disable(name: string) {
              disabled.push(name);
              return true;
            },
          };
        },
      },
    } as any);

    assert.equal(disabled.length, 2);
    assert.ok(disabled.includes('read_file'));
    assert.ok(disabled.includes('shell_exec'));
  });

  it('should NOT disable tools on subsequent calls', async () => {
    const disabled: string[] = [];
    const feature = new ContextCompactionMirrorFeature();

    await feature.onInitiate({
      logger: { info() {} },
    } as any);

    await feature.disableAllToolsOnFirstCall({
      isFirstCall: false,
      agent: {
        getTools() {
          return {
            getEntries() {
              return [{ tool: { name: 'late_tool' } }];
            },
            disable(name: string) {
              disabled.push(name);
              return true;
            },
          };
        },
      },
    } as any);

    assert.equal(disabled.length, 0);
  });
});
