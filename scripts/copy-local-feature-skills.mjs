import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const localFeaturesDir = path.join(rootDir, 'local-features');
const distDir = path.join(localFeaturesDir, 'dist');

function copyFeatureSkills(featureName) {
  const srcSkillsDir = path.join(localFeaturesDir, featureName, 'skills');
  if (!existsSync(srcSkillsDir)) {
    return false;
  }

  const distSkillsDir = path.join(distDir, featureName, 'src', 'skills');
  rmSync(distSkillsDir, { recursive: true, force: true });
  mkdirSync(path.dirname(distSkillsDir), { recursive: true });
  cpSync(srcSkillsDir, distSkillsDir, {
    recursive: true,
    dereference: true,
    force: true,
  });
  console.log(`[copy-local-feature-skills] ${srcSkillsDir} -> ${distSkillsDir}`);
  return true;
}

if (!existsSync(localFeaturesDir) || !existsSync(distDir)) {
  console.log('[copy-local-feature-skills] local-features or dist directory not found, skipping.');
  process.exit(0);
}

const featureDirs = readdirSync(localFeaturesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'dist')
  .map((entry) => entry.name);

let copiedCount = 0;
for (const featureName of featureDirs) {
  if (copyFeatureSkills(featureName)) {
    copiedCount++;
  }
}

console.log(`[copy-local-feature-skills] copied skills for ${copiedCount} feature(s).`);
