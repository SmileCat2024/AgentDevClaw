/**
 * Tests for public/src/modules/guide-docset.js pure functions:
 *   - resolveGuideHref（文档间相对链接解析，含锚点与越界拒绝）
 *   - collectGuideImages（Typora 兼容图片语法提取，含原生 <img> 与代码围栏保护）
 *   - extractGuideHeadings（页内大纲提取）
 *   - parseGuideImageTokens（=WxH 尺寸与对齐修饰）
 *
 * marked / hljs 以最小 stub 注入（模块顶层构造 Renderer，需要最小实现）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadGuideDocset() {
  const ctx = createFrontendSandbox({
    marked: {
      Renderer: function () {},
      setOptions() {},
      parse(text) { return text; },
    },
    hljs: {
      getLanguage() { return null; },
      highlight(code) { return { value: code }; },
      highlightAuto(code) { return { value: code }; },
    },
    renderMarkdown(text) { return text; },
    enhanceMathInElement() {},
    CSS: { escape(value) { return String(value); } },
  });
  ctx.loadSource('public/src/modules/guide-docset.js');
  return ctx;
}

// ── resolveGuideHref ──────────────────────────────────────────

describe('guide-docset: resolveGuideHref', () => {
  it('resolves sibling, subfolder and parent docs relative to the current doc', () => {
    const ctx = loadGuideDocset();
    assert.equal(
      ctx.run('JSON.stringify(resolveGuideHref("./01-x.md", "guide/index.md"))'),
      '{"path":"guide/01-x.md","anchor":""}',
    );
    assert.equal(
      ctx.run('JSON.stringify(resolveGuideHref("02-y.md", "guide/index.md"))'),
      '{"path":"guide/02-y.md","anchor":""}',
    );
    assert.equal(
      ctx.run('JSON.stringify(resolveGuideHref("sub/deep/z.md", "guide/index.md"))'),
      '{"path":"guide/sub/deep/z.md","anchor":""}',
    );
    assert.equal(
      ctx.run('JSON.stringify(resolveGuideHref("../01-x.md", "guide/sub/page.md"))'),
      '{"path":"guide/01-x.md","anchor":""}',
    );
  });

  it('splits in-page anchors and rejects escapes above the guide root', () => {
    const sandbox = loadGuideDocset();
    assert.equal(
      sandbox.run('JSON.stringify(resolveGuideHref("#某标题", "guide/index.md"))'),
      '{"path":"","anchor":"某标题"}',
    );
    assert.equal(sandbox.run('resolveGuideHref("../../../escape.md", "guide/sub/page.md")'), null);
  });

  it('rejects external addresses and URLs', () => {
    const sandbox = loadGuideDocset();
    assert.equal(sandbox.run('resolveGuideHref("https://example.com/a.md", "x.md")'), null);
    assert.equal(sandbox.run('resolveGuideHref("mailto:a@b.c", "x.md")'), null);
    assert.equal(sandbox.run('resolveGuideHref("data:image/png;base64,xx", "x.md")'), null);
    assert.equal(sandbox.run('resolveGuideHref("http://x/y.png", "x.md")'), null);
  });

  it('decodes encoded anchors and falls back to raw text on bad encoding', () => {
    const sandbox = loadGuideDocset();
    assert.equal(sandbox.run('resolveGuideHref("01-x.md#%E6%A0%87%E9%A2%98", "index.md").anchor'), '标题');
    assert.equal(sandbox.run('resolveGuideHref("01-x.md#%ZZ坏编码", "index.md").anchor'), '%ZZ坏编码');
  });
});

// ── collectGuideImages ────────────────────────────────────────

describe('guide-docset: collectGuideImages (markdown syntax)', () => {
  it('extracts md images with Typora size spec and rewrites to tokens', () => {
    const sandbox = loadGuideDocset();
    const { markdown, images } = sandbox.run(
      'collectGuideImages("前文\\n\\n![布局](./assets/a.svg =640x400 center)\\n后文")',
    );
    assert.equal(images.length, 1);
    assert.equal(images[0].src, './assets/a.svg');
    assert.equal(images[0].width, '640px');
    assert.equal(images[0].height, '400px');
    assert.equal(images[0].align, 'center');
    assert.match(markdown, /<claw-guide-img data-token="guide-img-0"><\/claw-guide-img>/);
    assert.ok(!markdown.includes('./assets/a.svg'));
  });

  it('supports percentage width, open width and alignment keywords', () => {
    const sandbox = loadGuideDocset();
    const spec = sandbox.run('parseGuideImageTokens(["=50%", "center"])');
    assert.equal(spec.width, '50%');
    assert.equal(spec.align, 'center');

    const open = sandbox.run('parseGuideImageTokens(["=600x"])');
    assert.equal(open.width, '600px');
    assert.equal(open.height, '');
  });

  it('parses raw <img> tags with zoom style (Typora paste)', () => {
    const result = loadGuideDocset().run(
      'collectGuideImages(\'<img src="./assets/p.png" alt="截图" style="zoom: 60%;" />\\n\')',
    );
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].src, './assets/p.png');
    assert.equal(result.images[0].zoom, '60%');
    assert.match(result.markdown, /<claw-guide-img data-token="guide-img-0">/);
  });

  it('leaves code fences untouched', () => {
    const { markdown, images } = loadGuideDocset().run(
      'collectGuideImages("```md\\n![x](./a.png =100x)\\n```")',
    );
    assert.equal(images.length, 0);
    assert.ok(markdown.includes('./a.png'));
  });

  it('does not transform bare http image markdown without special handling', () => {
    // 外站图片也走 token 提取（渲染期决定原样引用），但语法属性解析不受影响
    const result = loadGuideDocset().run('collectGuideImages("![外链](https://example.com/a.png)")');
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].src, 'https://example.com/a.png');
  });
});
