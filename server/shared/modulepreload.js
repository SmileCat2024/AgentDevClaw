import fs from 'node:fs';
import path from 'node:path';

/**
 * 首屏 modulepreload 注入（首屏加载专项：消模块瀑布）。
 *
 * 背景：`public/index.html` 的 module 入口只声明了 14 个入口，其余依赖靠
 * import 逐层发现，首屏静态图当前 207 个文件、最长链 27 层。每一层都要等
 * 上一层的模块解析完才知道下一层要什么，远程部署下每层是一个 RTT。
 * `modulepreload` 让浏览器在解析 HTML 阶段就并行预取整张静态图。
 *
 * 为什么由 server 在响应时注入，而不是落一份清单文件：
 *   清单会随任何 import 边变化而失效（前端收敛批次仍在改 import），
 *   手写/提交清单会把“每次改图都要同步更新”变成持续摩擦。这里按实时的
 *   import 图生成，图变了清单自动跟随。
 *
 * 语义边界（重要）：modulepreload 只是预取提示。多列一个文件只浪费一次
 * 请求，少列一个文件只是退回逐层发现，都不会改变页面行为。因此本模块
 * 出错时的正确降级是“不注入”，由 `next()` 交回 `express.static` 直出。
 */

const MODULE_SCRIPT_RE = /<script\b([^>]*)>/g;
// 静态 import / export-from（跨行允许），与 scripts/measure 系列同一判据。
const STATIC_FROM_RE = /(?:^|[\r\n])\s*(?:import|export)\b[^;]*?\bfrom\s*['"](\.[^'"]+)['"]/g;
// 副作用 import：import './x.js'
const SIDE_EFFECT_IMPORT_RE = /(?:^|[\r\n])\s*import\s*['"](\.[^'"]+)['"]/g;

/** 从 index.html 取 module 入口的 src 列表（保持文档顺序）。 */
export function collectModuleEntrySpecs(indexHtml) {
  const specs = [];
  MODULE_SCRIPT_RE.lastIndex = 0;
  let match;
  while ((match = MODULE_SCRIPT_RE.exec(indexHtml))) {
    const attrs = match[1] || '';
    if (!/\btype\s*=\s*["']module["']/.test(attrs)) continue;
    const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/) || [])[1];
    if (src) specs.push(src);
  }
  return specs;
}

/** 取一个模块源码里的相对依赖说明符（去重、保持出现顺序）。 */
export function collectRelativeSpecifiers(source) {
  const specs = new Set();
  const scan = (re) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source))) specs.add(match[1]);
  };
  scan(STATIC_FROM_RE);
  scan(SIDE_EFFECT_IMPORT_RE);
  return [...specs];
}

/**
 * 递归遍历 module 图。
 *
 * @param {object} options
 * @param {string} options.indexHtml      index.html 原文
 * @param {(file: string) => string|null} options.readFile  读文件（读不到返回 null）
 * @param {(fromFile: string, spec: string) => string} options.resolve  解析为绝对路径
 * @returns {{ roots: string[], files: string[] }}  roots=入口，files=入口的外部依赖（BFS 顺序）
 */
export function buildModuleGraph({ indexHtml, readFile, resolve }) {
  const roots = collectModuleEntrySpecs(indexHtml)
    .map((spec) => resolve('', spec))
    .filter(Boolean);
  const rootSet = new Set(roots);
  const seen = new Set(roots);
  const files = [];
  const queue = [...roots];
  while (queue.length) {
    const file = queue.shift();
    const source = readFile(file);
    if (source == null) continue;
    // 只有真实读到的文件才进清单：preload 一个不存在的文件只会换来一次 404。
    if (!rootSet.has(file) && !files.includes(file)) files.push(file);
    for (const spec of collectRelativeSpecifiers(source)) {
      const next = resolve(file, spec);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return { roots, files };
}

/** 文件绝对路径 → 相对站点根的 URL（与 index.html 里 `./src/...` 同形）。 */
export function toSiteHref(publicDir, file) {
  const rel = path.relative(publicDir, file).split(path.sep).join('/');
  return `./${rel}`;
}

/** 生成注入片段；空列表返回空串。 */
export function renderPreloadLinks(hrefs) {
  if (!hrefs.length) return '';
  return hrefs.map((href) => `  <link rel="modulepreload" href="${href}">`).join('\n') + '\n';
}

/** 注入到 `</head>` 前；没有 head 时退回插到文档开头。 */
export function injectPreloadLinks(html, linksHtml) {
  if (!linksHtml) return html;
  const headClose = html.lastIndexOf('</head>');
  if (headClose === -1) return linksHtml + html;
  return html.slice(0, headClose) + linksHtml + html.slice(headClose);
}

/**
 * 带缓存的首屏 HTML 渲染器。
 *
 * 缓存策略：`ttlMs` 内直接复用；到期后对上一轮解析出的文件集合做 stat 校验
 * （大小 + mtime），签名不变则复用，变了才重新遍历图。签名里天然包含
 * “某个文件新增了 import”这种情况——新增 import 必然改动该文件的大小或
 * mtime，于是触发重建、把新文件纳入清单。
 */
export function createFirstPaintIndexRenderer({
  publicDir,
  indexFile = path.join(publicDir, 'index.html'),
  enabled = true,
  ttlMs = 2000,
} = {}) {
  let cache = null; // { html, files, signature, checkedAt }

  function statSignature(files) {
    let signature = '';
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        signature += `${stat.size}:${stat.mtimeMs};`;
      } catch {
        signature += 'missing;';
      }
    }
    return signature;
  }

  function build(now) {
    const html = fs.readFileSync(indexFile, 'utf8');
    const graph = buildModuleGraph({
      indexHtml: html,
      readFile: (file) => {
        try {
          return fs.readFileSync(file, 'utf8');
        } catch {
          return null;
        }
      },
      resolve: (fromFile, spec) => {
        if (!spec || !spec.startsWith('.')) return null;
        const base = fromFile ? path.dirname(fromFile) : publicDir;
        return path.resolve(base, spec);
      },
    });
    const files = graph.files.filter((file) => file.endsWith('.js'));
    return {
      html,
      files,
      signature: statSignature(files),
      checkedAt: now,
    };
  }

  return {
    /** @returns {string|null} null 表示“未启用/不可用”，调用方应回落到 static。 */
    render(now = Date.now()) {
      if (!enabled) return null;
      try {
        if (!cache) cache = build(now);
        else if (now - cache.checkedAt >= ttlMs) {
          cache.checkedAt = now;
          const nextSignature = statSignature(cache.files);
          if (nextSignature !== cache.signature) cache = build(now);
        }
        const hrefs = cache.files.map((file) => toSiteHref(publicDir, file));
        return injectPreloadLinks(cache.html, renderPreloadLinks(hrefs));
      } catch {
        cache = null;
        return null;
      }
    },
    /** 测试用：丢弃缓存。 */
    invalidate() {
      cache = null;
    },
  };
}
