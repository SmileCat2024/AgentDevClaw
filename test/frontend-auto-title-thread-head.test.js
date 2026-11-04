/**
 * `titleCandidateState` 的三态判定（ADR-0041 第 1 步）。
 *
 * 这个判定曾是壳层自动标题的候选入口，现已随壳层触发一起硬屏蔽
 * （见 frontend-auto-title-legacy-disabled.test.js），但**判定本身仍是
 * 正确语义的记录**：它区分了「占位待起名」「已有标题或来源未知」「快照暂缺
 * 记录」三种情况，其中第三种必须延后判定而不是判否——否则新建会话会因为
 * 一次索引投影延迟永久失去标题。
 *
 * 未来若在任何地方重新引入标题候选逻辑（应用侧的 Feature 或服务端），
 * 这三种情况的区分仍然适用，因此单独守住它，而不是随壳层一起丢弃。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const autoTitleSource = fs.readFileSync(
  new URL('../public/src/modules/auto-title.js', import.meta.url),
  'utf8',
);

const sandbox = {
  Set,
  Map,
  String,
  Array,
  JSON,
  Math,
  Date,
  window: {},
};
vm.createContext(sandbox);
vm.runInContext(autoTitleSource, sandbox);

const titleCandidateState = vm.runInContext('titleCandidateState', sandbox);

test('placeholder sessions are title candidates', () => {
  assert.equal(titleCandidateState(true, 'placeholder'), 'candidate');
});

test('sessions that already have a title are settled', () => {
  // auto = 系统生成过，user = 用户改过名：两种都不该再自动起名。
  assert.equal(titleCandidateState(true, 'auto'), 'settled');
  assert.equal(titleCandidateState(true, 'user'), 'settled');
});

test('a record with an unknown titleState is settled, not a candidate', () => {
  // 改造前的历史记录没有 titleState。来源无法判定时不猜文案，直接不起名。
  assert.equal(titleCandidateState(true, ''), 'settled');
  assert.equal(titleCandidateState(true, undefined), 'settled');
});

test('a missing session record stays undecided so the next round can retry', () => {
  // 快照暂缺索引投影是观测时机问题，不代表会话没有状态。
  // 此时判否会让新会话永久拿不到标题。
  assert.equal(titleCandidateState(false, ''), 'unknown');
  assert.equal(titleCandidateState(false, 'placeholder'), 'unknown');
});
