/**
 * feature-registry.js — Feature Registry 种子数据加载与校验（P1）
 *
 * 设计见 docs/adr/0017-feature-manifest-and-registry.md 与
 * docs/plans/2026-09-13-feature-registry-p1-panel-visibility.md。
 *
 * P1：seed 是手维护快照（join key = 运行时 AgentFeature.name），
 * P3 升级为从装配代码与目录扫描自动生成的 Registry 投影，
 * /api/feature-catalog 响应 schema 保持不变。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SEED_PATH = path.join(__dirname, 'feature-registry-seed.json');
export const FEATURE_REGISTRY_SEED_PATH = SEED_PATH;

/**
 * 能力标签词表（ADR 0017 决策 2，实现形态轴）。
 * 能力是多值属性：一个 feature 可同时提供多种能力（工具 + 钩子 + 命令…），
 * 因此标签不作为面板主分组轴——主分组轴是 provenance（来源，单值正交）。
 * 词表权威只在 server 一处，随 API 响应携带，前端零硬编码。
 * 数组顺序即详情弹窗的能力标签展示顺序。
 */
export const FEATURE_CAPABILITIES = [
  { id: 'tools' },
  { id: 'policy' },
  { id: 'commands' },
  { id: 'skills' },
  { id: 'gateway' },
  { id: 'mcp' },
  { id: 'protocol' },
];

export const FEATURE_PROVENANCES = ['ecosystem', 'local', 'builtin', 'inline', 'packaged'];

/**
 * 展示分组（用户视角）。provenance 是数据层概念（仓库边界，开发者视角，
 * 供 Registry 管理与弹窗细粒度来源展示）；面板分组的粒度以用户为准：
 * 官方内置（随软件发行的一切）vs 已安装（用户经 tgz 仓库装入的）。
 * 映射权威在 server，前端只消费响应中的 group 字段。
 */
export const FEATURE_DISPLAY_GROUPS = [
  { id: 'installed', provenances: ['packaged'] },
  { id: 'bundled', provenances: ['ecosystem', 'local', 'builtin', 'inline'] },
];

const PROVENANCE_TO_GROUP = new Map(
  FEATURE_DISPLAY_GROUPS.flatMap(g => g.provenances.map(p => [p, g.id]))
);

// 词表扩展时漏配映射会让 group 为 undefined、条目悄悄落兜底组——启动即报。
for (const p of FEATURE_PROVENANCES) {
  if (!PROVENANCE_TO_GROUP.has(p)) {
    throw new Error(`feature-registry: provenance "${p}" not mapped to any display group`);
  }
}

const CAPABILITY_IDS = new Set(FEATURE_CAPABILITIES.map(c => c.id));
const PROVENANCE_IDS = new Set(FEATURE_PROVENANCES);

function isValidDisplayName(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (value && typeof value === 'object'
    && typeof value.zh === 'string' && value.zh.trim().length > 0
    && typeof value.en === 'string' && value.en.trim().length > 0) return true;
  return false;
}

/**
 * 读取并校验 seed。校验失败直接 throw（路由层转 500 带修复指引），
 * 不静默回退空表——空表会把全部 feature 打进兜底组，掩盖数据损坏。
 */
export function loadFeatureRegistry(seedPath = SEED_PATH) {
  const raw = JSON.parse(readFileSync(seedPath, 'utf8'));
  if (!raw || raw.schemaVersion !== 1) {
    throw new Error(`feature-registry-seed.json: schemaVersion must be 1, got ${raw && raw.schemaVersion}`);
  }
  if (!Array.isArray(raw.features)) {
    throw new Error('feature-registry-seed.json: "features" must be an array');
  }
  const seen = new Set();
  for (const entry of raw.features) {
    const label = `feature-registry-seed.json entry ${JSON.stringify(entry)}`;
    if (!entry || typeof entry.name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(entry.name)) {
      throw new Error(`${label}: "name" must be a kebab-case runtime feature name`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`${label}: duplicate name "${entry.name}"`);
    }
    seen.add(entry.name);
    if (!Array.isArray(entry.capabilities) || entry.capabilities.length === 0
      || !entry.capabilities.every(cap => CAPABILITY_IDS.has(cap))) {
      throw new Error(`${label}: "capabilities" must be a non-empty array of ${[...CAPABILITY_IDS].join(', ')}`);
    }
    if (!PROVENANCE_IDS.has(entry.provenance)) {
      throw new Error(`${label}: unknown provenance "${entry.provenance}" (allowed: ${FEATURE_PROVENANCES.join(', ')})`);
    }
    if (!isValidDisplayName(entry.displayName)) {
      throw new Error(`${label}: "displayName" must be a non-empty string or { zh, en } object`);
    }
  }
  return {
    schemaVersion: raw.schemaVersion,
    capabilities: FEATURE_CAPABILITIES,
    provenances: FEATURE_PROVENANCES,
    groups: FEATURE_DISPLAY_GROUPS.map(g => g.id),
    features: raw.features.map(entry => ({ ...entry, group: PROVENANCE_TO_GROUP.get(entry.provenance) })),
  };
}
