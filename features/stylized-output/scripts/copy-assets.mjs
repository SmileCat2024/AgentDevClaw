#!/usr/bin/env node
/**
 * Copy non-TypeScript assets and optional feature skills to dist directory.
 * - Files under src/ are mirrored into dist/
 * - Files under skills/ are mirrored into dist/skills/
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const srcDir = join(rootDir, 'src');
const skillsDir = join(rootDir, 'skills');
const distDir = join(rootDir, 'dist');
const distSkillsDir = join(distDir, 'skills');

// Extensions to copy (non-TypeScript files)
const ASSET_EXTENSIONS = new Set([
  '.mp3', '.wav', '.ogg', '.flac',  // Audio
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',  // Images
  '.json',  // Config files
  '.py', '.sh', '.bash', '.zsh',  // Scripts
  '.txt', '.md', '.rst',  // Docs
  '.yml', '.yaml', '.toml', '.ini',  // Config
  '.sql', '.graphql', '.gql',  // Data
  '.html', '.css', '.scss', '.less',  // Styles
  '.wasm', '.bin',  // Binary
]);

function isAssetFile(filename) {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 && ASSET_EXTENSIONS.has(filename.slice(idx).toLowerCase());
}

function copyDirectory(src, dest) {
  if (!existsSync(src)) {
    return;
  }

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else if (entry.isFile() && isAssetFile(entry.name)) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      console.log(`Copied: ${relative(rootDir, srcPath)}`);
    }
  }
}

function copySkillsDirectory(src, dest) {
  if (!existsSync(src)) {
    return;
  }

  const entries = readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      copySkillsDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
      console.log(`Copied skill: ${relative(rootDir, srcPath)}`);
    }
  }
}

// Copy assets from src to dist
copyDirectory(srcDir, distDir);
copySkillsDirectory(skillsDir, distSkillsDir);
