import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clawRoot = path.resolve(__dirname, '..');

// 权威来源：AgentDev 框架仓库（可被 AGENTDEV_LOCAL_PATH 覆盖）
const agentDevRoot = process.env.AGENTDEV_LOCAL_PATH
  ? path.resolve(process.env.AGENTDEV_LOCAL_PATH)
  : path.resolve(clawRoot, '..', 'AgentDev');

// 分发单位是 feature：指南随 agent-studio feature 的 skills 目录打包，
// 经 copy-local-feature-skills.mjs 复制进 dist 后由框架 collectFeatureSkills 注入。
const TARGET_ROOT = path.join(clawRoot, 'local-features', 'agent-studio', 'skills');

// 框架仓库维护的指南（权威源随框架演进）
const FRAMEWORK_SKILLS = ['agentdev-feature-guide', 'agentdev-feature-packaging'];
// Claw 本地维护、但服务于全部开发场景的指南（源码在 local-features/agent-dev/skills）
const LOCAL_SKILLS = ['agentdev-agent-assembly'];

function copySkill(sourceRoot, skillName) {
  const src = path.join(sourceRoot, skillName);
  if (!existsSync(src) || !statSync(src).isDirectory()) {
    console.warn(`[sync-adv-docs] source missing, skipped: ${src}`);
    return false;
  }
  const dest = path.join(TARGET_ROOT, skillName);
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true, dereference: true, force: true });
  console.log(`[sync-adv-docs] ${src} -> ${dest}`);
  return true;
}

if (!existsSync(TARGET_ROOT)) {
  console.warn(`[sync-adv-docs] target root not found: ${TARGET_ROOT}`);
  process.exit(1);
}

// 防误删：确认目标目录里当前有哪些顶层技能（只覆盖同步清单，不触碰其他）
const existing = readdirSync(TARGET_ROOT);
console.log(`[sync-adv-docs] target has ${existing.length} skill(s): ${existing.join(', ')}`);

let copied = 0;
for (const skillName of FRAMEWORK_SKILLS) {
  if (copySkill(path.join(agentDevRoot, '.agentdev', 'skills'), skillName)) copied++;
}
for (const skillName of LOCAL_SKILLS) {
  if (copySkill(path.join(clawRoot, 'local-features', 'agent-dev', 'skills'), skillName)) copied++;
}

console.log(`[sync-adv-docs] synced ${copied} skill(s) from agentDevRoot=${agentDevRoot}`);
