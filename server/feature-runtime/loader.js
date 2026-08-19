import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

function asFeatureClass(moduleExports, exportName, label) {
  if (exportName) {
    const candidate = moduleExports[exportName];
    if (typeof candidate !== 'function') throw new Error(`${label} 未导出指定的 Feature class：${exportName}`);
    return candidate;
  }
  if (typeof moduleExports.default === 'function') return moduleExports.default;
  const classes = Object.entries(moduleExports).filter(([, value]) => typeof value === 'function');
  if (classes.length === 1) return classes[0][1];
  throw new Error(`${label} 无法唯一确定 Feature 导出；请在 metadata.features[].export 中声明导出名。`);
}

function resolveRepositoryEntry(feature, environmentDir) {
  if (!environmentDir) throw new Error(`仓库 Feature ${feature.package} 缺少隔离运行环境。`);
  const requireFromEnvironment = createRequire(path.join(environmentDir, 'package.json'));
  if (!feature.entry) return requireFromEnvironment.resolve(feature.package);
  // Do not require package.json to be exported. Feature manifests declare an
  // entry relative to the installed package root, and package names were
  // validated before the runtime plan was created.
  return path.join(environmentDir, 'node_modules', ...feature.package.split('/'), feature.entry);
}

export async function importResolvedFeatureClass(feature, { environmentDir, cacheBust = false } = {}) {
  const entry = feature.resolvedFrom === 'repository'
    ? resolveRepositoryEntry(feature, environmentDir)
    : feature.entry;
  const url = pathToFileURL(entry).href + (cacheBust && feature.resolvedFrom === 'source'
    ? `?agentdev=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : '');
  const moduleExports = await import(url);
  return { FeatureClass: asFeatureClass(moduleExports, feature.export, feature.package), entry };
}

function topologicalOrder(entries) {
  const byName = new Map(entries.map((entry) => [entry.instance.name, entry]));
  const names = [...byName.keys()];
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = (name, chain = []) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Feature static inject 存在循环：${[...chain, name].join(' → ')}`);
    const entry = byName.get(name);
    if (!entry) throw new Error(`Feature static inject 依赖不存在：${chain.at(-1) || 'unknown'} → ${name}`);
    visiting.add(name);
    const inject = Array.isArray(entry.FeatureClass.inject) ? entry.FeatureClass.inject : [];
    for (const dependency of inject) {
      if (!byName.has(dependency)) throw new Error(`Feature ${name} 的 static inject 依赖 ${dependency} 未在当前装配计划中声明。`);
      visit(dependency, [...chain, name]);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(entry);
  };
  for (const name of names) visit(name);
  return ordered;
}

/** Dynamically import, validate and mount all features before tool initialization. */
export async function mountResolvedFeatures(agent, plan, options = {}) {
  const entries = [];
  const seen = new Set();
  for (const feature of plan.features || []) {
    const { FeatureClass, entry } = await importResolvedFeatureClass(feature, options);
    const instance = new FeatureClass(feature.config || {});
    const runtimeName = String(instance?.name || '').trim();
    if (!runtimeName) throw new Error(`Feature ${feature.package} 实例没有 name。`);
    if (feature.runtimeName && feature.resolvedFrom === 'source' && runtimeName !== feature.runtimeName) {
      throw new Error(`Feature ${feature.package} 声明 name=${runtimeName}，但 Studio 注册名是 ${feature.runtimeName}。`);
    }
    if (seen.has(runtimeName) || agent.features?.has(runtimeName)) {
      throw new Error(`动态装配 Feature 名称冲突：${runtimeName}。Agent 已静态挂载同名 Feature 或 metadata 重复声明。`);
    }
    seen.add(runtimeName);
    // AgentDev provides onInitiate with config.features[feature.name]. Metadata
    // identifies a repository package by package name, which need not equal the
    // Feature instance name, so alias its JSON config to the real runtime name
    // before mount/initialization.
    if (feature.config && agent.config?.features && !agent.config.features[runtimeName]) {
      agent.config.features[runtimeName] = feature.config;
    }
    entries.push({ feature, FeatureClass, instance, entry });
  }
  const ordered = topologicalOrder(entries);
  for (const item of ordered) await agent.mountFeature(item.instance, { strictInit: true });
  return ordered.map((item) => ({
    package: item.feature.package,
    name: item.instance.name,
    resolvedFrom: item.feature.resolvedFrom,
    entry: item.entry,
  }));
}
