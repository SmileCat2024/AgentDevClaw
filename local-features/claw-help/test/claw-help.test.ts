/**
 * claw-help 技能载具测试
 *
 * 验证两件事：
 * 1. feature 元数据契约（name / source / description）——source 是框架
 *    collectFeatureSkills 发现 skills/ 的唯一锚点，不能缺；
 * 2. 技能文档实体随构建落到 dist 的 source 同级（skills/agentdevclaw-help/
 *    下 SKILL.md 与 references/ 齐全）——拷贝由 copy-local-feature-skills.mjs
 *    完成，pretest 已先行构建，此处只验事实。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'url';
import { ClawHelpFeature } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

test('ClawHelpFeature 元数据满足技能发现契约', () => {
  const feature = new ClawHelpFeature();
  assert.equal(feature.name, 'claw-help');
  assert.equal(feature.description, 'AgentDevClaw 使用帮助技能载具（agentdevclaw-help）。');
  // source 必须是绝对路径（框架按 dirname(source)/skills 发现内置技能）
  assert.ok(feature.source && /^[a-zA-Z]:[\\/]/.test(feature.source), `source 应为绝对路径: ${feature.source}`);
});

test('agentdevclaw-help 技能文档随构建落到 source 同级', () => {
  const skillsRoot = join(__dirname, '..', 'src', 'skills', 'agentdevclaw-help');
  assert.ok(existsSync(join(skillsRoot, 'SKILL.md')), `缺少 SKILL.md: ${skillsRoot}`);

  const refsDir = join(skillsRoot, 'references');
  assert.ok(existsSync(refsDir), `缺少 references 目录: ${refsDir}`);
  const references = readdirSync(refsDir).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(references, [
    'concept-map.md',
    'contributing.md',
    'mcp.md',
    'models.md',
    'sessions-and-data.md',
    'skills.md',
    'troubleshooting.md',
    'ui-tour.md',
  ]);
});
