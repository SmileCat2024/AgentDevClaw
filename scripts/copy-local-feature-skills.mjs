import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const localFeaturesDir = path.join(rootDir, 'local-features');
const distDir = path.join(localFeaturesDir, 'dist');

function copyDir(src, dist) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(path.dirname(dist), { recursive: true });
  cpSync(src, dist, { recursive: true, dereference: true, force: true });
  console.log(`[copy-local-feature-skills] ${src} -> ${dist}`);
}

/**
 * 复制 feature 的非代码资产到 dist 下与 feature source 相对的一致位置：
 *
 * 1) 根级 skills/（source 在 src 根的 feature 扫 <dist>/<feature>/src/skills）；
 * 2) 根级 knowledge/（craft-awareness 等知识库型 feature 的注入文案 md，
 *    运行时按 dirname(source)/knowledge 读取，路径约定与 skills 相同）；
 * 3) 内嵌 skills/（ticket 036 v2 修复）：feature 源码子目录（如 src/playwright/）
 *    自带 skills/ —— 框架按 dirname(source)/skills 逐 feature 发现，同一包内
 *    多个 feature 若共享 src 根会导致同一批 skill 被重复注册（duplicate
 *    capability ref）。子目录 feature 的 skills 必须随源码相对位置复制。
 */
function copyFeatureSkills(featureName) {
  let copied = false;
  const featureRoot = path.join(localFeaturesDir, featureName);
  const featureDistRoot = path.join(distDir, featureName);

  for (const assetDirName of ['skills', 'knowledge']) {
    const srcAssetDir = path.join(localFeaturesDir, featureName, assetDirName);
    if (existsSync(srcAssetDir)) {
      const distAssetDir = path.join(featureDistRoot, 'src', assetDirName);
      rmSync(distAssetDir, { recursive: true, force: true });
      cpSync(srcAssetDir, distAssetDir, { recursive: true, dereference: true, force: true });
      console.log(`[copy-local-feature-skills] ${srcAssetDir} -> ${distAssetDir}`);
      copied = true;
    }
  }

  const featureSrcDir = path.join(localFeaturesDir, featureName, 'src');
  if (existsSync(featureSrcDir)) {
    const stack = [featureSrcDir];
    while (stack.length > 0) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch { continue; }
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (!entry.isDirectory()) continue;
        if (entry.name === 'skills') {
          const rel = path.relative(featureSrcDir, full);
          const distSkills = path.join(featureDistRoot, 'src', rel);
          cpSync(full, distSkills, { recursive: true, dereference: true, force: true });
          console.log(`[copy-local-feature-skills] ${full} -> ${distSkills}`);
          copied = true;
        } else {
          stack.push(full);
        }
      }
    }
  }
  return copied;
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
