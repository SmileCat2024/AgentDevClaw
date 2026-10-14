import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnBelongsTo } from '../server/routes/session.js';

test('turnBelongsTo: 整数轮取回包含分数插话锚点', () => {
  // 普通消息（整数 turn）
  assert.equal(turnBelongsTo(0, 0), true);
  assert.equal(turnBelongsTo(1, 0), false);
  // 插话锚点（N.5 / N.75 二分序列）归属其整数轮
  assert.equal(turnBelongsTo(0.5, 0), true);
  assert.equal(turnBelongsTo(0.75, 0), true);
  assert.equal(turnBelongsTo(1.5, 0), false);
  assert.equal(turnBelongsTo(1.5, 1), true);
  // 非法值不归属任何轮
  assert.equal(turnBelongsTo(undefined, 0), false);
  assert.equal(turnBelongsTo(null, 0), false);
  assert.equal(turnBelongsTo('0', 0), false);
  assert.equal(turnBelongsTo(NaN, 0), false);
});
