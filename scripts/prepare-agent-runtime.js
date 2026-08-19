#!/usr/bin/env node

import './headless-log-preamble.js';
import path from 'path';
import { promises as fs } from 'fs';

import { normalizeAgentMetadata } from '../server/feature-runtime/schemas.js';
import { scanFeatureCatalog } from '../server/feature-runtime/catalog.js';
import { resolveAgentRuntimePlan } from '../server/feature-runtime/resolver.js';
import { provisionRuntimeEnvironment } from '../server/feature-runtime/provisioner.js';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
}

async function main() {
  const agentRootArgument = readArg('--agent-root');
  const metadataArgument = readArg('--metadata');
  const agentRoot = agentRootArgument ? path.resolve(agentRootArgument) : '';
  const metadataPath = metadataArgument ? path.resolve(metadataArgument) : '';
  const outputPath = readArg('--output') ? path.resolve(readArg('--output')) : '';
  const mode = readArg('--mode') || 'release';
  const sourceOverridesPath = readArg('--source-overrides');
  if (!agentRoot || !metadataPath || !outputPath) {
    throw new Error('用法: prepare-agent-runtime --agent-root <dir> --metadata <metadata.json> --output <plan.json> [--mode debug|release] [--source-overrides <json>]');
  }
  const rawMetadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  const metadata = normalizeAgentMetadata(rawMetadata, { requireFeatureVersions: mode === 'release' });
  const sourceOverrides = sourceOverridesPath
    ? JSON.parse(await fs.readFile(path.resolve(sourceOverridesPath), 'utf8'))
    : [];
  const catalog = await scanFeatureCatalog();
  const plan = resolveAgentRuntimePlan({ agentRoot, metadata, catalog, sourceOverrides, mode });
  const environment = await provisionRuntimeEnvironment({ plan });
  const output = {
    ...plan,
    agent: { ...plan.agent, entry: environment.agentEntry },
    metadataPath,
    environment,
    preparedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, plan: output })}\n`);
}

main().catch((error) => {
  process.stderr.write(`[prepare-agent-runtime] ${error?.stack || error}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, error: error?.message || String(error) })}\n`);
  process.exit(1);
});
