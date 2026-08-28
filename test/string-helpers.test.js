import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { containsReplacementChar } from '../server/shared/string-helpers.js';

describe('containsReplacementChar', () => {
  it('detects U+FFFD produced by wrong-codepage transcoding', () => {
    assert.equal(containsReplacementChar('标题\uFFFD残留'), true);
    assert.equal(containsReplacementChar('\uFFFD'), true);
  });

  it('accepts normal CJK / ASCII / whitespace text', () => {
    assert.equal(containsReplacementChar('审核 Phase1.5 虚拟身份投影'), false);
    assert.equal(containsReplacementChar('plain ascii 123'), false);
    assert.equal(containsReplacementChar('  trailing  '), false);
  });

  it('rejects non-string input', () => {
    assert.equal(containsReplacementChar(undefined), false);
    assert.equal(containsReplacementChar(null), false);
    assert.equal(containsReplacementChar(42), false);
  });
});
