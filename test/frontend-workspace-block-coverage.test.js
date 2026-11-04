/**
 * 工作空间 block 分发覆盖一致性。
 *
 * 防的回归：宿主把 renderWorkspaceBlock 的 if 链换成 ClawHost.blocks 查表
 * （f9c8e104）时，coder-threads 的分发被删除且无人接管，coder 首页整体
 * 报「未知区块类型」——因 coder on-demand 不可见而漏过浏览器验收，数日
 * 后才被发现。本测试把「每个 metadata 声明的 block type 必须有注册方」
 * 变成静态事实断言：注册方 = 宿主基础组件（app-ui.js 的 registerPrimitive）
 * 或已登记前端插件的 blocks 声明（public/src/plugins/<name>/index.js，经
 * plugin-manifest.js 按 agentId 装载）。
 *
 * 静态解析（正则）在这里是合适的层次：注册形态在源码里规整且集中，
 * 不需要真实浏览器；新增 block type 漏注册时会在本测试先行失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PREBUILT_DIR = path.join(ROOT, 'prebuilt-agents');
const APP_UI = path.join(ROOT, 'public', 'src', 'app-ui.js');
const MANIFEST = path.join(ROOT, 'public', 'src', 'modules', 'plugin-manifest.js');

async function readText(file) {
  return readFile(file, 'utf8');
}

/** 收集全部 prebuilt metadata 声明的 ui.home.blocks type：Map<type, agentId[]> */
async function collectDeclaredBlockTypes() {
  const declared = new Map();
  for (const tier of readdirSync(PREBUILT_DIR)) {
    const tierDir = path.join(PREBUILT_DIR, tier);
    if (!statSync(tierDir).isDirectory()) continue;
    for (const name of readdirSync(tierDir)) {
      const metaFile = path.join(tierDir, name, 'metadata.json');
      if (!existsSync(metaFile)) continue;
      const meta = JSON.parse(await readText(metaFile));
      const blocks = meta?.ui?.home?.blocks;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        const type = String(block?.type || '').trim();
        if (!type) continue;
        if (!declared.has(type)) declared.set(type, []);
        declared.get(type).push(meta.id || `${tier}/${name}`);
      }
    }
  }
  return declared;
}

/** 宿主基础组件清单：app-ui.js 中 registerPrimitive('xxx', ...) 静态提取 */
async function collectPrimitiveTypes() {
  const source = await readText(APP_UI);
  const types = new Set([...source.matchAll(/registerPrimitive\('([^']+)',/g)].map((m) => m[1]));
  return types;
}

/** 已登记插件的 blocks 声明：manifest 的 agentId → 插件文件 → blocks 键 */
async function collectPluginBlockTypes() {
  const source = await readText(MANIFEST);
  const entries = [...source.matchAll(/url:\s*'([^']+)'/g)].map((m) => m[1]);
  const blocksByPlugin = new Map();
  for (const url of entries) {
    const file = path.join(ROOT, 'public', url.replace(/^\//, '').replace(/\//g, path.sep));
    assert.ok(existsSync(file), `plugin-manifest 登记的插件文件不存在：${url}`);
    const pluginSource = await readText(file);
    const blocksMatch = pluginSource.match(/blocks:\s*\{([\s\S]*?)\n\s*\},/);
    const types = blocksMatch
      ? [...blocksMatch[1].matchAll(/'([^']+)':/g)].map((m) => m[1])
      : [];
    assert.ok(types.length > 0, `插件 ${url} 未声明任何 block（blocks 段解析失败或为空）`);
    blocksByPlugin.set(url, types);
  }
  return blocksByPlugin;
}

test('每个 metadata 声明的 block type 都有注册方（primitive 或前端插件）', async () => {
  const [declared, primitives, pluginBlocks] = await Promise.all([
    collectDeclaredBlockTypes(),
    collectPrimitiveTypes(),
    collectPluginBlockTypes(),
  ]);
  const pluginTypes = new Set([...pluginBlocks.values()].flat());

  const missing = [];
  for (const [type, agents] of declared) {
    if (!primitives.has(type) && !pluginTypes.has(type)) {
      missing.push(`${type}（声明于 ${agents.join(', ')}）`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `以下 block type 无注册方，相关 APP 首页会报「未知区块类型」：\n  ${missing.join('\n  ')}\n`
    + `注册方 = app-ui.js registerPrimitive ∪ plugins/*/index.js blocks。`,
  );
});

test('插件 blocks 键与 metadata 声明对齐（插件声明了就要被某 APP 使用）', async () => {
  const [declared, pluginBlocks] = await Promise.all([
    collectDeclaredBlockTypes(),
    collectPluginBlockTypes(),
  ]);
  const declaredTypes = new Set(declared.keys());
  const orphan = [];
  for (const [url, types] of pluginBlocks) {
    for (const type of types) {
      if (!declaredTypes.has(type)) orphan.push(`${type}（${url}）`);
    }
  }
  assert.deepEqual(orphan, [], '插件声明了无人使用的 block type（死注册或 metadata 漏声明）');
});
