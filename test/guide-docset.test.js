/**
 * Tests for server/routes/guide.js pure logic:
 *   - sanitizeGuideRelativePath（路径穿越防护）
 *   - resolveGuideFileWithinRoot（realpath 越界与缺失文件行为）
 *   - stripGuideFrontmatter / extractGuideTitle / extractGuideHeadings
 *   - buildGuideTree（目录树扫描、md 过滤、空目录剔除、数字前缀排序、.order 索引文件排序）
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  sanitizeGuideRelativePath,
  resolveGuideFileWithinRoot,
  stripGuideFrontmatter,
  extractGuideTitle,
  extractGuideHeadings,
  buildGuideTree,
  guideNameCompare,
  parseGuideOrderFile,
} from '../server/routes/guide.js';

const tmpDirs = [];

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'guide-test-'));
}

function write(relative, content = '') {
  const target = path.join(tmpRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, relative), content);
  return target;
}

let tmpRoot;

before(() => {
  tmpRoot = makeTmpDir();
  tmpDirs.push(tmpRoot);
});

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('guide: sanitizeGuideRelativePath', () => {
  it('keeps normal relative paths', () => {
    assert.equal(sanitizeGuideRelativePath('assets/demo.png'), 'assets/demo.png');
    assert.equal(sanitizeGuideRelativePath('./assets/demo.png'), 'assets/demo.png');
    assert.equal(sanitizeGuideRelativePath('01-基础概念.md'), '01-基础概念.md');
  });

  it('normalizes backslashes and rejects leading slashes', () => {
    assert.equal(sanitizeGuideRelativePath('assets\\demo.png'), 'assets/demo.png');
    // 前导 / 视为绝对路径：本接口的路径都相对指南根解析
    assert.equal(sanitizeGuideRelativePath('/assets/demo.png'), null);
  });

  it('rejects traversal segments', () => {
    assert.equal(sanitizeGuideRelativePath('../outside.md'), null);
    assert.equal(sanitizeGuideRelativePath('a/../../b.md'), null);
    assert.equal(sanitizeGuideRelativePath('%2e%2e/secret'), null);
    assert.equal(sanitizeGuideRelativePath('..\\windows\\system32'), null);
  });

  it('rejects absolute paths and drive letters', () => {
    assert.equal(sanitizeGuideRelativePath('/etc/passwd'), null);
    assert.equal(sanitizeGuideRelativePath('C:\\Users\\x\\img.png'), null);
    assert.equal(sanitizeGuideRelativePath('C:/Users/x/img.png'), null);
  });

  it('rejects empty and null-byte paths', () => {
    assert.equal(sanitizeGuideRelativePath(''), null);
    assert.equal(sanitizeGuideRelativePath('   '), null);
    assert.equal(sanitizeGuideRelativePath('a\0b'), null);
  });

  it('keeps literal percent filenames when decode fails (qs already decoded)', () => {
    // 文件名如 100%.md：二次 decodeURIComponent 抛 URIError 时回退原始串
    assert.equal(sanitizeGuideRelativePath('100%.md'), '100%.md');
    // 合法编码仍然正常解码（%25 → %）
    assert.equal(sanitizeGuideRelativePath('progress/50%25.md'), 'progress/50%.md');
  });
});

describe('guide: resolveGuideFileWithinRoot', () => {
  before(() => {
    write('index.md', '# 根文档');
    write('sub/inner.md', '# 子文档');
    write('sub/assets/pic.png', 'fake-png');
  });

  it('resolves existing files inside the root', async () => {
    const resolved = await resolveGuideFileWithinRoot(tmpRoot, 'sub/assets/pic.png');
    assert.ok(resolved);
    assert.equal(resolved.relative, 'sub/assets/pic.png');
    assert.ok(fs.existsSync(resolved.absolute));
  });

  it('normalizes ../ navigation that stays inside the root', async () => {
    const resolved = await resolveGuideFileWithinRoot(tmpRoot, 'sub/../index.md');
    assert.ok(resolved);
    assert.equal(resolved.relative, 'index.md');
  });

  it('resolves missing files inside the root (for placeholder rendering)', async () => {
    const resolved = await resolveGuideFileWithinRoot(tmpRoot, 'not-exists.png');
    assert.ok(resolved);
    assert.ok(resolved.absolute.startsWith(path.resolve(tmpRoot)));
  });

  it('rejects traversal outside the root', async () => {
    assert.equal(await resolveGuideFileWithinRoot(tmpRoot, '../outside.md'), null);
    assert.equal(await resolveGuideFileWithinRoot(tmpRoot, 'sub/../../outside.md'), null);
  });

  it('rejects symlink escape', async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-escape-'));
    tmpDirs.push(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
    const linkPath = path.join(tmpRoot, 'evil');
    try {
      fs.symlinkSync(outsideDir, linkPath, 'dir');
    } catch {
      // 文件系统不支持 symlink 时跳过该用例
      return;
    }
    const resolved = await resolveGuideFileWithinRoot(tmpRoot, 'evil/secret.txt');
    assert.equal(resolved, null);
  });

  it('rejects empty paths', async () => {
    assert.equal(await resolveGuideFileWithinRoot(tmpRoot, ''), null);
    assert.equal(await resolveGuideFileWithinRoot(tmpRoot, null), null);
  });
});

describe('guide: frontmatter & title extraction', () => {
  it('strips a leading frontmatter block and reads its title', () => {
    const source = '---\ntitle: 自定义标题\norder: 2\n---\n\n# 正文标题\n\n正文';
    const { attrs, body } = stripGuideFrontmatter(source);
    assert.equal(attrs.title, '自定义标题');
    assert.equal(attrs.order, '2');
    assert.ok(body.startsWith('\n# 正文标题'));
    assert.ok(!body.includes('title:'));
  });

  it('returns the body untouched when there is no frontmatter', () => {
    const source = '# 直接开始\n\n正文';
    const { attrs, body } = stripGuideFrontmatter(source);
    assert.deepEqual(attrs, {});
    assert.equal(body, source);
  });

  it('does not treat a mid-document --- as frontmatter', () => {
    const source = '# 标题\n\n---\n\n分隔线不是 frontmatter';
    const { attrs, body } = stripGuideFrontmatter(source);
    assert.deepEqual(attrs, {});
    assert.equal(body, source);
  });

  it('extracts the first H1 as title', () => {
    assert.equal(extractGuideTitle('# 快速上手\n\n正文'), '快速上手');
    assert.equal(extractGuideTitle('前言\n\n# 真标题\n## 二级'), '真标题');
  });

  it('returns empty when no H1 exists', () => {
    assert.equal(extractGuideTitle('只有正文'), '');
    assert.equal(extractGuideTitle('## 只有二级标题'), '');
  });

  it('ignores fenced headings', () => {
    assert.equal(extractGuideTitle('```\n# 不是标题\n```\n\n# 真标题'), '真标题');
  });
});

describe('guide: extractGuideHeadings', () => {
  it('extracts h2/h3 only by default', () => {
    const headings = extractGuideHeadings('# 顶级\n\n## 小节\n\n### 细节\n\n#### 过深\n');
    assert.deepEqual(headings, [
      { level: 2, text: '小节' },
      { level: 3, text: '细节' },
    ]);
  });

  it('ignores headings inside fenced code blocks', () => {
    const headings = extractGuideHeadings('## a\n```md\n## not-heading\n```\n## b');
    assert.equal(headings.length, 2);
  });
});

describe('guide: buildGuideTree', () => {
  before(() => {
    // 独立根目录，避免与 resolveGuideFileWithinRoot 的夹具互相污染
    tmpRoot = makeTmpDir();
    tmpDirs.push(tmpRoot);
    write('index.md', '# 指南首页\n\n内容');
    write('01-基础概念.md', '# 基础概念\n\n正文');
    write('02-快速上手.md', '没有一级标题的文档');
    write('进阶用法/03-会话与上下文.md', '# 会话与上下文');
    write('assets/pic.png', 'binary');
    fs.mkdirSync(path.join(tmpRoot, 'empty-dir'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, '.hidden'), { recursive: true });
    write('.hidden/ignore.md', '# 被忽略');
  });

  it('collects only md docs, drops empty/non-md dirs, sorts numerically', async () => {
    const tree = await buildGuideTree(tmpRoot);
    assert.equal(tree.docCount, 4);
    const ids = [];
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.type === 'doc') ids.push(node.id);
        else walk(node.children);
      }
    };
    walk(tree.children);
    assert.deepEqual(ids.sort(), [
      '01-基础概念.md',
      '02-快速上手.md',
      'index.md',
      '进阶用法/03-会话与上下文.md',
    ].sort());

    // 非文档目录（assets、empty-dir、.hidden）不应出现在树里
    const dirNames = tree.children.filter((node) => node.type === 'dir').map((node) => node.name);
    assert.ok(!dirNames.includes('assets'));
    assert.ok(!dirNames.includes('empty-dir'));
    assert.ok(!dirNames.includes('.hidden'));
  });

  it('reads doc titles from H1', async () => {
    const tree = await buildGuideTree(tmpRoot);
    const walkNodes = [];
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.type === 'doc') walkNodes.push(node);
        else walk(node.children);
      }
    };
    walk(tree.children);
    const titles = Object.fromEntries(walkNodes.map((node) => [node.id, node.title]));
    assert.equal(titles['01-基础概念.md'], '基础概念');
    // 没有一级标题时回退为文件名（去掉 .md）
    assert.equal(titles['02-快速上手.md'], '02-快速上手');
  });
});

describe('guide: guideNameCompare (numeric prefix ordering)', () => {
  it('orders 01 before 02 before 10, and 9 before 10', () => {
    assert.ok(guideNameCompare('01-快速上手.md', '02-基础.md') < 0);
    assert.ok(guideNameCompare('02-基础.md', '10-进阶.md') < 0);
    assert.ok(guideNameCompare('9-临时.md', '10-附录.md') < 0);
  });
});

describe('guide: parseGuideOrderFile', () => {
  it('parses names, strips .md suffix, keeps order', () => {
    assert.deepEqual(parseGuideOrderFile('index.md\n快速上手\n进阶用法.md'), ['index', '快速上手', '进阶用法']);
  });

  it('skips blank lines and # comments, trims whitespace', () => {
    assert.deepEqual(parseGuideOrderFile('\n# 注释\n  a.md  \n\n  # 另一条注释\nb\n'), ['a', 'b']);
  });

  it('strips a UTF-8 BOM (Notepad-saved files)', () => {
    assert.deepEqual(parseGuideOrderFile('\uFEFF首页.md\n指南'), ['首页', '指南']);
  });

  it('deduplicates entries after suffix normalization', () => {
    assert.deepEqual(parseGuideOrderFile('a\na.md\nb'), ['a', 'b']);
  });

  it('returns an empty list for empty or missing content', () => {
    assert.deepEqual(parseGuideOrderFile(''), []);
    assert.deepEqual(parseGuideOrderFile(null), []);
    assert.deepEqual(parseGuideOrderFile('# 只有注释'), []);
  });
});

describe('guide: buildGuideTree with .order index files', () => {
  before(() => {
    // 独立根目录，避免与其他夹具互相污染
    tmpRoot = makeTmpDir();
    tmpDirs.push(tmpRoot);
    write('index.md', '# 首页');
    write('01-基础概念.md', '# 基础概念');
    write('02-快速上手.md', '# 快速上手旧文');
    write('进阶用法/03-会话与上下文.md', '# 会话与上下文');
    write('快速上手/01-配置模型.md', '# 配置模型');
    write('快速上手/模型配置.md', '# 模型配置');
    // dir 与 doc 交错排序；未列出的 02-快速上手 回退默认规则排在最后；
    // 「不存在的文档」被忽略；doc 条目带 .md 后缀、目录条目不带
    write('.order', [
      '# 每行一个条目名（.md 可省略）',
      'index.md',
      '快速上手',
      '01-基础概念',
      '不存在的文档.md',
      '进阶用法',
    ].join('\n'));
    // 子目录的 .order 只作用于本级，且 doc 条目不带后缀
    write('快速上手/.order', '模型配置\n');
  });

  function collectChildren(nodes) {
    return nodes.map((node) => `${node.type}:${node.name}`);
  }

  it('follows .order verbatim with dir/doc interleaved, unlisted entries last', async () => {
    const tree = await buildGuideTree(tmpRoot);
    assert.deepEqual(collectChildren(tree.children), [
      'doc:index',
      'dir:快速上手',
      'doc:01-基础概念',
      'dir:进阶用法',
      'doc:02-快速上手', // 未在 .order 中列出 → 排在已列出条目之后
    ]);
  });

  it('applies each directory .order independently', async () => {
    const tree = await buildGuideTree(tmpRoot);
    const subDir = tree.children.find((node) => node.name === '快速上手');
    assert.deepEqual(collectChildren(subDir.children), [
      'doc:模型配置',
      'doc:01-配置模型',
    ]);
  });

  it('falls back to default ordering when no .order exists', async () => {
    const tree = await buildGuideTree(tmpRoot);
    const subDir = tree.children.find((node) => node.name === '进阶用法');
    assert.deepEqual(collectChildren(subDir.children), ['doc:03-会话与上下文']);
    // 无 .order 的目录树（复用首个夹具）仍按默认规则：dir 优先 + 名称排序
    const plainRoot = makeTmpDir();
    tmpDirs.push(plainRoot);
    const prevRoot = tmpRoot;
    tmpRoot = plainRoot;
    try {
      write('b.md', '# b');
      write('a/c.md', '# c');
      write('a/d.md', '# d');
      const plainTree = await buildGuideTree(plainRoot);
      assert.deepEqual(collectChildren(plainTree.children), ['dir:a', 'doc:b']);
      assert.deepEqual(collectChildren(plainTree.children[0].children), ['doc:c', 'doc:d']);
    } finally {
      tmpRoot = prevRoot;
    }
  });
});
