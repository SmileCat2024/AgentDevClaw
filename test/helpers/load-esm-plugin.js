/**
 * load-esm-plugin.js — 在 vm 沙箱里执行 ES 模块插件源码
 *
 * P4 迁移后的面板插件是 ES 模块（export default + 命名导出），frontend-vm
 * 的 ctx.loadSource 只执行 classic script（export 语法报错）。本 helper 做
 * 语法变换后在沙箱执行：每个测试拿全新沙箱实例（模块内状态如 stateByRuntime
 * 不跨测试残留），模块函数体内的宿主全局裸引用照常从沙箱注入解析。
 *
 * 与 memo-plugin-loader（真实动态 import + presenter 注入）的分工：那套
 * 适合模块不裸引用全局的插件；一等面板插件保留宿主全局裸引用（浏览器事实），
 * 用本套源码变换。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 把 ES 模块源码变换为 classic script：
 *   - export default <expr> → const __pluginDefault = <expr>
 *   - export { a, b }; → 删除（名字进入收集清单）
 *   - export const NAME = … → const NAME = …（名字进入收集清单）
 * 末尾挂 window.__pluginModule = { __pluginDefault, a, b, ... }。
 */
export function transformEsmPluginSource(source) {
  let out = source.replace(/export\s+default\s+/, 'const __pluginDefault = ');
  if (out === source && /export\s+default/.test(source)) {
    throw new Error('export default 形态未被识别，请检查模块结构');
  }
  const named = [];
  out = out.replace(/export\s*\{([^}]+)\};?/g, (_, inner) => {
    for (const part of inner.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) named.push(name);
    }
    return '';
  });
  out = out.replace(/export\s+const\s+([A-Za-z_$][\w$]*)/g, (_, name) => {
    named.push(name);
    return 'const ' + name;
  });
  out = out.replace(/export\s+function\s+([A-Za-z_$][\w$]*)/g, (_, name) => {
    named.push(name);
    return 'function ' + name;
  });
  if (/\bexport\b/.test(out)) {
    throw new Error('存在未处理的 export 形态：' + out.match(/.*\bexport\b.*/)[0].trim());
  }
  out += `\nwindow.__pluginModule = { __pluginDefault, ${[...new Set(named)].join(', ')} };`;
  return out;
}

/** 读插件源码、变换、在沙箱执行，返回 window.__pluginModule。 */
export function loadEsmPluginInSandbox(ctx, pluginPath) {
  const root = path.resolve(import.meta.dirname, '..', '..');
  const source = readFileSync(path.join(root, pluginPath), 'utf8');
  ctx.run(transformEsmPluginSource(source));
  return ctx.run('window.__pluginModule');
}
