/**
 * Tests for advclaw release update decisions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getUpdateState } from '../bin/advclaw-update.mjs';

const release = { tag_name: 'v0.1.9' };

describe('advclaw update decisions', () => {
  it('does not report an update when the current commit already includes the release', () => {
    assert.deepEqual(
      getUpdateState({ release, localVersion: '0.1.7', relation: 'release-included' }),
      { hasUpdate: false, state: 'release-included' },
    );
  });

  it('reports an update when the release is ahead of the current commit', () => {
    assert.deepEqual(
      getUpdateState({ release, localVersion: '0.1.7', relation: 'release-ahead' }),
      { hasUpdate: true, state: 'release-ahead' },
    );
  });

  it('does not offer a destructive checkout for a branch that diverged from the release', () => {
    assert.deepEqual(
      getUpdateState({ release, localVersion: '0.1.7', relation: 'diverged' }),
      { hasUpdate: false, state: 'diverged' },
    );
  });

  it('falls back to semantic versions when Git history is unavailable', () => {
    assert.deepEqual(
      getUpdateState({ release, localVersion: '0.1.7' }),
      { hasUpdate: true, state: 'version-fallback' },
    );
  });

  it('does not treat an older semantic version as an update when Git history is unavailable', () => {
    assert.deepEqual(
      getUpdateState({ release, localVersion: '0.2.0' }),
      { hasUpdate: false, state: 'version-fallback' },
    );
  });
});
