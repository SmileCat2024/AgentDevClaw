/**
 * feature-store routes — 插件商店数据面（GET /api/feature-store/overview）
 *
 * 聚合两端数据支撑"给 agent 加插件"面板：
 * - packages：Feature tgz 仓库中可安装的包（仅用户仓库源；官方仓库的包是
 *   官方 agent 静态装配的原料，不进入用户商店货架）
 * - mounts：两个身份（main / coder）配置层中已声明的 $mount 装配清单，
 *   并对照 catalog 标记 missing（包或版本已不在仓库）
 *
 * 写回不在此路由：安装/卸载直接复用 PUT /protoclaw/feature_config/layer
 * （$mount 与配置值同层同文件，整层写回），保证校验与合并语义单一权威。
 */

import { readHookDeclarations } from '@agentdevjs/core';
import { existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { scanFeatureCatalog } from '../feature-runtime/catalog.js';
import { buildScopeLayers } from './feature-config.js';
import { extractFeatureMounts } from '../shared/feature-mount.js';

const STORE_SCOPES = [
  { identity: 'main', agentId: 'programming-helper' },
  { identity: 'coder', agentId: 'coder' },
];

/**
 * agent.js 模块缓存（装配权威的加载入口）。展示元数据不在此重复声明：
 * 工厂实例自身的 name / description 提供（feature 定义即唯一权威）。
 */
let agentModulePromise = null;
function loadAgentModule() {
  if (!agentModulePromise) {
    agentModulePromise = import('../../prebuilt-agents/official/programming-helper/agent.js')
      .catch((error) => {
        agentModulePromise = null; // 允许下次重试（agent.js 构建损坏时货架置空而非永久卡死）
        throw error;
      });
  }
  return agentModulePromise;
}

/**
 * 官方可选插件表（$mount kind:'builtin' 的装配权威）。
 */
async function loadBuiltinTables() {
  const mod = await loadAgentModule();
  return mod.builtinOptionalFeatures || {};
}

/**
 * skill 目录计数：与框架 collectFeatureSkills 同一发现口径（feature 源码
 * 同级 skills/ 下每个含 SKILL.md 的子目录一个 skill）。discover 未从包入口
 * 导出，此处用轻量目录扫描等价计数（仅 frontmatter 非法的极端情况会偏差）。
 */
function countFeatureSkills(instance) {
  const source = typeof instance?.source === 'string' ? instance.source : '';
  if (!source) return 0;
  const filePath = source.startsWith('file://') ? fileURLToPath(source) : source;
  const skillsDir = join(dirname(filePath), 'skills');
  try {
    if (!existsSync(skillsDir)) return 0;
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(skillsDir, entry.name, 'SKILL.md')))
      .length;
  } catch {
    return 0;
  }
}

/**
 * feature 实例的声明面计数（配置视图用，非运行时快照）：
 * - hooks：readHookDeclarations 声明的钩子方法数
 * - tools：同步面 getTools 声明数。异步工具（运行时连接的外部服务器，
 *   如 mcp / websearch）不属于声明面，静态读数为 0 就客观显示 0
 * - skills：源码旁 skills/ 目录计数
 * - commands：getCapabilities 中以 slash 为入口的命令数（与 /protoclaw/commands
 *   的过滤口径一致；skills 也经此注册为 skill.<name> 命令）
 * 单项读取失败按 0/缺省处理，不阻断清单。
 */
export function summarizeInstanceSurface(instance) {
  if (!instance) return null;
  let hooks = 0;
  try {
    hooks = Object.keys(readHookDeclarations(instance)).length;
  } catch { /* 声明读取失败按 0 */ }
  let commands = 0;
  try {
    const caps = instance.getCapabilities?.() || [];
    commands = caps.filter((cap) => {
      const entryPoints = Array.isArray(cap?.entryPoints) && cap.entryPoints.length > 0
        ? cap.entryPoints
        : ['feature'];
      return entryPoints.includes('slash');
    }).length;
  } catch { /* 同上 */ }
  let tools = 0;
  try {
    tools = (instance.getTools?.() || []).length;
  } catch { /* 同上 */ }
  return { hooks, tools, skills: countFeatureSkills(instance), commands };
}

/**
 * 某身份官方底座清单：无参实例化该身份 Agent 类，读静态装配的
 * features Map（name / description 自加载自实例，装配代码即唯一权威）。
 * 只做展示读取，实例即弃（构造无外部副作用；onInitiate 才有附加逻辑）。
 * surface 为声明面计数（见 summarizeInstanceSurface）。
 */
export async function collectBaseFeatures(identity) {
  const mod = await loadAgentModule();
  const AgentClass = mod.resolveAgentClass(
    identity === 'coder' ? { runtime: { sessionType: 'coder' } } : {},
  );
  // BasicAgent 构造要求 llm 必传；总览只读静态装配的 features Map，
  // 不跑会话，占位模型名即可。
  const agent = new AgentClass({ llm: { modelName: 'overview' } });
  const list = [];
  for (const [name, instance] of agent.features) {
    list.push({
      name,
      description: typeof instance?.description === 'string' ? instance.description : '',
      surface: summarizeInstanceSurface(instance),
    });
  }
  return list;
}

/**
 * builtinOptionalFeatures → 商店货架（纯函数）。
 * 标题/描述自加载自工厂实例；实例化失败仅列名，不阻断货架。
 */
export function buildBuiltinShowcase(tables) {
  const byName = new Map();
  for (const [identity, table] of Object.entries(tables || {})) {
    for (const [runtimeName, spec] of Object.entries(table || {})) {
      let entry = byName.get(runtimeName);
      if (!entry) {
        let title = runtimeName;
        let description = '';
        try {
          const instance = spec?.create?.();
          title = instance?.name || runtimeName;
          description = instance?.description || '';
        } catch { /* 展示兜底：工厂不可实例化时仅列名 */ }
        entry = { runtimeName, title, description, identities: [] };
        byName.set(runtimeName, entry);
      }
      entry.identities.push(identity);
    }
  }
  return [...byName.values()];
}

/**
 * catalog → 商店包列表（纯函数）：只列用户仓库源；官方仓库的包是官方
 * agent 静态装配的原料，不进入用户商店货架。
 */
export function buildStorePackages(catalog) {
  const packages = [];
  for (const [packageName, versions] of catalog.packages) {
    const userVersions = versions.filter((entry) => entry.source === 'custom');
    if (!userVersions.length) continue;
    const head = userVersions[0];
    packages.push({
      package: packageName,
      displayName: head.manifestName || packageName.replace(/^@[^/]+\//, ''),
      description: head.manifestDescription || '',
      versions: userVersions.map((entry) => ({
        version: entry.version,
        digest: entry.archiveDigest,
      })),
    });
  }
  return packages;
}

/** 单身份的 $mount 清单：{ [runtimeName]: { package, version, layerId, missing } } */
export async function collectScopeMounts(agentId, catalog) {
  const { layers } = buildScopeLayers({ agentId });
  const { mounts } = extractFeatureMounts(
    layers.map(({ id, sparse }) => ({ id, config: sparse })),
  );
  const result = {};
  for (const [runtimeName, mount] of mounts) {
    // builtin（官方可选插件）不走 tgz 仓库，无 missing 概念
    if (mount.kind === 'builtin') {
      result[runtimeName] = { ...mount, missing: false };
      continue;
    }
    const versions = catalog.packages.get(mount.package) || [];
    result[runtimeName] = {
      ...mount,
      missing: !versions.some((entry) => entry.version === mount.version),
    };
  }
  return result;
}

/**
 * 某 agentId 已装配项的配置 manifest 聚合（供 system_feature_manifests 合并）：
 * - extras：已装配 runtimeName 全集（无论有无 settings，前端据此放行白名单过滤）
 * - manifests：有 settings.properties 的项（builtin → 工厂实例 getFeatureManifest；
 *   repository → tgz manifest 的 settings 字段）
 * options（测试注入口）：catalogRoots → scanFeatureCatalog；scopeIdentity →
 * builtin 工厂表的身份键（缺省按 STORE_SCOPES 反查）。
 */
export async function collectScopeMountManifests(agentId, { catalogRoots, scopeIdentity } = {}) {
  const scope = STORE_SCOPES.find((s) => s.agentId === agentId);
  const identity = scopeIdentity ?? scope?.identity ?? null;
  const catalog = await scanFeatureCatalog(catalogRoots || {});
  const mounts = await collectScopeMounts(agentId, catalog);
  const extras = Object.keys(mounts);
  const manifests = [];
  for (const runtimeName of extras) {
    const mount = mounts[runtimeName];
    try {
      if (mount.kind === 'builtin') {
        if (!identity) continue;
        const spec = (await loadBuiltinTables())?.[identity]?.[runtimeName];
        const instance = spec?.create?.();
        const manifest = typeof instance?.getFeatureManifest === 'function'
          ? instance.getFeatureManifest()
          : null;
        if (manifest?.settings?.properties) {
          manifests.push({ featureName: runtimeName, manifest });
        }
      } else {
        const entry = (catalog.packages.get(mount.package) || [])
          .find((e) => e.version === mount.version);
        if (entry?.manifestSettings?.properties) {
          manifests.push({ featureName: runtimeName, manifest: { settings: entry.manifestSettings } });
        }
      }
    } catch { /* 单项读取失败不阻断清单 */ }
  }
  return { extras, manifests };
}

export function setupFeatureStoreRoutes(app) {
  app.get('/api/feature-store/overview', async (_req, res) => {
    try {
      const catalog = await scanFeatureCatalog();
      let builtin = [];
      const base = {};
      try {
        const tables = await loadBuiltinTables();
        builtin = buildBuiltinShowcase(tables);
        // builtin 货架卡片同样带声明面计数（工厂为本地 local-feature，二次
        // 实例化无副作用；buildBuiltinShowcase 返回形状被测试锁定，不在此扩展）
        for (const entry of builtin) {
          const spec = tables?.[entry.identities[0]]?.[entry.runtimeName];
          if (spec?.create) {
            try {
              entry.surface = summarizeInstanceSurface(spec.create());
            } catch { /* 展示兜底：计数不可用时省略数量行 */ }
          }
        }
        for (const scope of STORE_SCOPES) {
          base[scope.identity] = await collectBaseFeatures(scope.identity);
        }
      } catch { /* agent.js 加载失败时货架与底座置空，不阻断仓库包与已装配数据 */ }
      const mounts = {};
      for (const scope of STORE_SCOPES) {
        mounts[scope.identity] = await collectScopeMounts(scope.agentId, catalog);
      }
      res.json({ builtin, base, packages: buildStorePackages(catalog), mounts });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}
