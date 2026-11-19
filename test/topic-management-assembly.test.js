import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataRoot = mkdtempSync(join(tmpdir(), 'claw-topic-assembly-'));
process.env.AGENTDEV_DATA_DIR = dataRoot;

const { default: ProgrammingHelperAgent } = await import('../prebuilt-agents/official/programming-helper/agent.js');

after(() => rmSync(dataRoot, { recursive: true, force: true }));

describe('programming-helper Topic feature assembly', () => {
  it('mounts topic-management with topic_list / topic_get / topic_update tools bound to the runtime HTTP identity', () => {
    const agent = new ProgrammingHelperAgent({
      workspaceDir: tmpdir(),
      runtime: {
        agentId: 'programming-helper',
        sessionId: 'topic-assembly-session',
        serverOrigin: 'http://topic-runtime.test',
      },
    });
    const feature = agent.getFeature('topic-management');
    assert.ok(feature, 'topic-management feature should be mounted');
    // topic_get：单主题结构化读取（主题引用的指针式注入后，模型按 reminder
    // 指引下钻成员对话明细的入口）。
    assert.deepEqual(feature.getTools().map(tool => tool.name), ['topic_list', 'topic_get', 'topic_update']);
    assert.equal(feature.serverOrigin, 'http://topic-runtime.test');
    assert.equal(feature.agentId, 'programming-helper');
  });
});
