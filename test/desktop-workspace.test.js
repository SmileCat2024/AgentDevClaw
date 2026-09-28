import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDesktopWorkspace } from '../server/shared/desktop-workspace.js';

const home = '/home/alice';
const stat = () => ({ isDirectory: () => true });

describe('non-project agent workspace', () => {
  it('uses the Windows known folder rather than assuming Desktop lives under the home directory', () => {
    const result = resolveDesktopWorkspace({
      platform: 'win32', home: 'C:\\Users\\Alice', stat,
      run: () => ({ status: 0, stdout: 'D:\\OneDrive\\Desktop\r\n' }),
    });
    assert.equal(result, 'D:\\OneDrive\\Desktop');
  });

  it('uses the configured, localized XDG desktop folder', () => {
    const result = resolveDesktopWorkspace({
      platform: 'linux', home, env: {}, stat,
      read: () => '# user dirs\nXDG_DESKTOP_DIR="$HOME/Schreibtisch"\n',
    });
    assert.equal(result, '/home/alice/Schreibtisch');
  });

  it('uses the home directory when the desktop path is not a directory', () => {
    assert.equal(resolveDesktopWorkspace({ platform: 'linux', home, env: {},
      stat: () => ({ isDirectory: () => false }), read: () => 'XDG_DESKTOP_DIR="$HOME/Desktop"' }), home);
  });

  it('falls back to the home directory when there is no desktop', () => {
    assert.equal(resolveDesktopWorkspace({ platform: 'linux', home, env: {}, stat: () => { throw new Error('ENOENT'); }, read: () => '' }), home);
    assert.equal(resolveDesktopWorkspace({ platform: 'darwin', home: '/Users/alice', stat: () => { throw new Error('ENOENT'); } }), '/Users/alice');
    assert.equal(resolveDesktopWorkspace({ platform: 'win32', home: 'C:\\Users\\Alice', stat: () => { throw new Error('ENOENT'); },
      run: () => ({ status: 0, stdout: 'C:\\Users\\Alice\\Desktop' }) }), 'C:\\Users\\Alice');
  });
});
