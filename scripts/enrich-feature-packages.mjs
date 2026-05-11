import { spawnSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import process from 'process';

const projectRoot = path.resolve(process.cwd());
const featureRoot = path.join(projectRoot, 'resources', 'features');
const manifestFileName = 'agentdev-feature.json';

function runTar(args, cwd = projectRoot) {
  const result = spawnSync('tar', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `tar ${args.join(' ')} failed`).trim());
  }
  return result.stdout;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function inferFeatureTypes(pkg, packageId) {
  const packageName = String(pkg.name || '').trim();
  const lowerPackageId = String(packageId || '').toLowerCase();

  if (packageName.startsWith('@sliverp/')) {
    return [];
  }
  if (/(shell|websearch|visual|tts|lsp|memory)/i.test(lowerPackageId)) {
    return ['tools'];
  }
  if (/(audio-feedback|audit|plugin-compat)/i.test(lowerPackageId)) {
    return ['hooks'];
  }
  if (/qqbot/i.test(lowerPackageId)) {
    return ['hooks', 'control'];
  }
  return [];
}

function inferRequirements(pkg, packageId) {
  const dependencies = Object.keys(pkg.dependencies || {});
  const requirements = {
    platforms: [],
    node: typeof pkg.engines?.node === 'string' ? pkg.engines.node.trim() : '',
    external: [],
    services: [],
  };

  if (dependencies.includes('openai') || /websearch|visual|tts/i.test(packageId)) {
    requirements.services.push('network');
  }
  if (/shell/i.test(packageId)) {
    requirements.external.push('system-shell');
  }
  if (/audio|tts/i.test(packageId) || dependencies.includes('sound-play')) {
    requirements.external.push('audio-output');
  }
  if (/visual/i.test(packageId)) {
    requirements.external.push('desktop-capture');
  }
  if (/lsp/i.test(packageId)) {
    requirements.external.push('language-server');
  }
  if (/qqbot/i.test(packageId)) {
    requirements.services.push('qqbot');
  }

  requirements.external = uniqueStrings(requirements.external);
  requirements.services = uniqueStrings(requirements.services);
  return requirements;
}

function buildManifest(pkg) {
  const packageId = (pkg.name || '').split('/').pop() || 'feature-package';
  const featureTypes = inferFeatureTypes(pkg, packageId);
  return {
    schemaVersion: 1,
    id: packageId,
    name: packageId,
    version: pkg.version || '',
    description: pkg.description || '',
    tags: uniqueStrings(pkg.keywords || []),
    entry: pkg.main || '',
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : '',
    repository: typeof pkg.repository === 'string'
      ? pkg.repository
      : (typeof pkg.repository?.url === 'string' ? pkg.repository.url : ''),
    agentdev: {
      compatible: typeof pkg.peerDependencies?.agentdev === 'string' ? pkg.peerDependencies.agentdev : '',
    },
    featureTypes,
    compatibility: {
      rollback: featureTypes.includes('rollback'),
      tags: [featureTypes.includes('rollback') ? 'supports-rollback' : 'no-rollback'],
    },
    requirements: inferRequirements(pkg, packageId),
  };
}

async function enrichArchive(archivePath) {
  const archiveName = path.basename(archivePath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdev-feature-'));
  try {
    runTar(['-xzf', archivePath], tempDir);
    const packageDir = path.join(tempDir, 'package');
    const packageJsonPath = path.join(packageDir, 'package.json');
    const manifestPath = path.join(packageDir, manifestFileName);
    const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    const manifest = buildManifest(pkg);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await fs.rm(archivePath, { force: true });
    runTar(['-czf', archivePath, 'package'], tempDir);
    return { archiveName, packageName: pkg.name || '', manifest };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const entries = await fs.readdir(featureRoot, { withFileTypes: true });
  const archives = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.tgz'))
    .map((entry) => path.join(featureRoot, entry.name))
    .sort();

  for (const archivePath of archives) {
    const result = await enrichArchive(archivePath);
    console.log(`[updated] ${result.archiveName} -> ${result.manifest.id}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
