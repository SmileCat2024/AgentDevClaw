import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadMarkdownModule } from './helpers/markdown-esm-loader.js';

const SAMPLES = [
  '# 购物清单\n\n- 牛奶\n- 面包\n\n今天要买 **鸡蛋**。',
  '# 标题\n\n> 引用块\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\n收尾段落。',
  '单段落',
  '# 标题\n正文紧跟标题（无空行）',
  '段一\n\n\n\n段二（多空行间隔）',
  '结尾是列表：\n\n- a\n- b',
  '\n\n开头有空行的正文',
  '1. 有序\n2. 列表\n\n- 无序\n  - 嵌套\n\n- [ ] todo\n- [x] done',
  '含公式 $$x^2$$ 的段落\n\n第二段',
  '```python\ndef f():\n    """代码块里的空行\n\n不能被空行清理波及"""\n```',
  '# tail heading',
];

async function withMarkdown(fn) {
  const loaded = await loadMarkdownModule();
  try { await fn(loaded.module); } finally { loaded.cleanup(); }
}

describe('splitMarkdownBlocks / joinMarkdownBlocks', () => {
  it('raw 拼接还原原文（全部样例）', async () => {
    await withMarkdown(({ splitMarkdownBlocks, joinMarkdownBlocks }) => {
      for (const src of SAMPLES) assert.equal(joinMarkdownBlocks(splitMarkdownBlocks(src)), src);
    });
  });

  it('切出混合内容块类型且仅 space 不可编辑', async () => {
    await withMarkdown(({ splitMarkdownBlocks, isEditableMarkdownBlock }) => {
      const blocks = splitMarkdownBlocks(SAMPLES[1]);
      assert.deepEqual(blocks.map((b) => b.type), ['heading', 'space', 'blockquote', 'space', 'code', 'space', 'table', 'space', 'hr', 'space', 'paragraph']);
      for (const block of blocks) assert.equal(isEditableMarkdownBlock(block), block.type !== 'space');
      assert.equal(isEditableMarkdownBlock(null), false);
    });
  });
});

describe('replaceMarkdownBlock', () => {
  const SRC = '# 标题\n\n旧段落。\n\n- 列表\n- 项';

  it('替换块并保留其他源码切片', async () => {
    await withMarkdown(({ replaceMarkdownBlock }) => {
      assert.equal(replaceMarkdownBlock(SRC, 2, '新段落，含 **加粗**。'), '# 标题\n\n新段落，含 **加粗**。\n\n- 列表\n- 项');
    });
  });

  it('多段替换自然裂块，清空提交吞并相邻空行', async () => {
    await withMarkdown(({ replaceMarkdownBlock, splitMarkdownBlocks }) => {
      const next = replaceMarkdownBlock(SRC, 2, '第一段。\n\n第二段。');
      assert.deepEqual(splitMarkdownBlocks(next).map((b) => b.type), ['heading', 'space', 'paragraph', 'space', 'paragraph', 'space', 'list']);
      assert.equal(replaceMarkdownBlock(SRC, 2, '   '), '# 标题\n\n- 列表\n- 项');
      assert.equal(replaceMarkdownBlock(replaceMarkdownBlock(SRC, 2, ''), 0, ''), '- 列表\n- 项');
    });
  });

  it('空输入与越界下标维持既有语义', async () => {
    await withMarkdown(({ splitMarkdownBlocks, joinMarkdownBlocks, replaceMarkdownBlock }) => {
      assert.deepEqual(splitMarkdownBlocks(''), []);
      assert.equal(joinMarkdownBlocks(splitMarkdownBlocks(null)), '');
      assert.equal(replaceMarkdownBlock(SRC, 99, 'x'), SRC);
      assert.equal(replaceMarkdownBlock(SRC, -1, 'x'), SRC);
      assert.equal(replaceMarkdownBlock('唯一段落', 0, ''), '');
    });
  });
});
