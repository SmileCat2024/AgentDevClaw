import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMarkdownModule } from './helpers/markdown-esm-loader.js';

async function withMarkdown(fn, options) {
  const loaded = await loadMarkdownModule(options);
  try { await fn(loaded.module, loaded); } finally { loaded.cleanup(); }
}

describe('HTML escaping', () => {
  const cases = [
    ['angle brackets', '<div>', '&lt;div&gt;'],
    ['double quotes', '"hello"', '&quot;hello&quot;'],
    ['single quotes', "it's", 'it&#39;s'],
    ['ampersand', 'a & b', 'a &amp; b'],
    ['all five characters', '<&>"\'', '&lt;&amp;&gt;&quot;&#39;'],
    ['script injection', '<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['attribute injection', '<img src=x onerror="alert(1)">', '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'],
    ['nested tags', '<sCrIpT><svg/onload=alert(1)></sCrIpT>', '&lt;sCrIpT&gt;&lt;svg/onload=alert(1)&gt;&lt;/sCrIpT&gt;'],
    ['attribute-like URI', '<a href="javascript:alert(1)">click</a>', '&lt;a href=&quot;javascript:alert(1)&quot;&gt;click&lt;/a&gt;'],
    ['empty', '', ''], ['null', null, 'null'], ['undefined', undefined, 'undefined'],
    ['zero', 0, '0'], ['positive number', 42, '42'], ['negative number', -1, '-1'],
    ['true', true, 'true'], ['false', false, 'false'],
    ['existing entities are escaped again', '&amp;', '&amp;amp;'],
    ['ordinary text', 'hello world 12345', 'hello world 12345'],
  ];
  for (const [name, input, expected] of cases) {
    it(name, async () => withMarkdown(({ escapeHtml }) => assert.equal(escapeHtml(input), expected)));
  }
});

describe('display math extraction', () => {
  const cases = [
    ['single', '$$x^2$$', ['x^2']],
    ['multiple', '$$a$$ and $$b$$', ['a', 'b']],
    ['trimmed latex', '$$  \\frac{1}{2}  $$', ['\\frac{1}{2}']],
    ['plain text', 'just plain text', []], ['null', null, []], ['undefined', undefined, []],
    ['backtick fence', '```\n$$notmath$$\n```', []],
    ['tilde fence', '~~~\n$$notmath$$\n~~~', []],
    ['unclosed', '$$ unclosed math', []], ['escaped opening', '\\$$x$$', []],
    ['mixed code and math', '```js\nconst x = 1;\n```\n\n$$y = mx + b$$\n\ntext', ['y = mx + b']],
  ];
  for (const [name, input, expected] of cases) {
    it(name, async () => withMarkdown(({ extractDisplayMathBlocks }) => {
      const result = extractDisplayMathBlocks(input);
      assert.deepEqual(result.blocks.map((block) => block.latex), expected);
      assert.equal(new Set(result.blocks.map((block) => block.token)).size, expected.length);
      if (!expected.length) assert.equal(result.markdown, String(input ?? ''));
      for (const block of result.blocks) {
        assert.match(block.token, /^claw-display-math-\d+$/);
        assert.ok(result.markdown.includes(`data-token="${block.token}"`));
      }
      if (name === 'mixed code and math') assert.ok(result.markdown.includes('const x = 1;'));
    }));
  }
  it('preserves surrounding text and replaces only the math delimiter region', async () => withMarkdown(({ extractDisplayMathBlocks }) => {
    const result = extractDisplayMathBlocks('before $$x$$ after');
    assert.ok(result.markdown.startsWith('before '));
    assert.ok(result.markdown.endsWith(' after'));
    assert.ok(!result.markdown.includes('$$x$$'));
  }));
});

describe('Markdown rendering', () => {
  it('renders normal text through the real parser', async () => withMarkdown(({ renderMarkdown }) => {
    assert.equal(renderMarkdown('hello world'), '<p>hello world</p>\n');
  }));
  it('replaces math placeholders with safe fallback markup without KaTeX', async () => withMarkdown(({ renderMarkdown }) => {
    const html = renderMarkdown('$$<unsafe>$$ mid $$b$$');
    assert.ok(html.includes('math-render-fallback'));
    assert.ok(html.includes('&lt;unsafe&gt;'));
    assert.ok(html.includes('>b<'));
    assert.ok(!html.includes('<unsafe>'));
    assert.ok(!html.includes('<claw-display-math'));
  }));
  for (const value of ['', null, undefined]) {
    it(`empty input ${String(value)}`, async () => withMarkdown(({ renderMarkdown }) => assert.equal(renderMarkdown(value), '')));
  }
  it('uses KaTeX when present and falls back safely on render failure', async () => withMarkdown(({ renderMarkdown }) => {
    const calls = [];
    window.katex = { renderToString(latex, options) { calls.push({ latex, options }); return '<span class="katex">rendered</span>'; } };
    assert.ok(renderMarkdown('$$x^2$$').includes('<span class="katex">rendered</span>'));
    assert.equal(calls[0].latex, 'x^2');
    assert.equal(calls[0].options.displayMode, true);
    window.katex.renderToString = () => { throw new Error('bad formula'); };
    assert.ok(renderMarkdown('$$<unsafe>$$').includes('&lt;unsafe&gt;'));
  }));
  it('uses safe renderer hooks for code, HTML and table actions', async () => withMarkdown(({ renderMarkdown }) => {
    const html = renderMarkdown('`<tag>`\n\n```js\nconst x = "<";\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>');
    for (const fragment of ['inline-code-accent', 'md-code-block', 'md-table-block', 'markdown.copyCode', 'markdown.copyTable']) assert.ok(html.includes(fragment));
    assert.ok(!html.includes('<tag>'));
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('const x = &quot;&lt;&quot;;'));
  }));
});

describe('frontmatter boundaries and rendering', () => {
  it('extracts metadata and retains the original source boundary', async () => withMarkdown(({ splitMarkdownFrontmatter }) => {
    const source = '---\nname: demo\ndescription: 一句话说明\n---\n\n# 标题\n';
    const fm = splitMarkdownFrontmatter(source);
    assert.deepEqual(fm.rows.map(({ key, value }) => ({ key, value })), [{ key: 'name', value: 'demo' }, { key: 'description', value: '一句话说明' }]);
    assert.equal(fm.body, '\n# 标题\n');
    assert.equal(fm.head + fm.body, source);
  }));
  it('unquotes values without losing internal colons', async () => withMarkdown(({ splitMarkdownFrontmatter }) => {
    assert.deepEqual(splitMarkdownFrontmatter('---\ndescription: "使用 a: b 的形式"\nsingle: \'x\'\n---\n').rows.map((row) => row.value), ['使用 a: b 的形式', 'x']);
  }));
  it('folds multiline scalars and keeps list items on the same key', async () => withMarkdown(({ splitMarkdownFrontmatter }) => {
    const fm = splitMarkdownFrontmatter('---\ndescription: >\n  第一行\n  第二行\ntags:\n  - a\n  - b\n---\n');
    assert.equal(fm.rows[0].value, '第一行 第二行');
    assert.equal(fm.rows[1].value, '- a\n- b');
  }));
  for (const [name, input] of [
    ['ordinary opening rule', '---\n\n正文第一段。\n\n---\n\n第二段。\n'],
    ['unclosed metadata', '---\nname: x\n'], ['normal document', '# 标题\n'], ['empty document', ''],
  ]) it(name, async () => withMarkdown(({ splitMarkdownFrontmatter }) => assert.equal(splitMarkdownFrontmatter(input), null)));
  it('renders metadata cards without a spurious heading or rule', async () => withMarkdown(({ renderMarkdown }) => {
    const html = renderMarkdown('---\nname: demo\ndescription: 一句话说明\n---\n\n# 正文标题\n');
    assert.ok(html.startsWith('<div class="md-frontmatter">'));
    assert.ok(html.includes('<span class="md-frontmatter-key">name</span>'));
    assert.ok(html.includes('<span class="md-frontmatter-value">demo</span>'));
    assert.ok(!html.includes('<hr>'));
    assert.ok(!html.includes('<h2>name:'));
    assert.ok(html.includes('<h1>正文标题</h1>'));
  }));
  it('renders inline code and links in metadata values', async () => withMarkdown(({ renderMarkdown }) => {
    const html = renderMarkdown('---\ndescription: 见 `SKILL.md` 与 [文档](https://example.com)\n---\n');
    assert.ok(html.includes('<code class="inline-code-accent">SKILL.md</code>'));
    assert.ok(html.includes('href="https://example.com"'));
  }));
  it('escapes metadata HTML', async () => withMarkdown(({ renderMarkdown }) => {
    const html = renderMarkdown('---\nname: <img src=x onerror=alert(1)>\n---\n');
    assert.ok(html.includes('&lt;img'));
    assert.ok(!html.includes('<img'));
  }));
  it('preserves an ordinary opening rule', async () => withMarkdown(({ renderMarkdown }) => {
    const html = renderMarkdown('---\n\n正文。\n');
    assert.ok(html.includes('<hr>'));
    assert.ok(!html.includes('md-frontmatter'));
  }));
});

describe('Markdown interaction boundaries', () => {
  it('resets only the zoom clone transform, not the source table', async () => {
    const table = { style: { transform: 'translateX(-120px)' }, cloneNode() { return { style: { ...this.style } }; } };
    const created = [];
    await withMarkdown(({ openTableZoom }) => {
      openTableZoom({ closest: () => ({ querySelector: () => table }) });
      assert.equal(created[1].children[0].style.transform, '');
      assert.notEqual(created[1].children[0], table);
      assert.equal(table.style.transform, 'translateX(-120px)');
    }, { document: { getElementById: () => null, createElement() {
      const el = { style: {}, children: [], appendChild(child) { this.children.push(child); }, remove() {} };
      created.push(el); return el;
    } } });
  });
  it('copies code and table text through the registered action handlers', async () => {
    const copied = [];
    const buttons = [];
    await withMarkdown(async (_module, loaded) => {
      const table = { rows: [ { cells: [{ textContent: 'A|B' }, { textContent: 'C\nD' }] }, { cells: [{ textContent: '1' }, { textContent: '2' }] } ] };
      const code = { textContent: 'const x = 1;\n' };
      try {
        for (const [name, source] of [['copyTable', table], ['copyCode', code]]) {
          const btn = { classList: { add() {}, remove() {} }, closest: () => ({ querySelector: () => source }) };
          buttons.push(btn);
          await loaded.registeredActions[`markdown.${name}`](btn);
        }
        assert.deepEqual(copied, ['| A\\|B | C D |\n| --- | --- |\n| 1 | 2 |', 'const x = 1;']);
      } finally { for (const btn of buttons) clearTimeout(btn._copyResetTimer); }
    }, { window: { navigator: { clipboard: { writeText: async (text) => copied.push(text) } }, isSecureContext: true } });
  });
  it('enhances math once and installs load-time enhancement', async () => {
    const calls = [];
    const root = { dataset: {}, matches: () => true };
    await withMarkdown(({ enhanceMathInElement }, loaded) => {
      enhanceMathInElement(root);
      enhanceMathInElement(root);
      assert.equal(calls.length, 1);
      assert.strictEqual(calls[0].element, root);
      assert.equal(root.dataset.mathEnhanced, 'true');
      assert.ok(calls[0].options.delimiters.some(({ left, right, display }) => left === '$$' && right === '$$' && display));
      loaded.dispatchLoad();
      assert.equal(calls.length, 2, 'load listener must enhance the document markdown roots');
    }, { window: { renderMathInElement: (element, options) => calls.push({ element, options }) },
      document: { body: { matches: () => false, querySelectorAll: () => [{ dataset: {} }] }, getElementById: () => null } });
  });
});
