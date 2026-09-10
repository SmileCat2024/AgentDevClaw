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
import { Marked, Renderer } from 'marked';
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

/** 真实 marked 管线（markdown-utils.js + guide-docset.js），验证占位 token 透传与回填。 */
function loadGuideDocsetWithRealMarked() {
  const ctx = createFrontendSandbox({
    hljs: {
      getLanguage() { return null; },
      highlight(code) { return { value: code }; },
      highlightAuto(code) { return { value: code }; },
    },
    renderMarkdown(text) { return text; },
    enhanceMathInElement() {},
    CSS: { escape(value) { return String(value); } },
  });
  const realMarked = new Marked({ gfm: true, breaks: true });
  ctx.marked = {
    Renderer: Renderer,
    setOptions(options) { realMarked.setOptions(options); },
    parse(text) { return realMarked.parse(text); },
  };
  ctx.loadSource('public/src/modules/markdown-utils.js');
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

  it('decodes percent-encoded paths from markdown renderers back to tree ids', () => {
    // marked 等渲染器把非 ASCII href 输出为 percent-encoding；目录树 id 是原文，
    // 解析必须归一解码，否则跳转目标与树失配（表现为点击无反应）
    const sandbox = loadGuideDocset();
    assert.equal(
      sandbox.run('resolveGuideHref("./01-%E5%9F%BA%E7%A1%80%E6%A6%82%E5%BF%B5.md", "index.md").path'),
      '01-基础概念.md',
    );
    assert.equal(
      sandbox.run('resolveGuideHref("./%E5%BF%AB%E9%80%9F%E4%B8%8A%E6%89%8B/%E6%A8%A1%E5%9E%8B%E9%85%8D%E7%BD%AE.md", "index.md").path'),
      '快速上手/模型配置.md',
    );
    // 混合形态：文档路径原文 + href 编码
    assert.equal(
      sandbox.run('resolveGuideHref("./%E6%A8%A1%E5%9E%8B%E9%85%8D%E7%BD%AE.md", "快速上手/智能编码空间.md").path'),
      '快速上手/模型配置.md',
    );
  });

  it('falls back to the raw path when it contains literal percent signs', () => {
    const sandbox = loadGuideDocset();
    assert.equal(sandbox.run('resolveGuideHref("./100%.md", "index.md").path'), '100%.md');
  });

  it('decodes encoded anchors and falls back to raw text on bad encoding', () => {
    const sandbox = loadGuideDocset();
    assert.equal(sandbox.run('resolveGuideHref("01-x.md#%E6%A0%87%E9%A2%98", "index.md").anchor'), '标题');
    assert.equal(sandbox.run('resolveGuideHref("01-x.md#%ZZ坏编码", "index.md").anchor'), '%ZZ坏编码');
  });
});

// ── guideSlugify ──────────────────────────────────────────────

describe('guide-docset: guideSlugify (anchor slug normalization)', () => {
  it('matches GitHub/Typora anchor generation for common heading shapes', () => {
    const sandbox = loadGuideDocset();
    assert.equal(sandbox.run('guideSlugify("Getting Started")'), 'getting-started');
    assert.equal(sandbox.run('guideSlugify("1. 安装步骤")'), '1-安装步骤');
    assert.equal(sandbox.run('guideSlugify("What\'s New?")'), 'whats-new');
    assert.equal(sandbox.run('guideSlugify("API & 工具")'), 'api--工具');
  });

  it('keeps unicode letters as-is so CJK headings slug to themselves', () => {
    const sandbox = loadGuideDocset();
    assert.equal(sandbox.run('guideSlugify("快速开始")'), '快速开始');
    assert.equal(sandbox.run('guideSlugify("  多 空格 标题 ")'), '多-空格-标题');
  });

  it('strips inline html tags before slugging (heading text may contain markup)', () => {
    const sandbox = loadGuideDocset();
    assert.equal(sandbox.run('guideSlugify("<b>Bold</b> Heading")'), 'bold-heading');
  });
});

// ── guide callout（提示块） ───────────────────────────────────

describe('guide-docset: parseGuideCalloutMarker', () => {
  it('parses type, aliases and custom colors with optional title', () => {
    const sandbox = loadGuideDocset();
    // vm 沙箱对象的原型与主上下文不同，deepStrictEqual 会失配，统一走 JSON 比较
    assert.equal(
      sandbox.run('JSON.stringify(parseGuideCalloutMarker("[!TIP]"))'),
      '{"type":"tip","color":"","title":""}',
    );
    assert.equal(
      sandbox.run('JSON.stringify(parseGuideCalloutMarker("[!INFO]"))'),
      '{"type":"note","color":"","title":""}',
    );
    assert.equal(
      sandbox.run('JSON.stringify(parseGuideCalloutMarker("[!DANGER]"))'),
      '{"type":"caution","color":"","title":""}',
    );
    assert.equal(
      sandbox.run('JSON.stringify(parseGuideCalloutMarker("[!NOTE #4f46e5]"))'),
      '{"type":"note","color":"#4f46e5","title":""}',
    );
    assert.equal(
      sandbox.run('JSON.stringify(parseGuideCalloutMarker("[!NOTE indigo 自定义标题]"))'),
      '{"type":"note","color":"#4f46e5","title":"自定义标题"}',
    );
    // 标题写在标记后（GitHub/Obsidian 惯用形式）
    assert.equal(
      sandbox.run('JSON.stringify(parseGuideCalloutMarker("[!TIP] 快捷提示"))'),
      '{"type":"tip","color":"","title":"快捷提示"}',
    );
    assert.equal(
      sandbox.run('JSON.stringify(parseGuideCalloutMarker("[!NOTE indigo] 标记后标题"))'),
      '{"type":"note","color":"#4f46e5","title":"标记后标题"}',
    );
  });

  it('rejects unknown types, invalid colors and non-marker quotes', () => {
    const sandbox = loadGuideDocset();
    assert.equal(sandbox.run('parseGuideCalloutMarker("[!FOO]")'), null);
    assert.equal(sandbox.run('parseGuideCalloutMarker("普通引用文本")'), null);
    assert.equal(sandbox.run('parseGuideCalloutMarker("[!TIP #zzz]")').color, '');
  });
});

describe('guide-docset: collectGuideCallouts', () => {
  it('extracts callout blockquotes to tokens and strips quote prefixes', () => {
    const sandbox = loadGuideDocset();
    const result = sandbox.run(
      'collectGuideCallouts("前文\\n\\n> [!TIP]\\n> 第一段 **加粗**。\\n> 第二段。\\n\\n后文")',
    );
    assert.equal(result.callouts.length, 1);
    assert.equal(result.callouts[0].type, 'tip');
    assert.equal(result.callouts[0].content, '第一段 **加粗**。\n第二段。');
    assert.match(result.markdown, /<claw-guide-callout data-token="guide-callout-0"><\/claw-guide-callout>/);
    assert.ok(!result.markdown.includes('[!TIP]'));
  });

  it('keeps plain blockquotes and code fences untouched', () => {
    const sandbox = loadGuideDocset();
    const result = sandbox.run(
      'collectGuideCallouts("> 普通引用\\n\\n```md\\n> [!TIP]\\n```")',
    );
    assert.equal(result.callouts.length, 0);
    assert.ok(result.markdown.includes('> 普通引用'));
    assert.ok(result.markdown.includes('> [!TIP]'));
  });
});

describe('guide-docset: buildGuideArticleHtml with callouts (real marked)', () => {
  it('renders callout shell with type, theme color and markdown content', () => {
    const sandbox = loadGuideDocsetWithRealMarked();
    const html = sandbox.run(
      'buildGuideArticleHtml({ path: "index.md", title: "t", content: "> [!TIP]\\n> 若需要看价格，请前往[价格页面](https://example.com/pricing)。" }, "claw-guide")',
    );
    assert.match(html, /<div class="guide-callout" data-callout-type="tip" style="--callout-color:#10b981">/);
    assert.match(html, /guide-callout-icon/);
    assert.match(html, /<a href="https:\/\/example\.com\/pricing">价格页面<\/a>/);
    assert.ok(!html.includes('claw-guide-callout'), 'callout token must be fully replaced');
  });

  it('supports custom color and title via marker params', () => {
    const sandbox = loadGuideDocsetWithRealMarked();
    const html = sandbox.run(
      'buildGuideArticleHtml({ path: "index.md", title: "t", content: "> [!NOTE violet 注意]\\n> 内容。" }, "claw-guide")',
    );
    assert.match(html, /data-callout-type="note" style="--callout-color:#7c3aed"/);
    assert.match(html, /<div class="guide-callout-title">注意<\/div>/);
  });

  it('renders images inside callout content via the asset url', () => {
    const sandbox = loadGuideDocsetWithRealMarked();
    const html = sandbox.run(
      'buildGuideArticleHtml({ path: "快速上手/a.md", title: "t", content: "> [!WARNING]\\n> ![截图](./assets/shot.png =100x)" }, "claw-guide")',
    );
    assert.match(html, /data-callout-type="warning"/);
    assert.match(html, /src="\/protoclaw\/guide_asset\?agentId=claw-guide&amp;path=%E5%BF%AB%E9%80%9F%E4%B8%8A%E6%89%8B%2Fassets%2Fshot\.png"/);
    assert.ok(!html.includes('claw-guide-img'), 'image token inside callout must be replaced');
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

describe('guide-docset: collectGuideImages (same-line image rows)', () => {
  it('groups two md images on one physical line into an imgrow token', () => {
    const sandbox = loadGuideDocset();
    const result = sandbox.run(
      'collectGuideImages("![左](./assets/a.png =320x) ![右](./assets/b.png)")',
    );
    assert.equal(result.images.length, 2);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].images.length, 2);
    assert.match(result.markdown, /<claw-guide-imgrow data-token="guide-imgrow-0"><\/claw-guide-imgrow>/);
    assert.ok(!result.markdown.includes('claw-guide-img '), 'row line must not leak bare image tokens');
  });

  it('groups mixed md syntax and raw <img> tags on one line', () => {
    const sandbox = loadGuideDocset();
    const result = sandbox.run(
      'collectGuideImages(\'![截图](./assets/a.png) <img src="./assets/b.png" alt="粘贴" style="zoom:50%;" />\')',
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].images.length, 2);
    assert.equal(result.images[0].zoom, '50%');
  });

  it('keeps images on separate lines as standalone blocks', () => {
    const sandbox = loadGuideDocset();
    const result = sandbox.run(
      'collectGuideImages("![a](./1.png)\\n\\n![b](./2.png)")',
    );
    assert.equal(result.rows.length, 0);
    assert.equal(result.images.length, 2);
    assert.match(result.markdown, /<claw-guide-img data-token="guide-img-0">/);
    assert.match(result.markdown, /<claw-guide-img data-token="guide-img-1">/);
  });
});

describe('guide-docset: buildGuideArticleHtml with image rows (real marked)', () => {
  it('renders a same-line pair into a flex row with two blocks', () => {
    const sandbox = loadGuideDocsetWithRealMarked();
    const html = sandbox.run(
      'buildGuideArticleHtml({ path: "新功能/v.md", title: "t", content: "![左](./assets/v0.2.2复制会话id.png) ![右](./assets/v0.2.2会话代入.png)" }, "claw-guide")',
    );
    assert.match(html, /<div class="guide-image-row">/);
    assert.equal((html.match(/guide-image-block/g) || []).length, 2);
    assert.match(html, /path=%E6%96%B0%E5%8A%9F%E8%83%BD%2Fassets%2Fv0\.2\.2%E5%A4%8D%E5%88%B6%E4%BC%9A%E8%AF%9Did\.png/);
    assert.match(html, /assets%2Fv0\.2\.2%E4%BC%9A%E8%AF%9D%E4%BB%A3%E5%85%A5\.png/);
    assert.ok(!html.includes('claw-guide-imgrow'), 'imgrow token must be fully replaced');
    assert.ok(!html.includes('claw-guide-img '), 'inner image tokens must be fully replaced');
  });
});
