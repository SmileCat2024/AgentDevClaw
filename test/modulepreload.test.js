import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildModuleGraph,
  collectModuleEntrySpecs,
  collectRelativeSpecifiers,
  createFirstPaintIndexRenderer,
  injectPreloadLinks,
  renderPreloadLinks,
  toSiteHref,
} from '../server/shared/modulepreload.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claw-modulepreload-'));
}

function writeFile(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('collectModuleEntrySpecs 只取 module 标签，保持文档顺序', () => {
  const html = [
    '<script src="./vendor/a.js"></script>',
    '<script type="module" src="./src/app-core.js"></script>',
    "<script type='module' src='./src/modules/boot.js'></script>",
    '<script defer src="./src/modules/kernel-state.js"></script>',
  ].join('\n');
  assert.deepEqual(collectModuleEntrySpecs(html), ['./src/app-core.js', './src/modules/boot.js']);
});

test('collectRelativeSpecifiers 覆盖 import / export-from / 副作用 import 与跨行写法', () => {
  const source = [
    "import { a, b } from './a.js';",
    "import defaultExport from '../b.js';",
    "export { c } from './c.js';",
    "export * from './d.js';",
    "import './side-effect.js';",
    "import('./dynamic.js');",
    "import express from 'express';",
    'const x = 1;',
  ].join('\n');
  const specs = collectRelativeSpecifiers(source);
  // 动态 import 是“按需”的信号，不参与预取；裸包名（express）不来自站点目录。
  assert.deepEqual(specs, ['./a.js', '../b.js', './c.js', './d.js', './side-effect.js']);
});

test('buildModuleGraph 递归收集依赖、排除入口自身、去重且容忍环', () => {
  const files = {
    '/p/index.html': '',
    '/p/root.js': "import './a.js';\nimport './b.js';",
    '/p/a.js': "import './b.js';\nimport './c.js';",
    '/p/b.js': "export { y } from './a.js';",
    '/p/c.js': 'const c = 1;',
  };
  const graph = buildModuleGraph({
    indexHtml: '<script type="module" src="./root.js"></script>',
    readFile: (file) => files[file] ?? null,
    resolve: (_from, spec) => `/p/${spec.replace('./', '')}`,
  });
  assert.deepEqual(graph.roots, ['/p/root.js']);
  assert.deepEqual(graph.files, ['/p/a.js', '/p/b.js', '/p/c.js']);
});

test('buildModuleGraph 读不到的文件不进清单（不会 preload 404）', () => {
  const graph = buildModuleGraph({
    indexHtml: '<script type="module" src="./root.js"></script>',
    readFile: (file) => (file === '/p/root.js' ? "import './missing.js';" : null),
    resolve: (_from, spec) => `/p/${spec.replace('./', '')}`,
  });
  assert.deepEqual(graph.files, []);
});

test('toSiteHref 输出与 index.html 同形的相对 URL', () => {
  assert.equal(toSiteHref('/p/public', '/p/public/src/modules/a.js'), './src/modules/a.js');
});

test('renderPreloadLinks / injectPreloadLinks 注入到 </head> 之前', () => {
  const links = renderPreloadLinks(['./src/a.js', './src/b.js']);
  assert.match(links, /^ {2}<link rel="modulepreload" href="\.\/src\/a\.js">\n {2}<link rel="modulepreload" href="\.\/src\/b\.js">\n$/);
  const html = '<html><head><title>t</title></head><body></body></html>';
  const injected = injectPreloadLinks(html, links);
  assert.ok(injected.indexOf('./src/a.js') < injected.indexOf('</head>'));
  assert.equal(injectPreloadLinks(html, ''), html);
});

test('createFirstPaintIndexRenderer：注入、缓存复用、图变化后重建', () => {
  const dir = makeTempDir();
  const publicDir = path.join(dir, 'public');
  writeFile(
    publicDir,
    'index.html',
    '<html><head></head><body><script type="module" src="./src/root.js"></script></body></html>',
  );
  writeFile(publicDir, 'src/root.js', "import './a.js';");
  writeFile(publicDir, 'src/a.js', 'export const a = 1;');

  const renderer = createFirstPaintIndexRenderer({ publicDir, ttlMs: 0 });
  const first = renderer.render(1000);
  assert.ok(first.includes('<link rel="modulepreload" href="./src/a.js">'));
  assert.ok(!first.includes('href="./src/root.js"'), '入口自身不重复 preload');

  // 新增 import 边后，签名变化触发重建，新文件被纳入
  writeFile(publicDir, 'src/a.js', "export const a = 1;\nimport './b.js';");
  writeFile(publicDir, 'src/b.js', 'export const b = 2;');
  const second = renderer.render(2000);
  assert.ok(second.includes('href="./src/b.js"'));

  fs.rmSync(dir, { recursive: true, force: true });
});

test('createFirstPaintIndexRenderer：禁用或 index 缺失时返回 null（回落 static）', () => {
  const dir = makeTempDir();
  const publicDir = path.join(dir, 'public');
  writeFile(publicDir, 'index.html', '<html><head></head></html>');
  assert.equal(createFirstPaintIndexRenderer({ publicDir, enabled: false }).render(), null);
  assert.equal(createFirstPaintIndexRenderer({ publicDir: path.join(dir, 'nope') }).render(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
