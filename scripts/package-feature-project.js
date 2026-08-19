#!/usr/bin/env node
import './headless-log-preamble.js';

import { packageFeatureProject } from '../server/feature-runtime/packager.js';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

const projectDir = readArg('--project-dir');
const repositoryDir = readArg('--repository-dir') || undefined;

try {
  const snapshot = await packageFeatureProject({ projectDir, repositoryDir });
  process.stdout.write(`${JSON.stringify({ ok: true, snapshot })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
