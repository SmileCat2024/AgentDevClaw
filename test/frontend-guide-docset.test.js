/**
 * public/src/plugins/claw-guide/guide-docset.js 的纯函数契约。
 *
 * 该模块已从 classic script 迁移为 ES 模块插件（claw-guide 前端插件），
 * 因此这里改为真实 ESM 导入，不再经 vm 沙箱 eval。被测函数是解析/提取/
 * 排版三类纯逻辑（相对链接解析、锚点 slug、callout 与图片 token、正文装配），
 * 与 DOM 和宿主注入无关——插件对外导出它们正是为了让这些契约可直接验证。
 *
 * marked 用真实实现（验证 token 占位与回填在真实渲染管线里成立），
 * 宿主能力（escapeHtml / markdown 渲染 / 数学排版）以最小 stub 注入，
 * 与生产环境的注入路径一致。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Marked, Renderer } from 'marked';

let pluginModule;
let guide;

const hljsStub = {
  getLanguage() { return null; },
  highlight(code) { return { value: code }; },
  highlightAuto(code) { return { value: code }; },
};

/** 装载插件并注入宿主能力（未被挂载的插件不提供任何能力，先 mount）。 */
async function loadGuideDocset({ realMarked = false } = {}) {
  const markedStub = {
    Renderer: function () {},
    setOptions() {},
    parse(text) { return text; },
  };
  const real = realMarked ? new Marked({ gfm: true, breaks: true }) : null;
  const marked = real
    ? { Renderer: Renderer, setOptions(o) { real.setOptions(o); }, parse(t) { return real.parse(t); } }
    : markedStub;

  // 最小浏览器面：模块顶层不触碰 DOM，但渲染函数内部会用到 document/window
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getElementById() { return null; },
    createElement() { return { style: {}, classList: { add() {}, remove() {} }, appendChild() {} }; },
  };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  globalThis.marked = marked;
  globalThis.hljs = hljsStub;

  // 唯一 query 绕开模块缓存（模块级 guideState 会跨用例累积）
  const url = new URL('../public/src/plugins/claw-guide/guide-docset.js', import.meta.url).href
    + `?case=${Math.random().toString(36).slice(2)}`;
  pluginModule = await import(url);
  pluginModule.default.mount({
    env: {
      language: 'zh',
      escapeHtml: (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[m]),
      enhanceMathInElement() {},
      openImageZoom() {},
      markdown: { render: (t) => marked.parse(String(t ?? '')) },
    },
    workspace: { currentAgent: () => null, rerender() {}, runAction() {} },
  });
  guide = pluginModule;
  return pluginModule;
}

/** 求值纯函数调用表达式（保持原用例的输入文本不变，只是不再经 vm 沙箱）。 */
function run(expr) {
  const names = Object.keys(guide).filter((k) => k !== 'default');
  const fn = new Function(...names, `return (${expr});`);
  return fn(...names.map((k) => guide[k]));
}

// 模块级装载一次基础版（stub marked）；real marked 组各自重新装载
await loadGuideDocset();

// ── resolveGuideHref ──────────────────────────────────────────

describe('guide-docset: resolveGuideHref', () => {
  it('resolves sibling, subfolder and parent docs relative to the current doc', () => {
    assert.equal(
      run('JSON.stringify(resolveGuideHref("./01-x.md", "guide/index.md"))'),
      '{"path":"guide/01-x.md","anchor":""}',
    );
    assert.equal(
      run('JSON.stringify(resolveGuideHref("02-y.md", "guide/index.md"))'),
      '{"path":"guide/02-y.md","anchor":""}',
    );
    assert.equal(
      run('JSON.stringify(resolveGuideHref("sub/deep/z.md", "guide/index.md"))'),
      '{"path":"guide/sub/deep/z.md","anchor":""}',
    );
    assert.equal(
      run('JSON.stringify(resolveGuideHref("../01-x.md", "guide/sub/page.md"))'),
      '{"path":"guide/01-x.md","anchor":""}',
    );
  });

  it('splits in-page anchors and rejects escapes above the guide root', () => {
    assert.equal(
      run('JSON.stringify(resolveGuideHref("#某标题", "guide/index.md"))'),
      '{"path":"","anchor":"某标题"}',
    );
    assert.equal(run('resolveGuideHref("../../../escape.md", "guide/sub/page.md")'), null);
  });

  it('rejects external addresses and URLs', () => {
    assert.equal(run('resolveGuideHref("https://example.com/a.md", "x.md")'), null);
    assert.equal(run('resolveGuideHref("mailto:a@b.c", "x.md")'), null);
    assert.equal(run('resolveGuideHref("data:image/png;base64,xx", "x.md")'), null);
    assert.equal(run('resolveGuideHref("http://x/y.png", "x.md")'), null);
  });

  it('decodes percent-encoded paths from markdown renderers back to tree ids', () => {
    // marked 等渲染器把非 ASCII href 输出为 percent-encoding；目录树 id 是原文，
    // 解析必须归一解码，否则跳转目标与树失配（表现为点击无反应）
    assert.equal(
      run('resolveGuideHref("./01-%E5%9F%BA%E7%A1%80%E6%A6%82%E5%BF%B5.md", "index.md").path'),
      '01-基础概念.md',
    );
    assert.equal(
      run('resolveGuideHref("./%E5%BF%AB%E9%80%9F%E4%B8%8A%E6%89%8B/%E6%A8%A1%E5%9E%8B%E9%85%8D%E7%BD%AE.md", "index.md").path'),
      '快速上手/模型配置.md',
    );
    // 混合形态：文档路径原文 + href 编码
    assert.equal(
      run('resolveGuideHref("./%E6%A8%A1%E5%9E%8B%E9%85%8D%E7%BD%AE.md", "快速上手/智能编码空间.md").path'),
      '快速上手/模型配置.md',
    );
  });

  it('falls back to the raw path when it contains literal percent signs', () => {
    assert.equal(run('resolveGuideHref("./100%.md", "index.md").path'), '100%.md');
  });

  it('decodes encoded anchors and falls back to raw text on bad encoding', () => {
    assert.equal(run('resolveGuideHref("01-x.md#%E6%A0%87%E9%A2%98", "index.md").anchor'), '标题');
    assert.equal(run('resolveGuideHref("01-x.md#%ZZ坏编码", "index.md").anchor'), '%ZZ坏编码');
  });
});

// ── guideSlugify ──────────────────────────────────────────────

describe('guide-docset: guideSlugify (anchor slug normalization)', () => {
  it('matches GitHub/Typora anchor generation for common heading shapes', () => {
    assert.equal(run('guideSlugify("Getting Started")'), 'getting-started');
    assert.equal(run('guideSlugify("1. 安装步骤")'), '1-安装步骤');
    assert.equal(run('guideSlugify("What\'s New?")'), 'whats-new');
    assert.equal(run('guideSlugify("API & 工具")'), 'api--工具');
  });

  it('keeps unicode letters as-is so CJK headings slug to themselves', () => {
    assert.equal(run('guideSlugify("快速开始")'), '快速开始');
    assert.equal(run('guideSlugify("  多 空格 标题 ")'), '多-空格-标题');
  });

  it('strips inline html tags before slugging (heading text may contain markup)', () => {
    assert.equal(run('guideSlugify("<b>Bold</b> Heading")'), 'bold-heading');
  });
});

// ── guide callout（提示块） ───────────────────────────────────

describe('guide-docset: parseGuideCalloutMarker', () => {
  it('parses type, aliases and custom colors with optional title', () => {
    
    // vm 沙箱对象的原型与主上下文不同，deepStrictEqual 会失配，统一走 JSON 比较
    assert.equal(
      run('JSON.stringify(parseGuideCalloutMarker("[!TIP]"))'),
      '{"type":"tip","color":"","title":""}',
    );
    assert.equal(
      run('JSON.stringify(parseGuideCalloutMarker("[!INFO]"))'),
      '{"type":"note","color":"","title":""}',
    );
    assert.equal(
      run('JSON.stringify(parseGuideCalloutMarker("[!DANGER]"))'),
      '{"type":"caution","color":"","title":""}',
    );
    assert.equal(
      run('JSON.stringify(parseGuideCalloutMarker("[!NOTE #4f46e5]"))'),
      '{"type":"note","color":"#4f46e5","title":""}',
    );
    assert.equal(
      run('JSON.stringify(parseGuideCalloutMarker("[!NOTE indigo 自定义标题]"))'),
      '{"type":"note","color":"#4f46e5","title":"自定义标题"}',
    );
    // 标题写在标记后（GitHub/Obsidian 惯用形式）
    assert.equal(
      run('JSON.stringify(parseGuideCalloutMarker("[!TIP] 快捷提示"))'),
      '{"type":"tip","color":"","title":"快捷提示"}',
    );
    assert.equal(
      run('JSON.stringify(parseGuideCalloutMarker("[!NOTE indigo] 标记后标题"))'),
      '{"type":"note","color":"#4f46e5","title":"标记后标题"}',
    );
  });

  it('rejects unknown types, invalid colors and non-marker quotes', () => {
    assert.equal(run('parseGuideCalloutMarker("[!FOO]")'), null);
    assert.equal(run('parseGuideCalloutMarker("普通引用文本")'), null);
    assert.equal(run('parseGuideCalloutMarker("[!TIP #zzz]")').color, '');
  });
});

describe('guide-docset: collectGuideCallouts', () => {
  it('extracts callout blockquotes to tokens and strips quote prefixes', () => {
    
    const result = run(
      'collectGuideCallouts("前文\\n\\n> [!TIP]\\n> 第一段 **加粗**。\\n> 第二段。\\n\\n后文")',
    );
    assert.equal(result.callouts.length, 1);
    assert.equal(result.callouts[0].type, 'tip');
    assert.equal(result.callouts[0].content, '第一段 **加粗**。\n第二段。');
    assert.match(result.markdown, /<claw-guide-callout data-token="guide-callout-0"><\/claw-guide-callout>/);
    assert.ok(!result.markdown.includes('[!TIP]'));
  });

  it('keeps plain blockquotes and code fences untouched', () => {
    
    const result = run(
      'collectGuideCallouts("> 普通引用\\n\\n```md\\n> [!TIP]\\n```")',
    );
    assert.equal(result.callouts.length, 0);
    assert.ok(result.markdown.includes('> 普通引用'));
    assert.ok(result.markdown.includes('> [!TIP]'));
  });
});

describe('guide-docset: buildGuideArticleHtml with callouts (real marked)', () => {
  it('renders callout shell with type, theme color and markdown content', async () => {
    await loadGuideDocset({ realMarked: true });
    
    const html = run(
      'buildGuideArticleHtml({ path: "index.md", title: "t", content: "> [!TIP]\\n> 若需要看价格，请前往[价格页面](https://example.com/pricing)。" }, "claw-guide")',
    );
    assert.match(html, /<div class="guide-callout" data-callout-type="tip" style="--callout-color:#10b981">/);
    assert.match(html, /guide-callout-icon/);
    assert.match(html, /<a href="https:\/\/example\.com\/pricing">价格页面<\/a>/);
    assert.ok(!html.includes('claw-guide-callout'), 'callout token must be fully replaced');
  });

  it('supports custom color and title via marker params', async () => {
    await loadGuideDocset({ realMarked: true });
    
    const html = run(
      'buildGuideArticleHtml({ path: "index.md", title: "t", content: "> [!NOTE violet 注意]\\n> 内容。" }, "claw-guide")',
    );
    assert.match(html, /data-callout-type="note" style="--callout-color:#7c3aed"/);
    assert.match(html, /<div class="guide-callout-title">注意<\/div>/);
  });

  it('renders images inside callout content via the asset url', async () => {
    await loadGuideDocset({ realMarked: true });
    
    const html = run(
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
    
    const { markdown, images } = run(
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
    
    const spec = run('parseGuideImageTokens(["=50%", "center"])');
    assert.equal(spec.width, '50%');
    assert.equal(spec.align, 'center');

    const open = run('parseGuideImageTokens(["=600x"])');
    assert.equal(open.width, '600px');
    assert.equal(open.height, '');
  });

  it('parses raw <img> tags with zoom style (Typora paste)', () => {
    const result = run(
      'collectGuideImages(\'<img src="./assets/p.png" alt="截图" style="zoom: 60%;" />\\n\')',
    );
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].src, './assets/p.png');
    assert.equal(result.images[0].zoom, '60%');
    assert.match(result.markdown, /<claw-guide-img data-token="guide-img-0">/);
  });

  it('leaves code fences untouched', () => {
    const { markdown, images } = run(
      'collectGuideImages("```md\\n![x](./a.png =100x)\\n```")',
    );
    assert.equal(images.length, 0);
    assert.ok(markdown.includes('./a.png'));
  });

  it('does not transform bare http image markdown without special handling', () => {
    // 外站图片也走 token 提取（渲染期决定原样引用），但语法属性解析不受影响
    const result = run('collectGuideImages("![外链](https://example.com/a.png)")');
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].src, 'https://example.com/a.png');
  });
});

describe('guide-docset: collectGuideImages (same-line image rows)', () => {
  it('groups two md images on one physical line into an imgrow token', () => {
    
    const result = run(
      'collectGuideImages("![左](./assets/a.png =320x) ![右](./assets/b.png)")',
    );
    assert.equal(result.images.length, 2);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].images.length, 2);
    assert.match(result.markdown, /<claw-guide-imgrow data-token="guide-imgrow-0"><\/claw-guide-imgrow>/);
    assert.ok(!result.markdown.includes('claw-guide-img '), 'row line must not leak bare image tokens');
  });

  it('groups mixed md syntax and raw <img> tags on one line', () => {
    
    const result = run(
      'collectGuideImages(\'![截图](./assets/a.png) <img src="./assets/b.png" alt="粘贴" style="zoom:50%;" />\')',
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].images.length, 2);
    assert.equal(result.images[0].zoom, '50%');
  });

  it('keeps images on separate lines as standalone blocks', () => {
    
    const result = run(
      'collectGuideImages("![a](./1.png)\\n\\n![b](./2.png)")',
    );
    assert.equal(result.rows.length, 0);
    assert.equal(result.images.length, 2);
    assert.match(result.markdown, /<claw-guide-img data-token="guide-img-0">/);
    assert.match(result.markdown, /<claw-guide-img data-token="guide-img-1">/);
  });
});

describe('guide-docset: buildGuideArticleHtml with image rows (real marked)', () => {
  it('renders a same-line pair into a flex row with two blocks', async () => {
    await loadGuideDocset({ realMarked: true });
    
    const html = run(
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
