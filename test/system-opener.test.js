import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  openDirectoryInSystem,
  resolveDirectoryOpener,
} from '../server/shared/system-opener.js';

function createChild(event, error) {
  const child = new EventEmitter();
  child.unrefCalled = false;
  child.unref = () => {
    child.unrefCalled = true;
  };
  queueMicrotask(() => child.emit(event, error));
  return child;
}

describe('system directory opener', () => {
  it('skips opening on a headless Linux host', async () => {
    let spawnCalled = false;
    const result = await openDirectoryInSystem('/srv/project', {
      platform: 'linux',
      env: {},
      spawnImpl: () => {
        spawnCalled = true;
      },
    });

    assert.deepStrictEqual(result, {
      opened: false,
      reason: 'desktop_unavailable',
    });
    assert.strictEqual(spawnCalled, false);
  });

  it('handles a missing xdg-open command without an unhandled error', async () => {
    const missingCommand = Object.assign(new Error('spawn xdg-open ENOENT'), {
      code: 'ENOENT',
    });
    const result = await openDirectoryInSystem('/srv/project', {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      spawnImpl: () => createChild('error', missingCommand),
    });

    assert.deepStrictEqual(result, {
      opened: false,
      reason: 'opener_not_found',
    });
  });

  it('handles a synchronous spawn failure', async () => {
    const result = await openDirectoryInSystem('/srv/project', {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      spawnImpl: () => {
        throw Object.assign(new Error('spawn failed'), { code: 'EACCES' });
      },
    });

    assert.deepStrictEqual(result, {
      opened: false,
      reason: 'opener_failed',
    });
  });

  it('detaches a successfully spawned opener', async () => {
    const child = createChild('spawn');
    const calls = [];
    const result = await openDirectoryInSystem('/srv/project', {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      spawnImpl: (...args) => {
        calls.push(args);
        return child;
      },
    });

    assert.deepStrictEqual(result, { opened: true });
    assert.strictEqual(child.unrefCalled, true);
    assert.strictEqual(calls[0][0], 'xdg-open');
    assert.deepStrictEqual(calls[0][1], ['/srv/project']);
    assert.deepStrictEqual(calls[0][2], {
      stdio: 'ignore',
      detached: true,
    });
  });

  it('selects the native command on Windows and macOS', () => {
    assert.deepStrictEqual(
      resolveDirectoryOpener('C:\\work', {
        platform: 'win32',
        env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      }),
      {
        available: true,
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/c', 'start', '""', 'C:\\work'],
      },
    );
    assert.deepStrictEqual(
      resolveDirectoryOpener('/work', { platform: 'darwin', env: {} }),
      { available: true, command: 'open', args: ['/work'] },
    );
  });
});
