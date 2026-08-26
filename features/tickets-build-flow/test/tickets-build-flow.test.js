import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TicketsBuildFlow } from '../dist/index.js';

function getTool() {
  const feature = new TicketsBuildFlow();
  const tools = feature.getTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'tickets_flow_skill');
  return tools[0];
}

describe('TicketsBuildFlow', () => {
  it('exposes exactly one read-only tool', () => {
    const tool = getTool();
    assert.equal(tool.name, 'tickets_flow_skill');
    assert.equal(tool.parallelizable, true);
    // enum 收口三个规范
    assert.deepEqual(tool.parameters.properties.skill.enum, ['implement', 'tdd', 'code-review']);
  });

  it('lists the three bundled skills without arguments', async () => {
    const result = await getTool().execute({});

    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
    assert.deepEqual(
      result.skills.map((s) => s.name),
      ['implement', 'tdd', 'code-review'],
    );
    // 每个规范都必须带适用场景描述
    for (const skill of result.skills) {
      assert.ok(skill.description.length > 10, `${skill.name} 缺少描述`);
    }
  });

  it('returns the full SKILL.md for a known skill', async () => {
    for (const name of ['implement', 'tdd', 'code-review']) {
      const result = await getTool().execute({ skill: name });

      assert.equal(result.ok, true, name);
      assert.equal(result.skill, name);
      // 全文必须含合法 frontmatter（name + description），与 SkillFeature 发现约定一致
      assert.match(result.content, /^---\nname: /);
      assert.match(result.content, new RegExp(`^name: ${name}$`, 'm'));
    }
  });

  it('rejects unknown skills with the available list', async () => {
    const result = await getTool().execute({ skill: 'nope' });

    assert.equal(result.ok, false);
    assert.match(result.error, /implement, tdd, code-review/);
  });

  it('declares source so hosts can discover dist/skills', () => {
    const feature = new TicketsBuildFlow();

    assert.equal(feature.name, 'tickets-build-flow');
    assert.ok(feature.source.includes('dist'), 'source 应指向构建产物入口');
    const info = feature.getPackageInfo();
    assert.equal(info.name, '@agentdevjs/tickets-build-flow');
  });
});
