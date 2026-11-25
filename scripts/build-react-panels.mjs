#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const panelRoot = path.join(root, 'public', 'src', 'react-panels');
const outputRoot = path.join(root, 'public', 'src', 'react-panels-dist');
const sharedRoot = path.join(outputRoot, 'shared');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const reactVersion = packageJson.devDependencies.react;
const reactDomVersion = packageJson.devDependencies['react-dom'];
if (!reactVersion || reactVersion !== reactDomVersion) {
  throw new Error('React and React DOM must be declared at the same version');
}

const candidateEntries = (await readdir(panelRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => path.join(panelRoot, entry.name, 'index.tsx'));
const entries = [];
for (const entry of candidateEntries) {
  try { await readFile(entry); entries.push(entry); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (entries.length === 0) {
  console.log('[build:react-panels] No React panels to build');
  process.exit(0);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(sharedRoot, { recursive: true });
const sharedBuild = await build({
  absWorkingDir: root,
  entryPoints: {
    react: 'scripts/react-panel-react.mjs',
    'react-jsx-runtime': 'scripts/react-panel-jsx-runtime.mjs',
    'react-dom-client': 'scripts/react-panel-react-dom-client.mjs',
    'react-dom': require.resolve('react-dom'),
  },
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  outdir: sharedRoot,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  metafile: true,
});

for (const entry of entries) {
  const panelId = path.basename(path.dirname(entry));
  const outputDir = path.join(outputRoot, panelId);
  await mkdir(outputDir, { recursive: true });
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    // 不用 packages:'external'：面板依赖的非 React 包（docx-preview / xlsx 等）
    // 需要内联进单文件产物——裸说明符的动态 import 浏览器无法解析。
    // React 系仍外置并重写为共享 URL（见下方 requiredImports 重写）。
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    outdir: outputDir,
    entryNames: 'index',
    assetNames: 'assets/[name]-[hash]',
    plugins: [{
      name: 'panel-css-text',
      setup(buildApi) {
        buildApi.onLoad({ filter: /\.css$/ }, async args => {
          const css = await readFile(args.path, 'utf8');
          return { contents: `export default ${JSON.stringify(css)};`, loader: 'js' };
        });
      },
    }],
    metafile: true,
  });
  const jsPath = path.join(outputDir, 'index.js');
  let js = await readFile(jsPath, 'utf8');
  // 相对路径是子路径部署的硬约束：根绝对路径（/src/...）会被浏览器按 origin
  // 解析，丢失网关挂载前缀（如 /advclaw/）——入口 URL 由前端经
  // __PROTOCLAW_APP_URL__ 带前缀加载，但模块内部静态 import 逃不出这层。
  // 相对说明符按导入模块自身 URL 解析（<base> 与 fetch patch 都管不到模块图），
  // 根路径与子路径部署通用。
  const requiredImports = [
    ['react', '../shared/react.js'],
    ['react/jsx-runtime', '../shared/react-jsx-runtime.js'],
    ['react-dom/client', '../shared/react-dom-client.js'],
    ['react-dom', '../shared/react-dom.js'],
  ];
  let rewrittenImports = 0;
  for (const [specifier, publicPath] of requiredImports) {
    const marker = `from "${specifier}"`;
    if (js.includes(marker)) {
      js = js.replaceAll(marker, `from "${publicPath}?v=${reactVersion}"`);
      rewrittenImports += 1;
    }
  }
  if (!rewrittenImports) throw new Error(`${panelId} has no imports from the shared React entries`);
  for (const [specifier, publicPath] of requiredImports) {
    const marker = `from "${specifier}"`;
    if (js.includes(marker)) throw new Error(`${panelId} retained bare React import ${specifier}`);
  }
  // Keep generated bundles clean for repository whitespace checks (some vendor
  // CSS strings contain source trailing spaces that esbuild preserves verbatim).
  js = js.replace(/[ \t]+$/gm, '');
  await writeFile(jsPath, js);
  await writeFile(path.join(outputDir, 'build-meta.json'), JSON.stringify({
    panelId,
    reactVersion,
    outputs: Object.keys(result.metafile.outputs).map(file => path.relative(outputRoot, path.join(root, file)).replaceAll(path.sep, '/')),
  }, null, 2) + String.fromCharCode(10));
}

await writeFile(path.join(outputRoot, 'build-meta.json'), JSON.stringify({
  reactVersion,
  sharedOutputs: Object.keys(sharedBuild.metafile.outputs).map(file => path.relative(outputRoot, path.join(root, file)).replaceAll(path.sep, '/')),
  panels: entries.map(entry => path.basename(path.dirname(entry))),
}, null, 2) + String.fromCharCode(10));
console.log(`[build:react-panels] Built ${entries.length} panel(s) with shared React ${reactVersion}`);
