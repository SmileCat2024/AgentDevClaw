import path from 'path';

import { normalizeFeatureRequirement, normalizeFeatureSourceOverride } from './schemas.js';
import { resolveCatalogPackage } from './catalog.js';

export function resolveAgentRuntimePlan({
  agentRoot,
  metadata,
  catalog,
  sourceOverrides = [],
  mode = 'release',
}) {
  if (mode !== 'debug' && mode !== 'release') {
    throw new Error('Runtime mode 只能是 debug 或 release。');
  }
  const requirements = (metadata.features || []).map((entry) => normalizeFeatureRequirement(entry, {
    requireVersion: mode === 'release',
  }));
  const requirementByPackage = new Map(requirements.map((entry) => [entry.package, entry]));
  const overrides = new Map();
  for (const rawOverride of sourceOverrides) {
    const override = normalizeFeatureSourceOverride(rawOverride, agentRoot);
    if (!requirementByPackage.has(override.package)) {
      throw new Error(`源码覆盖 ${override.package} 没有对应的 metadata.features 声明。`);
    }
    if (overrides.has(override.package)) {
      throw new Error(`源码覆盖重复声明了 ${override.package}。`);
    }
    overrides.set(override.package, override);
  }
  if (mode === 'release' && overrides.size > 0) {
    throw new Error('release 模式不允许 source override。');
  }

  const features = requirements.map((requirement) => {
    const override = overrides.get(requirement.package);
    if (override) {
      return {
        package: requirement.package,
        version: null,
        runtimeName: override.runtimeName,
        ...(override.export ? { export: override.export } : (requirement.export ? { export: requirement.export } : {})),
        ...(requirement.config ? { config: requirement.config } : {}),
        resolvedFrom: 'source',
        entry: override.source.entry,
        projectDir: override.source.projectDir,
      };
    }
    const archive = resolveCatalogPackage(catalog, {
      packageName: requirement.package,
      version: requirement.version,
      allowLatest: mode === 'debug' && !requirement.version,
    });
    return {
      package: requirement.package,
      version: archive.version,
      runtimeName: requirement.package,
      ...(requirement.export ? { export: requirement.export } : {}),
      ...(requirement.config ? { config: requirement.config } : {}),
      resolvedFrom: 'repository',
      archivePath: archive.archivePath,
      archiveDigest: archive.archiveDigest,
      entry: archive.entry,
      source: archive.source,
    };
  });

  return {
    schemaVersion: 1,
    mode,
    agent: {
      id: metadata.id,
      root: path.resolve(agentRoot),
      entry: path.resolve(agentRoot, metadata.entry),
      deployment: metadata.deployment,
    },
    features,
  };
}
