// markdown-utils.js
// Phase 2d-1: Markdown / 数学公式渲染（Domain O-a）
// 从 app-ui.js 提取的渲染工具函数

const renderer = new marked.Renderer();

renderer.codespan = function(code) {
  const text = typeof code === 'string'
    ? code
    : (code && typeof code === 'object' && 'text' in code
      ? code.text
      : String(code ?? ''));
  return '<code class="inline-code-accent">' + escapeHtml(text) + '</code>';
};

function escapeHtml(text) {
  const str = String(text);
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return str.replace(/[&<>"']/g, m => map[m]);
}

renderer.html = function(token) {
  const raw = String(token?.raw || '');
  if (
    /^<claw-display-math\s+data-token="claw-display-math-\d+">$/.test(raw)
    || raw === '</claw-display-math>'
  ) {
    return raw;
  }
  return escapeHtml(raw);
};

marked.setOptions({
  renderer,
  highlight: function(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true
});

function extractDisplayMathBlocks(text) {
  const source = String(text ?? '');
  const segments = source.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  const blocks = [];
  let index = 0;

  const transformSegment = (segment) => {
    let output = '';
    let cursor = 0;

    while (cursor < segment.length) {
      const start = segment.indexOf('$$', cursor);
      if (start === -1) {
        output += segment.slice(cursor);
        break;
      }

      if (start > 0 && segment[start - 1] === '\\') {
        output += segment.slice(cursor, start + 2);
        cursor = start + 2;
        continue;
      }

      const end = segment.indexOf('$$', start + 2);
      if (end === -1) {
        output += segment.slice(cursor);
        break;
      }

      const latex = segment.slice(start + 2, end).trim();
      const token = `claw-display-math-${index++}`;
      blocks.push({ token, latex });
      output += segment.slice(cursor, start);
      output += `\n\n<claw-display-math data-token="${token}"></claw-display-math>\n\n`;
      cursor = end + 2;
    }

    return output;
  };

  const markdown = segments.map((segment) => {
    if (!segment) return '';
    if (segment.startsWith('```') || segment.startsWith('~~~')) {
      return segment;
    }
    return transformSegment(segment);
  }).join('');

  return { markdown, blocks };
}

function renderDisplayMathLatex(latex) {
  if (window.katex?.renderToString) {
    try {
      return katex.renderToString(latex, {
        displayMode: true,
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
      });
    } catch (error) {
      console.warn('Display math render failed:', error);
    }
  }
  return `<span class="math-render-fallback">${escapeHtml(latex)}</span>`;
}

function renderMarkdown(text) {
  const { markdown, blocks } = extractDisplayMathBlocks(text);
  let html = marked.parse(markdown);
  blocks.forEach(({ token, latex }) => {
    const rendered = `<div class="katex-display-block">${renderDisplayMathLatex(latex)}</div>`;
    const tagPattern = new RegExp(`<claw-display-math\\s+data-token="${token}"><\\/claw-display-math>`, 'g');
    const wrappedTagPattern = new RegExp(`<p><claw-display-math\\s+data-token="${token}"><\\/claw-display-math><\\/p>`, 'g');
    html = html.replace(wrappedTagPattern, rendered);
    html = html.replace(tagPattern, rendered);
  });
  return html;
}

function enhanceMathInElement(root) {
  if (!root || typeof renderMathInElement !== 'function') {
    return;
  }

  const markdownRoots = root.matches?.('.markdown-body')
    ? [root]
    : Array.from(root.querySelectorAll?.('.markdown-body') || []);

  markdownRoots.forEach((element) => {
    if (!element || element.dataset.mathEnhanced === 'true') {
      return;
    }
    try {
      renderMathInElement(element, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false },
        ],
        throwOnError: false,
        strict: 'ignore',
        output: 'htmlAndMathml',
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
        ignoredClasses: ['katex'],
      });
      element.dataset.mathEnhanced = 'true';
    } catch (error) {
      console.warn('Math render failed:', error);
    }
  });
}

window.addEventListener('load', () => {
  enhanceMathInElement(document.body);
});
