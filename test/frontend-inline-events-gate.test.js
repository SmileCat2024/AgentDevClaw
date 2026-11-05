/**
 * 内联事件收编防线（Phase C 第二面）。
 *
 * 两道断言：
 * 1. ratchet——模板内联处理器（onclick="…" 等 attribute 形态）在收编范围内
 *    总数只许降不许升，基线 .inline-events-baseline.json 随每批提交更新，
 *    终态 0。`.onclick = fn` 属性赋值是模块局部合法形态，不在扫描范围。
 * 2. data-action 覆盖——全部点号命名空间（域.动作）的 data-action 字面量
 *    必须有静态可发现的注册点（插件 actions 对象键 / registerMany /
 *    actions.register），防「模板声明了动作但无人注册」的丢分发回归
 *    （f9c8e104 同型）。
 *
 * 已知边界（设计决定，非缺陷）：动态拼接的 data-action（如 coder 插件
 * actionButton 经变量构造）不出现在字面量扫描里，由各插件契约测试与
 * 运行时分发器的「未注册的 action」报错兜底。裸名（无点号）data-action
 * 是部分 classic 模块的 querySelector 钩子约定（渲染后局部 addEventListener），
 * 不经分发器，不适用本断言。
 *
 * 悬置域文件（work-group / flow / dispatch-console / qqbot / home）不在
 * 收编范围，排除清单固化在基线里；这些域随各自大工程重做时一并处理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC_SRC = path.join(ROOT, 'public', 'src');
const INDEX_HTML = path.join(ROOT, 'public', 'index.html');
const BASELINE_FILE = path.join(ROOT, '.inline-events-baseline.json');

/** 悬置域 + 自身文档注释含示例的文件，按 basename 精确匹配或前缀匹配。 */
const SUSPENDED_BASENAMES = new Set([
  'im-ui.js',
  'im-actions.js',
  'dispatch-ui.js',
  'dispatch-actions.js',
  'work-group-ui.js',
  'flow-editor.js',
  'home-dashboard.js',
  'resources-viewer.js',
  'action-dispatcher.js', // 头注释里的 onclick="fn(...)" 是文档示例
]);
const SUSPENDED_PREFIXES = ['wg-', 'work-group-'];

function isSuspended(basename) {
  return SUSPENDED_BASENAMES.has(basename) || SUSPENDED_PREFIXES.some((p) => basename.startsWith(p));
}

/** 递归收集 public/src 下的 .js 文件（app-*.js / modules / plugins 全覆盖）。 */
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const INLINE_HANDLER_RE = /on(?:click|change|input|keydown|keyup|dblclick|mousedown|mouseup|blur|submit|focus|toggle|pointerdown|pointerup|pointermove|pointerenter|pointerleave|pointerover|pointerout|mouseover|mouseout|mouseenter|mouseleave|dragstart|wheel|contextmenu)="[^"]*"/g;
/** setAttribute('onclick', 'fn(...)') 是同一依赖的第二种注入形态，一并计数。 */
const SET_ATTRIBUTE_HANDLER_RE = /setAttribute\(\s*['"]on(?:click|change|input|keydown|keyup|dblclick|mousedown|mouseup|blur|submit)['"]\s*,/g;
const DOTTED_ACTION_RE = /data-action="([a-zA-Z][\w-]*\.[\w-]+)"/g;

/** 返回 { files, excluded }：files = 收编范围文件路径列表。 */
function scopedFiles() {
  const files = collectSourceFiles(PUBLIC_SRC).filter((f) => !isSuspended(path.basename(f)));
  files.push(INDEX_HTML);
  return files;
}

function countInlineHandlers(source) {
  return [...source.matchAll(INLINE_HANDLER_RE)].length
    + [...source.matchAll(SET_ATTRIBUTE_HANDLER_RE)].length;
}

function readSync(file) {
  return readFile(file, 'utf8');
}

test('内联处理器 ratchet：收编范围内总数只许降不许升', async () => {
  let baseline;
  if (!statSync(BASELINE_FILE, { throwIfNoEntry: false })) {
    // 首次引导：固化当前值，此后只许降不许升。
    baseline = null;
  } else {
    baseline = JSON.parse(await readSync(BASELINE_FILE));
  }
  let total = 0;
  const perFile = [];
  for (const file of scopedFiles()) {
    const count = countInlineHandlers(await readSync(file));
    if (count > 0) perFile.push(`${path.relative(ROOT, file)}: ${count}`);
    total += count;
  }
  if (!baseline) {
    await writeFile(
      BASELINE_FILE,
      JSON.stringify({ total, suspended: [...SUSPENDED_BASENAMES], suspendedPrefixes: SUSPENDED_PREFIXES }, null, 2) + '\n',
      'utf8',
    );
    return;
  }
  assert.ok(
    total <= baseline.total,
    `模板内联处理器 ${total} 处超出基线 ${baseline.total}（只许降不许升）。\n`
      + `当前分布：\n  ${perFile.join('\n  ')}\n`
      + `完成一批收编后用 INLINE_EVENTS_UPDATE_BASELINE=1 npm run test:file -- test/${path.basename(import.meta.filename)} 更新基线。`,
  );
  if (total < baseline.total) {
    assert.ok(
      process.env.INLINE_EVENTS_UPDATE_BASELINE || process.argv.includes('--update-inline-events-baseline'),
      `内联处理器降至 ${total}（基线 ${baseline.total}），请更新基线固化进度：`
        + `INLINE_EVENTS_UPDATE_BASELINE=1 npm run test:file -- test/${path.basename(import.meta.filename)}`,
    );
    await writeFile(
      BASELINE_FILE,
      JSON.stringify({ ...baseline, total }, null, 2) + '\n',
      'utf8',
    );
  }
});

test('data-action 覆盖：点号命名字面量必须有注册点', async () => {
  const files = scopedFiles();
  const sources = new Map();
  for (const file of files) sources.set(file, await readSync(file));

  // 消费侧：全部点号命名空间的 data-action 字面量
  const used = new Map(); // name -> [file]
  for (const [file, source] of sources) {
    for (const m of source.matchAll(DOTTED_ACTION_RE)) {
      if (!used.has(m[1])) used.set(m[1], []);
      used.get(m[1]).push(path.relative(ROOT, file));
    }
  }

  // 注册侧：插件 actions 对象键 + registerMany 键 + actions.register 单点
  const registered = new Set();
  for (const source of sources.values()) {
    for (const start of objectLiteralStarts(source, /actions:\s*\{/g)) {
      for (const key of objectKeys(extractBalancedBlock(source, start))) registered.add(key);
    }
    for (const start of objectLiteralStarts(source, /registerMany\s*\(\s*\{/g)) {
      for (const key of objectKeys(extractBalancedBlock(source, start))) registered.add(key);
    }
    for (const single of source.matchAll(/actions\.register\(\s*['"]([\w.-]+)['"]\s*,/g)) {
      registered.add(single[1]);
    }
  }

  const missing = [...used.keys()].filter((name) => !registered.has(name)).map(
    (name) => `${name}（使用于 ${[...new Set(used.get(name))].join(', ')}）`,
  );
  assert.deepEqual(
    missing,
    [],
    `以下 data-action 无注册点，点击将是死动作：\n  ${missing.join('\n  ')}\n`
      + `注册点 = 插件 actions 对象键 ∪ registerMany 键 ∪ actions.register。`,
  );
});

/** 返回 regex 全部命中处「{」字符的索引（regex 命中串以 { 结尾）。 */
function objectLiteralStarts(source, regex) {
  return [...source.matchAll(regex)].map((m) => m.index + m[0].length - 1);
}

/**
 * 从 start（指向「{」）做括号平衡提取，字符串内容（'…"…`）整体跳过，
 * 返回对象字面量的完整文本。多行 handler、嵌套对象都不会提前截断。
 */
function extractBalancedBlock(source, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

/** 对象字面量文本里的点号命名键：'xxx.yyy': / "xxx.yyy": 形态。 */
function objectKeys(blockText) {
  return [...blockText.matchAll(/['"]([\w.-]+)['"]\s*:/g)].map((m) => m[1]);
}
