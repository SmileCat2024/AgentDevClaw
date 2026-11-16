// Markdown bootstrap: escapeHtml and the canonical marked renderer must exist
// before synchronous classic first-paint code invokes renderCurrentMainView().
// Kept classic for synchronous first paint; the same function is the bridge value.
(function () {
  function escapeHtml(text) {
    const str = String(text);
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return str.replace(/[&<>"']/g, m => map[m]);
  }
  window.KernelState.defineKey('markdown-utils', 'escapeHtml', escapeHtml);
  const markdownRenderer = new window.marked.Renderer();
  markdownRenderer.codespan = function(code) {
    const text = typeof code === 'string'
      ? code
      : (code && typeof code === 'object' && 'text' in code
        ? code.text
        : String(code ?? ''));
    return '<code class="inline-code-accent">' + escapeHtml(text) + '</code>';
  };
  markdownRenderer.code = function(code, langArg) {
    const obj = (code && typeof code === 'object' && 'text' in code) ? code : null;
    const text = obj ? String(obj.text ?? '') : String(code ?? '');
    const lang = String((obj ? obj.lang : langArg) ?? '').match(/\S+/)?.[0] || '';
    const codeText = text.replace(/\n$/, '') + '\n';
    let codeHtml = escapeHtml(codeText);
    if (lang && window.hljs.getLanguage(lang)) {
      try { codeHtml = window.hljs.highlight(codeText, { language: lang }).value; } catch (e) {}
    }
    const classAttr = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
    return '<div class="md-code-block"><pre><code' + classAttr + '>'
      + codeHtml
      + '</code></pre>'
      + '<div class="md-code-actions">'
      + '<button type="button" class="message-icon-action is-icon-copy" title="复制代码" data-action="markdown.copyCode"></button>'
      + '</div></div>\n';
  };
  markdownRenderer.html = function(token) {
    const raw = String(token?.raw || '');
    if (/^<claw-display-math\s+data-token="claw-display-math-\d+">$/.test(raw) || raw === '</claw-display-math>') return raw;
    if (/^<claw-guide-img data-token="guide-img-\d+">(?:<\/claw-guide-img>)?$/.test(raw) || raw === '</claw-guide-img>') return raw;
    if (/^<claw-guide-callout data-token="guide-callout-\d+">(?:<\/claw-guide-callout>)?$/.test(raw) || raw === '</claw-guide-callout>') return raw;
    if (/^<claw-guide-imgrow data-token="guide-imgrow-\d+">(?:<\/claw-guide-imgrow>)?$/.test(raw) || raw === '</claw-guide-imgrow>') return raw;
    return escapeHtml(raw);
  };
  window.marked.setOptions({ renderer: markdownRenderer, breaks: true });
  window.KernelState.defineKey('markdown-utils', 'renderer', markdownRenderer);
})();
