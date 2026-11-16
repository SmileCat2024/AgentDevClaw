// Native browser ESM/classic integration; static fixture, no Claw or user data.
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
const app = express();
app.use(express.static('public'));
app.use('/vendor/marked/lib', express.static('node_modules/marked/lib'));
app.use('/vendor/hljs', express.static('node_modules/@highlightjs/cdn-assets'));
app.use('/vendor/katex/dist', express.static('node_modules/katex/dist'));
app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html><body>
<div id="chat-container"></div><div class="markdown-body" id="result"></div>
<script src="/vendor/marked/lib/marked.umd.js"></script>
<script src="/vendor/hljs/highlight.min.js"></script>
<script defer src="/vendor/katex/dist/katex.min.js"></script>
<script defer src="/vendor/katex/dist/contrib/auto-render.min.js"></script>
<script src="/src/modules/kernel-state.js"></script>
<script src="/src/modules/action-dispatcher.js"></script>
<script>KernelState.defineKey('i18n-environment', 'currentLanguage', 'zh');</script>
<script src="/src/modules/markdown-bootstrap.js"></script>
<script type="module" src="/src/modules/markdown-utils.js"></script>
<script>document.querySelector('#chat-container').innerHTML = escapeHtml('<ready>'); window.firstPaint = true;</script>
</body></html>`));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
let browser;
let release;
const gate = new Promise((resolve) => { release = resolve; });
try {
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? undefined : 'msedge', executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/src/modules/markdown-utils.js', async (route) => { await gate; await route.continue(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/fixture`, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.firstPaint === true);
  assert.equal(await page.locator('#chat-container').textContent(), '<ready>');
  assert.equal(await page.evaluate(() => typeof window.renderMarkdown), 'undefined');
  release();
  await page.waitForLoadState('load');
  await page.evaluate(() => {
    const source = '---\nname: demo\n---\n\n```js\nconst x = "<";\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$$x^2$$\n\n<script>bad</script>';
    document.querySelector('#result').innerHTML = renderMarkdown(source);
    enhanceMarkdownTables(document.querySelector('#result'));
    window.copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => window.copied.push(text) } });
  });
  assert.equal(await page.locator('#result .md-frontmatter-row').count(), 1);
  assert.equal(await page.locator('#result .katex').count(), 1);
  assert.equal(await page.locator('#result script').count(), 0);
  await page.locator('[data-action="markdown.copyCode"]').click();
  await page.waitForFunction(() => window.copied.length === 1);
  assert.equal(await page.evaluate(() => window.copied[0]), 'const x = "<";');
  await page.locator('[data-action="markdown.copyTable"]').click();
  await page.waitForFunction(() => window.copied.length === 2);
  assert.equal(await page.evaluate(() => window.copied[1]), '| A | B |\n| --- | --- |\n| 1 | 2 |');
  const edited = await page.evaluate(() => {
    const source = '# Title\n\nOriginal\n';
    return replaceMarkdownBlock(source, 2, 'Changed');
  });
  assert.equal(edited, '# Title\n\nChanged');
  assert.deepEqual(errors, []);
  console.log('PASS: delayed Markdown first paint, real KaTeX/highlight rendering, safe HTML, clipboard actions and block editing');
} finally {
  release();
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
