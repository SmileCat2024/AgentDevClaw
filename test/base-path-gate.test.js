import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

/**
 * base-path 静态门禁（docs/plans/2026-11-14-frontend-basepath-unification.md P3）。
 *
 * 子路径部署（网关前缀代理）下，这些写法会脱离部署前缀 404，且互不搭救：
 *   - 站点根绝对路径的动态 import（不走 fetch patch，不跟随 <base>）
 *   - new EventSource('/...')（同上；构造器 patch 只救字符串裸写，救不了
 *     先拼好再传入的变量——所以规则拦截一切根路径字面量）
 *   - sendBeacon('/...')、new WebSocket(...) 参数中的根路径字符串拼接
 *
 * 合法出路：过 window.__PROTOCLAW_APP_URL__ 映射（WS/sendBeacon 使用点），
 * 或经 claw-host loadPlugin / template-engine 这类已收口的宿主入口。
 * 历史教训：63c05b2e 那轮逐点修复无门禁，新增装载点全部绕过——本门禁
 * 把「不新增裸根路径」从记性变成机器约束。
 */

const ROOT = join(import.meta.dirname, '..');
const SCAN_ROOT = join(ROOT, 'public');

function listFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      listFiles(full, out);
    } else if (/\.(js|html)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

const HELPER = '__PROTOCLAW_APP_URL__';

/** 规则：动态 import 的 specifier 不允许以 / 开头的字面量（引号/模板串）。 */
function checkDynamicImport(content) {
  const re = /\bimport\s*\(\s*(['"`])\//g;
  const hits = [];
  for (const m of content.matchAll(re)) {
    hits.push({ line: lineOf(content, m.index), snippet: content.slice(m.index, m.index + 80).split('\n')[0] });
  }
  return hits;
}

/** 规则：new EventSource(...) 首参不允许根路径字面量。 */
function checkEventSource(content) {
  const re = /new\s+EventSource\s*\(\s*(['"`])\//g;
  return [...content.matchAll(re)].map((m) => ({
    line: lineOf(content, m.index),
    snippet: content.slice(m.index, m.index + 80).split('\n')[0],
  }));
}

/** 规则：sendBeacon(...) URL 参数不允许根路径字面量。 */
function checkSendBeacon(content) {
  const re = /sendBeacon\s*\(\s*(['"`])\//g;
  return [...content.matchAll(re)].map((m) => ({
    line: lineOf(content, m.index),
    snippet: content.slice(m.index, m.index + 80).split('\n')[0],
  }));
}

/**
 * 规则：new WebSocket(...) 调用点，前后 300 字符窗口内出现根路径字符串
 * （引号紧跟 /）即违规，除非窗口内经过 base-path 映射（含 helper 字样）。
 * 双向窗口：URL 拼接在构造调用之前完成，只向后看会漏检真实坏形态。
 */
function checkWebSocket(content) {
  const re = /\bnew\s+WebSocket\s*\(/g;
  const hits = [];
  for (const m of content.matchAll(re)) {
    const start = Math.max(0, m.index - 300);
    const window = content.slice(start, m.index + 300);
    if (window.includes(HELPER)) continue;
    const literal = window.match(/['"`]\//);
    if (literal) {
      hits.push({
        line: lineOf(content, m.index),
        snippet: content.slice(m.index, m.index + 80).split('\n')[0],
      });
    }
  }
  return hits;
}

const RULES = [
  { id: 'dynamic-import', check: checkDynamicImport },
  { id: 'event-source', check: checkEventSource },
  { id: 'send-beacon', check: checkSendBeacon },
  { id: 'web-socket', check: checkWebSocket },
];

describe('base-path 门禁规则自测（规则的辨别力，防规则写坏导致恒绿）', () => {
  it('动态 import：根路径字面量命中，变量与 helper 形态放行', () => {
    assert.equal(checkDynamicImport("await import('/src/plugins/memo/index.js')").length, 1);
    assert.equal(checkDynamicImport('const es = await import(moduleUrl)').length, 0);
    assert.equal(checkDynamicImport(`await import(${HELPER}?.(path) || path)`).length, 0);
    assert.equal(checkDynamicImport("import('./settings.js')").length, 0, '相对路径合法');
    assert.equal(checkDynamicImport('import("https://cdn.example/x.js")').length, 0, '完整 URL 合法');
  });

  it('EventSource：根路径字面量命中（含模板串），相对路径放行', () => {
    assert.equal(checkEventSource("new EventSource('/protoclaw/events')").length, 1);
    assert.equal(checkEventSource('new EventSource(`/protoclaw/feature-comms/stream?${q}`)').length, 1);
    assert.equal(checkEventSource("new EventSource('./events')").length, 0);
    assert.equal(checkEventSource('new EventSource(mappedUrl)').length, 0);
  });

  it('sendBeacon：根路径字面量命中', () => {
    assert.equal(checkSendBeacon("navigator.sendBeacon('/protoclaw/x', blob)").length, 1);
    assert.equal(checkSendBeacon('navigator.sendBeacon(mappedUrl, blob)').length, 0);
  });

  it('WebSocket：窗口内根路径字符串命中，过 helper 的窗口放行', () => {
    const bad = "const wsUrl = (proto === 'https:' ? 'wss://' : 'ws://') + host + '/protoclaw/speech';\nws = new WebSocket(wsUrl);";
    assert.equal(checkWebSocket(bad).length, 1, '拼接窗口内的根路径字符串应命中');
    const good = `const p = window.${HELPER}?.('/protoclaw/s') || '/protoclaw/s';\nconst wsUrl = proto + host + p;\nws = new WebSocket(wsUrl);`;
    assert.equal(checkWebSocket(good).length, 0, '过 helper 的窗口应放行');
    assert.equal(checkWebSocket("ws = new WebSocket('wss://example.com/advclaw/s')").length, 0, '完整 URL 字符串不命中（斜杠前非引号）');
  });
});

describe('base-path 门禁：public/ 全量扫描', () => {
  it('零违规（新增裸根路径资源引用会被拦截，出路见文件头注）', () => {
    const violations = [];
    for (const file of listFiles(SCAN_ROOT)) {
      const content = readFileSync(file, 'utf8');
      for (const rule of RULES) {
        for (const hit of rule.check(content)) {
          violations.push(`${relative(ROOT, file)}:${hit.line} [${rule.id}] ${hit.snippet.trim()}`);
        }
      }
    }
    assert.deepEqual(violations, [], '\n' + violations.join('\n'));
  });
});
