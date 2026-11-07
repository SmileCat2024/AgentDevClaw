#!/usr/bin/env node
/**
 * React 面板插件构建器（ADR-0044 P6：React 接入基建）。
 *
 * 约定驱动：public/src/plugins/<name>/src/index.tsx 存在即视为 React 插件，
 * 产物写到 public/src/plugins/<name>/dist/index.js（ESM，对齐 claw-host 插件
 * 协议的动态 import() 装载；dist 目录同时是 frontend-globals 门禁的忽略域，
 * 含 react 运行时的 bundle 不进全局暴露扫描）。
 *
 * 两条构建通道：
 *   1. esbuild bundle（format esm / jsx automatic / target es2023）。
 *      react 与 react-dom **打包进产物**（宿主不自带 React，懒装载时
 *      import() 一个文件全齐，无加载顺序依赖）。代价是每个 React 插件
 *      自带一份运行时（~45KB gz）；多 React 插件共享运行时留给后续按需优化。
 *   2. tailwind（可选）：src/tailwind.css 存在时经 @tailwindcss/cli 编译，
 *      再按文件头 scope 注释（形如「scope: .xxx」，块注释内）做选择器作用
 *      域化（移植自 agentero-dsh scripts/build-client.mjs，行为对齐）。
 *      产物 CSS 以 `__clawPanelCss` 字符串常量注入 banner——插件源码
 *      `declare const __clawPanelCss: string` 后在 mount/unmount 里自行
 *      注入 <style> / 移除（插件协议生命周期自治，宿主零改动）。
 *
 * 构建器与插件源码的显式约定只有一条：banner 的 __clawPanelCss 常量
 * （无 tailwind.css 时为空字符串）。
 */
import * as esbuild from 'esbuild';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PLUGINS_DIR = join(ROOT, 'public', 'src', 'plugins');

/** ── CSS 选择器作用域化（移植自 agentero-dsh build-client.mjs） ── */

function matchingBrace(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length - 1;
}

function prefixSelector(selector, scope) {
  return selector.split(',').map((part) => {
    const trimmed = part.trim();
    if (trimmed === '' || trimmed.includes(scope)) return part;
    if (trimmed.startsWith(':root') || trimmed.startsWith('html') || trimmed.startsWith('@')) return part;
    if (trimmed.startsWith('body[data-')) return part;
    return `${scope} ${trimmed}, ${scope}${trimmed}`;
  }).join(',');
}

function scopeSelectors(css, scope) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    // 保留 Tailwind 的 license 横幅与 layer 顺序声明（当选择器处理会使后续 layer 失效）
    if (css.startsWith('/*', i)) {
      const end = css.indexOf('*/', i + 2) + 2;
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (/\s/.test(css[i])) {
      out += css[i++];
      continue;
    }
    if (css.startsWith('@keyframes', i) || css.startsWith('@property', i) || css.startsWith('@font-face', i)) {
      const end = matchingBrace(css, css.indexOf('{', i)) + 1;
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (css[i] === '@') {
      const brace = css.indexOf('{', i);
      const semicolon = css.indexOf(';', i);
      if (semicolon !== -1 && (brace === -1 || semicolon < brace)) {
        out += css.slice(i, semicolon + 1);
        i = semicolon + 1;
        continue;
      }
      out += css.slice(i, brace + 1);
      const innerEnd = matchingBrace(css, brace);
      out += scopeSelectors(css.slice(brace + 1, innerEnd), scope);
      out += '}';
      i = innerEnd + 1;
      continue;
    }
    const brace = css.indexOf('{', i);
    if (brace === -1) {
      out += css.slice(i);
      break;
    }
    out += `${prefixSelector(css.slice(i, brace), scope)}{`;
    const innerEnd = matchingBrace(css, brace);
    const inner = css.slice(brace + 1, innerEnd);
    out += inner.includes('{') ? scopeSelectors(inner, scope) : inner;
    out += '}';
    i = innerEnd + 1;
  }
  return out;
}

/** ── tailwind 编译（scope 注释 → 作用域化产物；无输入文件返回 ''） ── */

function compileTailwind(pluginDir) {
  const input = join(pluginDir, 'src', 'tailwind.css');
  if (!existsSync(input)) return '';
  const source = readFileSync(input, 'utf8');
  const scope = source.match(/scope:\s*(\.[A-Za-z0-9_-]+)/)?.[1];
  const cli = join(ROOT, 'node_modules', '@tailwindcss', 'cli', 'dist', 'index.mjs');
  if (!existsSync(cli)) {
    throw new Error(`tailwind cli not found: ${relative(ROOT, cli)}（npm install 后重试）`);
  }
  const compiled = spawnSync(process.execPath, [cli, '-i', input, '--minify'], {
    cwd: pluginDir,
    encoding: 'utf8',
  });
  if (compiled.status !== 0) {
    throw new Error(compiled.stderr || compiled.stdout || 'tailwind compile failed');
  }
  return scope === undefined ? compiled.stdout : scopeSelectors(compiled.stdout, scope);
}

/** ── 插件发现与构建 ── */

/**
 * 读取插件 src/shim/alias.json（外部宿主包名 → 本地 shim 相对路径）。
 * 搬迁存量插件的宿主依赖（如 dsh-client-*）在 shim 层拦截，组件源码保持
 * 与上游可 diff。返回 esbuild alias 映射（绝对路径）。
 */
function readShimAliases(pluginDir) {
  const aliasFile = join(pluginDir, 'src', 'shim', 'alias.json');
  if (!existsSync(aliasFile)) return undefined;
  const entries = Object.entries(JSON.parse(readFileSync(aliasFile, 'utf8')));
  const alias = {};
  for (const [pkg, relativePath] of entries) {
    alias[pkg] = join(pluginDir, 'src', 'shim', relativePath.replace(/^\.\//, ''));
  }
  return alias;
}

function discoverReactPlugins() {
  if (!existsSync(PLUGINS_DIR)) return [];
  return readdirSync(PLUGINS_DIR)
    .filter((name) => {
      const dir = join(PLUGINS_DIR, name);
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;
      return existsSync(join(dir, 'src', 'index.tsx'));
    });
}

function fmtKb(bytes) {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

async function buildPlugin(name) {
  const pluginDir = join(PLUGINS_DIR, name);
  const entry = join(pluginDir, 'src', 'index.tsx');
  const css = compileTailwind(pluginDir);

  const banner = `const __clawPanelCss = ${JSON.stringify(css)};`;

  const result = await esbuild.build({
    absWorkingDir: pluginDir,
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2023',
    jsx: 'automatic',
    write: false,
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: banner },
    alias: readShimAliases(pluginDir),
  });

  const bundled = result.outputFiles[0]?.text;
  if (bundled === undefined) {
    throw new Error(`build-react-panels: ${name} produced no output`);
  }

  const outfile = join(pluginDir, 'dist', 'index.js');
  mkdirSync(dirname(outfile), { recursive: true });
  writeFileSync(outfile, bundled);
  const cssNote = css ? `css ${fmtKb(Buffer.byteLength(css))}（scope 注入）` : '无 css';
  console.log(`[build-react-panels] ${name}: ${fmtKb(Buffer.byteLength(bundled))}｜${cssNote}`);
}

const plugins = discoverReactPlugins();
if (plugins.length === 0) {
  console.log('[build-react-panels] 未发现 React 插件（public/src/plugins/*/src/index.tsx）');
} else {
  for (const name of plugins) {
    await buildPlugin(name);
  }
  console.log(`[build-react-panels] 完成：${plugins.length} 个插件`);
}
