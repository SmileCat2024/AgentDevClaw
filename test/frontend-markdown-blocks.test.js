/**
 * markdown-utils 块级切分/重组测试（memo 便签就地编辑的核心正确性）
 *
 * 注入真实 marked（node_modules 与前端 vendor 同源），锁定两件事：
 *   1. 保真性：splitMarkdownBlocks 的 raw 拼接 === 原文——就地编辑
 *      全程只操作源码切片，这是「保存不洗格式」的根基；
 *   2. replaceMarkdownBlock 的替换 / 删除语义（空块删除 + 空行不累积）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

/** 与前端同源的真实 marked + 最小 hljs stub，加载 markdown-utils.js。 */
function loadBlocksModule() {
  const ctx = createFrontendSandbox({
    marked,
    hljs: { getLanguage: () => null, highlight: (c) => ({ value: c }) },
  });
  ctx.loadSource('public/src/modules/markdown-utils.js');
  return ctx;
}

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

describe('splitMarkdownBlocks / joinMarkdownBlocks（保真性）', () => {
  it('raw 拼接 === 原文（全部样例）', () => {
    const ctx = loadBlocksModule();
    for (const src of SAMPLES) {
      assert.equal(
        ctx.run(`joinMarkdownBlocks(splitMarkdownBlocks(${JSON.stringify(src)}))`),
        src,
      );
    }
  });

  it('空串与 null：切分为空数组 / 空串', () => {
    const ctx = loadBlocksModule();
    assert.deepEqual(ctx.run('splitMarkdownBlocks("")'), []);
    assert.equal(ctx.run('joinMarkdownBlocks(splitMarkdownBlocks(null))'), '');
  });

  it('混合内容切出预期块类型序列（space 是独立 token）', () => {
    const ctx = loadBlocksModule();
    const blocks = ctx.run(`splitMarkdownBlocks(${JSON.stringify(SAMPLES[1])})`);
    assert.deepEqual(
      blocks.map((b) => b.type),
      ['heading', 'space', 'blockquote', 'space', 'code', 'space', 'table', 'space', 'hr', 'space', 'paragraph'],
    );
  });

  it('isEditableMarkdownBlock：space 不可编辑，其余可编辑', () => {
    const ctx = loadBlocksModule();
    const blocks = ctx.run(`splitMarkdownBlocks(${JSON.stringify(SAMPLES[1])})`);
    for (const block of blocks) {
      assert.equal(
        ctx.run(`isEditableMarkdownBlock(${JSON.stringify(block)})`),
        block.type !== 'space',
      );
    }
    assert.equal(ctx.run('isEditableMarkdownBlock(null)'), false);
  });
});

describe('replaceMarkdownBlock（就地编辑重组）', () => {
  const SRC = '# 标题\n\n旧段落。\n\n- 列表\n- 项';

  it('替换指定段落：其余块字节不动', () => {
    const ctx = loadBlocksModule();
    // token 序列：heading(0) space(1) paragraph(2) space(3) list(4)
    const next = ctx.run(`replaceMarkdownBlock(${JSON.stringify(SRC)}, 2, '新段落，含 **加粗**。')`);
    assert.equal(next, '# 标题\n\n新段落，含 **加粗**。\n\n- 列表\n- 项');
  });

  it('替换为多段内容：原样落进源码，重新切分自然裂块', () => {
    const ctx = loadBlocksModule();
    const next = ctx.run(`replaceMarkdownBlock(${JSON.stringify(SRC)}, 2, ${JSON.stringify('第一段。\n\n第二段。')})`);
    assert.ok(next.includes('第一段。\n\n第二段。'));
    const reBlocks = ctx.run(`splitMarkdownBlocks(${JSON.stringify(next)})`);
    assert.deepEqual(
      reBlocks.map((b) => b.type),
      ['heading', 'space', 'paragraph', 'space', 'paragraph', 'space', 'list'],
    );
  });

  it('清空提交：块被删除且空行不累积', () => {
    const ctx = loadBlocksModule();
    const next = ctx.run(`replaceMarkdownBlock(${JSON.stringify(SRC)}, 2, '   ')`);
    assert.equal(next, '# 标题\n\n- 列表\n- 项');
    // 反复清块不产生 \n\n\n\n 残留
    const again = ctx.run(`replaceMarkdownBlock(${JSON.stringify(next)}, 0, '')`);
    assert.equal(again, '- 列表\n- 项');
  });

  it('清空唯一块：得到空串', () => {
    const ctx = loadBlocksModule();
    assert.equal(ctx.run(`replaceMarkdownBlock('唯一段落', 0, '')`), '');
  });

  it('清空首块（前无 space）：吞并后侧 space', () => {
    const ctx = loadBlocksModule();
    const next = ctx.run(`replaceMarkdownBlock(${JSON.stringify(SRC)}, 0, '')`);
    assert.equal(next, '旧段落。\n\n- 列表\n- 项');
  });

  it('越界下标：原样返回', () => {
    const ctx = loadBlocksModule();
    assert.equal(ctx.run(`replaceMarkdownBlock(${JSON.stringify(SRC)}, 99, 'x')`), SRC);
    assert.equal(ctx.run(`replaceMarkdownBlock(${JSON.stringify(SRC)}, -1, 'x')`), SRC);
  });

  it('代码块内空行不受空行清理影响（清空相邻段落）', () => {
    const ctx = loadBlocksModule();
    const src = '段落。\n\n```\ncode\n\nblank\n```';
    // token 序列：paragraph(0) space(1) code(2)
    const next = ctx.run(`replaceMarkdownBlock(${JSON.stringify(src)}, 0, '')`);
    assert.equal(next, '```\ncode\n\nblank\n```');
  });
});
