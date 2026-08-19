import path from 'path';

const PACKAGE_NAME_RE = /^(?:@[-a-z0-9~][a-z0-9~._-]*\/)?[a-z0-9~][a-z0-9~._-]*$/;
const EXACT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function asRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value;
}

function stringValue(value, label, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} 不能为空。`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串。`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${label} 不能为空。`);
  return normalized;
}

export function isValidPackageName(value) {
  return PACKAGE_NAME_RE.test(String(value || '').trim());
}

export function isExactSemver(value) {
  return EXACT_SEMVER_RE.test(String(value || '').trim());
}

export function normalizeFeatureRequirement(raw, { requireVersion = false } = {}) {
  const record = asRecord(raw, 'Feature requirement');
  const packageName = stringValue(record.package, 'features[].package', { required: true });
  if (!isValidPackageName(packageName)) {
    throw new Error(`features[].package 不是合法 npm 包名：${packageName}`);
  }
  const version = stringValue(record.version, 'features[].version');
  if (requireVersion && !version) {
    throw new Error(`正式运行需要为 ${packageName} 指定精确版本。`);
  }
  if (version && !isExactSemver(version)) {
    throw new Error(`features[].version 必须是精确 semver（不接受范围）：${version}`);
  }
  const exportName = stringValue(record.export, 'features[].export');
  const config = record.config === undefined ? {} : asRecord(record.config, 'features[].config');
  return {
    package: packageName,
    ...(version ? { version } : {}),
    ...(exportName ? { export: exportName } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function normalizeAgentMetadata(raw, { requireFeatureVersions = false } = {}) {
  const record = asRecord(raw, 'metadata.json');
  const id = stringValue(record.id, 'metadata.id', { required: true });
  const entry = stringValue(record.entry, 'metadata.entry', { required: true });
  if (path.isAbsolute(entry)) throw new Error('metadata.entry 必须是相对 Agent 项目根目录的路径。');
  const deploymentRaw = record.deployment === undefined ? { kind: 'standalone' } : asRecord(record.deployment, 'metadata.deployment');
  const deploymentKind = stringValue(deploymentRaw.kind, 'metadata.deployment.kind', { required: true });
  if (deploymentKind !== 'standalone' && deploymentKind !== 'workspace') {
    throw new Error('metadata.deployment.kind 只能是 standalone 或 workspace。');
  }
  if (record.features !== undefined && !Array.isArray(record.features)) {
    throw new Error('metadata.features 必须是数组。');
  }
  const seen = new Set();
  const features = (record.features || []).map((item) => {
    const requirement = normalizeFeatureRequirement(item, { requireVersion: requireFeatureVersions });
    if (seen.has(requirement.package)) {
      throw new Error(`metadata.features 重复声明了 ${requirement.package}。`);
    }
    seen.add(requirement.package);
    return requirement;
  });
  return {
    ...record,
    id,
    entry,
    deployment: { ...deploymentRaw, kind: deploymentKind },
    features,
  };
}

export function normalizeFeatureSourceOverride(raw, projectDir) {
  const record = asRecord(raw, 'Feature source override');
  const packageName = stringValue(record.package, 'features[].id', { required: true });
  if (!isValidPackageName(packageName)) {
    throw new Error(`Feature source override 的 package 不合法：${packageName}`);
  }
  const runtimeName = stringValue(record.runtimeName, 'features[].runtimeName', { required: true });
  const source = asRecord(record.source, 'features[].source');
  if (source.kind !== 'project') throw new Error('Feature source override 仅支持 source.kind=project。');
  const entry = stringValue(source.entry, 'features[].source.entry', { required: true });
  const projectFeatureDir = stringValue(source.projectDir, 'features[].source.projectDir', { required: true });
  const exportName = stringValue(record.export, 'features[].export');
  return {
    package: packageName,
    runtimeName,
    ...(exportName ? { export: exportName } : {}),
    source: {
      kind: 'project',
      projectDir: path.resolve(projectDir, projectFeatureDir),
      entry: path.resolve(projectDir, entry),
    },
  };
}
