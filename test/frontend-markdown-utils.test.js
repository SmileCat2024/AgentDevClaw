/**
 * Tests for public/src/modules/markdown-utils.js
 *
 * Covers:
 *   - escapeHtml (XSS-critical, extensive boundary tests)
 *   - extractDisplayMathBlocks (LaTeX $$ ... $$ extraction)
 *   - renderMarkdown (end-to-end with mocked marked)
 *   - YAML frontmatter 摘出与呈现（SKILL.md 阅读页，用真实 marked 锚定）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/**
 * Create a sandbox with markdown-utils.js loaded.
 * Provides minimal `marked` and `hljs` stubs so the module's
 * top-level code (Renderer construction, setOptions) executes
 * without error.
 */
function loadMarkdownUtils() {
  const ctx = createFrontendSandbox({
    marked: {
      Renderer: function () {},
      setOptions() {},
      parse(text) { return text; }, // identity — lets us inspect pre/post replacement
    },
    hljs: {
      getLanguage() { return null; },
      highlight(code) { return { value: code }; },
      highlightAuto(code) { return { value: code }; },
    },
  });
  ctx.loadSource('public/src/modules/markdown-utils.js');
  return ctx;
}

// ── escapeHtml (XSS-critical) ──────────────────────────────────────

describe('markdown-utils: escapeHtml', () => {
  it('escapes < and >', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml("<div>")'), '&lt;div&gt;');
  });

  it('escapes double quotes', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml(\'"hello"\')'), '&quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml("it\'s")'), 'it&#39;s');
  });

  it('escapes ampersand', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml("a & b")'), 'a &amp; b');
  });

  it('escapes all five special characters together', () => {
    const ctx = loadMarkdownUtils();
    // Input chars in order: < & > " '
    // Each is replaced left-to-right by the regex
    assert.equal(
      ctx.run('escapeHtml(\'<&>"\\\'\')'),
      '&lt;&amp;&gt;&quot;&#39;'
    );
  });

  it('blocks <script> tag injection', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('escapeHtml("<script>alert(1)</script>")');
    assert.equal(result, '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.ok(!result.includes('<script>'));
  });

  it('blocks <img onerror> injection', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('escapeHtml(\'<img src=x onerror="alert(1)">\')');
    assert.ok(!result.includes('<img'));
    assert.ok(result.includes('&lt;img'));
    assert.ok(result.includes('&quot;alert(1)&quot;'));
  });

  it('blocks nested tag injection', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('escapeHtml("<sCrIpT><svg/onload=alert(1)></sCrIpT>")');
    assert.ok(!result.toLowerCase().includes('<script>'));
    assert.ok(!result.toLowerCase().includes('<svg'));
    assert.ok(result.includes('&lt;'));
  });

  it('blocks javascript: URI in attribute-like content', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('escapeHtml(\'<a href="javascript:alert(1)">click</a>\')');
    assert.ok(!result.includes('href="javascript'));
    assert.ok(result.includes('&lt;a'));
  });

  it('returns empty string for empty input', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml("")'), '');
  });

  it('converts null to "null" (no null guard in module definition)', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml(null)'), 'null');
  });

  it('converts undefined to "undefined" (no undefined guard)', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml(undefined)'), 'undefined');
  });

  it('converts numbers to their string representation', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml(0)'), '0');
    assert.equal(ctx.run('escapeHtml(42)'), '42');
    assert.equal(ctx.run('escapeHtml(-1)'), '-1');
  });

  it('converts booleans to their string representation', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml(true)'), 'true');
    assert.equal(ctx.run('escapeHtml(false)'), 'false');
  });

  it('does not double-escape already-escaped entities', () => {
    const ctx = loadMarkdownUtils();
    // &amp; contains &, so it becomes &amp;amp;
    assert.equal(ctx.run('escapeHtml("&amp;")'), '&amp;amp;');
  });

  it('handles strings with no special characters unchanged', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('escapeHtml("hello world")'), 'hello world');
    assert.equal(ctx.run('escapeHtml("12345")'), '12345');
  });
});

// ── extractDisplayMathBlocks ───────────────────────────────────────

describe('markdown-utils: extractDisplayMathBlocks', () => {
  it('extracts a single $$...$$ block', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('extractDisplayMathBlocks("$$x^2$$")');
    assert.ok(result.blocks);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].latex, 'x^2');
    assert.ok(result.blocks[0].token.startsWith('claw-display-math-'));
  });

  it('extracts multiple math blocks with sequential tokens', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('extractDisplayMathBlocks("$$a$$ and $$b$$")');
    assert.equal(result.blocks.length, 2);
    assert.equal(result.blocks[0].latex, 'a');
    assert.equal(result.blocks[1].latex, 'b');
    assert.notEqual(result.blocks[0].token, result.blocks[1].token);
  });

  it('replaces math blocks with custom element tags in markdown', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('extractDisplayMathBlocks("before $$x$$ after")');
    assert.ok(result.markdown.includes('<claw-display-math'));
    assert.ok(!result.markdown.includes('$$x$$'));
    assert.ok(result.markdown.includes('before'));
    assert.ok(result.markdown.includes('after'));
  });

  it('trims whitespace inside math delimiters', () => {
    const ctx = loadMarkdownUtils();
    const input = '$$  \\frac{1}{2}  $$';
    const result = ctx.run(`extractDisplayMathBlocks(${JSON.stringify(input)})`);
    assert.equal(result.blocks[0].latex, '\\frac{1}{2}');
  });

  it('returns empty blocks array for plain text without $$', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('extractDisplayMathBlocks("just plain text")');
    assert.equal(result.blocks.length, 0);
    assert.equal(result.markdown, 'just plain text');
  });

  it('handles null input as empty string', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('extractDisplayMathBlocks(null)');
    assert.equal(result.blocks.length, 0);
    assert.equal(result.markdown, '');
  });

  it('handles undefined input as empty string', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('extractDisplayMathBlocks(undefined)');
    assert.equal(result.blocks.length, 0);
    assert.equal(result.markdown, '');
  });

  it('does not extract $$ inside fenced code blocks', () => {
    const ctx = loadMarkdownUtils();
    const input = '```\n$$notmath$$\n```';
    const result = ctx.run(`extractDisplayMathBlocks(${JSON.stringify(input)})`);
    assert.equal(result.blocks.length, 0);
    assert.ok(result.markdown.includes('$$notmath$$'));
  });

  it('does not extract $$ inside tilde code blocks', () => {
    const ctx = loadMarkdownUtils();
    const input = '~~~\n$$notmath$$\n~~~';
    const result = ctx.run(`extractDisplayMathBlocks(${JSON.stringify(input)})`);
    assert.equal(result.blocks.length, 0);
    assert.ok(result.markdown.includes('$$notmath$$'));
  });

  it('handles unclosed $$ as plain text', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('extractDisplayMathBlocks("$$ unclosed math")');
    assert.equal(result.blocks.length, 0);
    assert.ok(result.markdown.includes('$$'));
  });

  it('handles escaped \\$\\$ (backslash before $$)', () => {
    const ctx = loadMarkdownUtils();
    const input = '\\$$x$$';
    const result = ctx.run(`extractDisplayMathBlocks(${JSON.stringify(input)})`);
    // The \ before $$ causes it to be skipped; the closing $$ has no opening
    // so no blocks should be extracted
    assert.equal(result.blocks.length, 0);
  });

  it('mixes code blocks and math blocks correctly', () => {
    const ctx = loadMarkdownUtils();
    const input = '```js\nconst x = 1;\n```\n\n$$y = mx + b$$\n\ntext';
    const result = ctx.run(`extractDisplayMathBlocks(${JSON.stringify(input)})`);
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].latex, 'y = mx + b');
    // Code block should be preserved
    assert.ok(result.markdown.includes('const x = 1'));
    // Math should be replaced
    assert.ok(!result.markdown.includes('$$y = mx + b$$'));
  });
});

// ── renderMarkdown ─────────────────────────────────────────────────

describe('markdown-utils: renderMarkdown', () => {
  it('renders plain text through marked.parse', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('renderMarkdown("hello world")');
    assert.equal(result, 'hello world');
  });

  it('replaces math blocks with fallback rendering (no katex)', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('renderMarkdown("$$x^2$$")');
    assert.ok(result.includes('math-render-fallback'));
    assert.ok(result.includes('x^2'));
    assert.ok(!result.includes('<claw-display-math'));
  });

  it('renders multiple math blocks', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('renderMarkdown("$$a$$ mid $$b$$")');
    assert.ok(result.includes('math-render-fallback'));
    // Both a and b should appear in the fallback spans
    assert.ok(result.includes('>a<'));
    assert.ok(result.includes('>b<'));
  });

  it('handles empty string input', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('renderMarkdown("")');
    assert.equal(result, '');
  });

  it('handles null input', () => {
    const ctx = loadMarkdownUtils();
    const result = ctx.run('renderMarkdown(null)');
    // null → extractDisplayMathBlocks converts to '' → marked.parse('') → ''
    assert.equal(result, '');
  });
});

// ── YAML frontmatter（SKILL.md 文档开头）────────────────────────────
// marked 的默认行为是：开头 `---` 渲染成分隔线、name/description 并进同一
// 个标题。阅读页因此出现无名分隔线 + 巨型标题。这里锁定摘出后的键值卡片
// 形态，以及「不是 frontmatter 的分隔线不能误吞」。

describe('markdown-utils: splitMarkdownFrontmatter', () => {
  // 沙箱内返回的对象属于另一个 realm，deepEqual 会因原型不同而失败；
  // 统一在沙箱里取值，只比较纯数据。
  const rowsOf = (ctx, src) =>
    ctx.run(`JSON.parse(JSON.stringify(splitMarkdownFrontmatter(${JSON.stringify(src)}).rows))`);

  it('摘出 name/description，正文从分隔行之后开始', () => {
    const ctx = loadMarkdownUtils();
    const src = '---\nname: demo\ndescription: 一句话说明\n---\n\n# 标题\n';
    const rows = rowsOf(ctx, src);
    assert.deepEqual(rows.map((row) => [row.key, row.value]), [['name', 'demo'], ['description', '一句话说明']]);
    assert.equal(ctx.run(`splitMarkdownFrontmatter(${JSON.stringify(src)}).body`), '\n# 标题\n');
    // head + body 必须还原原文：分块重组（memo 便签回写）依赖这一点
    assert.equal(
      ctx.run(`(() => { const fm = splitMarkdownFrontmatter(${JSON.stringify(src)}); return fm.head + fm.body; })()`),
      src,
    );
  });

  it('去掉值两端的引号，保留引号内的冒号', () => {
    const ctx = loadMarkdownUtils();
    const src = '---\ndescription: "使用 a: b 的形式"\nsingle: \'x\'\n---\n';
    assert.deepEqual(rowsOf(ctx, src).map((row) => row.value), ['使用 a: b 的形式', 'x']);
  });

  it('折叠标量（>）与列表项归入同一键', () => {
    const ctx = loadMarkdownUtils();
    const src = '---\ndescription: >\n  第一行\n  第二行\ntags:\n  - a\n  - b\n---\n';
    const rows = rowsOf(ctx, src);
    assert.equal(rows[0].value, '第一行 第二行');
    assert.equal(rows[1].value, '- a\n- b');
  });

  it('普通文档开头的分隔线不算 frontmatter', () => {
    const ctx = loadMarkdownUtils();
    const src = '---\n\n正文第一段。\n\n---\n\n第二段。\n';
    assert.equal(ctx.run(`splitMarkdownFrontmatter(${JSON.stringify(src)})`), null);
  });

  it('未闭合的 --- 不算 frontmatter', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('splitMarkdownFrontmatter("---\\nname: x\\n")'), null);
  });

  it('无 frontmatter 的文档返回 null', () => {
    const ctx = loadMarkdownUtils();
    assert.equal(ctx.run('splitMarkdownFrontmatter("# 标题\\n")'), null);
    assert.equal(ctx.run('splitMarkdownFrontmatter("")'), null);
  });
});

describe('markdown-utils: renderMarkdown 的 frontmatter 呈现', () => {
  function loadWithMarked() {
    const ctx = createFrontendSandbox({
      marked,
      hljs: { getLanguage: () => null, highlight: (code) => ({ value: code }) },
    });
    ctx.loadSource('public/src/modules/markdown-utils.js');
    return ctx;
  }

  it('渲染为键值卡片，不再出现分隔线与元数据标题', () => {
    const ctx = loadWithMarked();
    const src = '---\nname: demo\ndescription: 一句话说明\n---\n\n# 正文标题\n';
    const html = ctx.run(`renderMarkdown(${JSON.stringify(src)})`);
    assert.ok(html.startsWith('<div class="md-frontmatter">'));
    assert.ok(html.includes('<span class="md-frontmatter-key">name</span>'));
    assert.ok(html.includes('<span class="md-frontmatter-value">demo</span>'));
    assert.ok(!html.includes('<hr>'));
    assert.ok(!html.includes('<h2>name:'));
    assert.ok(html.includes('<h1>正文标题</h1>'));
  });

  it('值里的行内代码与链接按行内 markdown 渲染', () => {
    const ctx = loadWithMarked();
    const src = '---\ndescription: 见 `SKILL.md` 与 [文档](https://example.com)\n---\n';
    const html = ctx.run(`renderMarkdown(${JSON.stringify(src)})`);
    assert.ok(html.includes('<code class="inline-code-accent">SKILL.md</code>'));
    assert.ok(html.includes('href="https://example.com"'));
  });

  it('值里的 HTML 仍被转义（不引入注入面）', () => {
    const ctx = loadWithMarked();
    const src = '---\nname: <img src=x onerror=alert(1)>\n---\n';
    const html = ctx.run(`renderMarkdown(${JSON.stringify(src)})`);
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
  });

  it('普通文档开头的分隔线照旧渲染成 <hr>', () => {
    const ctx = loadWithMarked();
    const html = ctx.run('renderMarkdown("---\\n\\n正文。\\n")');
    assert.ok(html.includes('<hr>'));
    assert.ok(!html.includes('md-frontmatter'));
  });
});
