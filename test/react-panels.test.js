/**
 * React 面板基建测试（ADR-0044 P6）：
 *   1. 试点插件产物存在且为 ESM（可动态 import，react 运行时自包含）；
 *   2. __clawPanelCss 经 banner 注入且已按 scope 注释作用域化；
 *   3. ensurePanelStyle 的注入 / 复用 / 移除语义（幂等、只清理自己创建的节点）。
 *
 * mountTo / createRoot 的真实渲染属浏览器行为，由 P6 #5 的面板浏览器冒烟覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUNDLE_PATH = resolve('public/src/plugins/react-trial/dist/index.js');
const BUNDLE = pathToFileURL(BUNDLE_PATH).href;

test('react-trial bundle exists after build:react-panels', () => {
  assert.ok(existsSync(BUNDLE_PATH), 'missing public/src/plugins/react-trial/dist/index.js（先跑 npm run build:react-panels）');
});

test('bundle is self-contained ESM with inlined css constant', async () => {
  const source = readFileSync(BUNDLE_PATH, 'utf8');
  assert.match(source, /^const __clawPanelCss = "/, 'banner css constant missing');
  // react 运行时打进产物（宿主不提供）
  assert.match(source, /react\.production|React\s*\.\s*createElement|react-dom/, 'react runtime not bundled');
});

test('plugin module imports and exposes scoped css', async () => {
  const plugin = (await import(BUNDLE)).default;
  assert.equal(plugin.id, 'react-trial');
  const css = plugin.css;
  assert.ok(typeof css === 'string' && css.length > 0, 'css should be non-empty with tailwind.css present');
  // scope 后处理：每个 utility 选择器必须以 .react-trial 开头（后代或复合形态），
  // 不允许脱离 scope 的裸类选择器污染宿主。
  const legalPrefix = /(\.react-trial |\.react-trial)$/;
  const bare = css.split('.text-sm')
    .slice(0, -1) // 每段结尾即一次 .text-sm 出现的前文
    .filter((before) => !legalPrefix.test(before));
  assert.deepEqual(bare, [], 'unscoped .text-sm leaked outside plugin scope');
});

/** 最小 DOM stub：ensurePanelStyle 只用 getElementById / createElement / head.appendChild。 */
function stubDoc() {
  const byId = new Map();
  const created = [];
  const doc = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: () => {
      const el = {
        id: '',
        textContent: '',
        isConnected: false,
        remove() { this.isConnected = false; },
      };
      created.push(el);
      return el;
    },
    head: { appendChild: (el) => { el.isConnected = true; byId.set(el.id, el); return el; } },
  };
  return { doc, created, byId };
}

const { ensurePanelStyle } = await import(BUNDLE);

test('ensurePanelStyle injects once and dispose removes only its own node', () => {
  const { doc, created, byId } = stubDoc();
  const dispose = ensurePanelStyle(doc, 's1', '.a{color:red}');
  assert.equal(dispose.created, true);
  assert.equal(created.length, 1, 'style element created');
  assert.equal(byId.get('s1')?.textContent, '.a{color:red}');
  assert.ok(byId.get('s1')?.isConnected, 'style appended to head');

  dispose();
  assert.equal(byId.get('s1')?.isConnected, false, 'dispose removes the style node');
});

test('ensurePanelStyle is idempotent: second call reuses existing node and dispose is noop', () => {
  const { doc, created } = stubDoc();
  const first = ensurePanelStyle(doc, 's2', '.b{}');
  assert.equal(first.created, true);
  const second = ensurePanelStyle(doc, 's2', '.b{}');
  assert.equal(second.created, false, 'existing node must be reused');
  assert.equal(created.length, 1, 'no duplicate style element');

  second();
  assert.equal(created[0].isConnected, true, 'reuse dispose must not remove the shared node');
  first();
  assert.equal(created[0].isConnected, false, 'creator dispose removes node');
});

test('ensurePanelStyle with empty css is a no-op', () => {
  const { doc, created } = stubDoc();
  const dispose = ensurePanelStyle(doc, 's3', '');
  assert.equal(dispose.created, false);
  assert.equal(created.length, 0);
  dispose();
});
