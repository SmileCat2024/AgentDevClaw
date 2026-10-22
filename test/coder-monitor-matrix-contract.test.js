import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const files = {
  R: 'test/coder-monitor-routes.test.js',
  M: 'local-features/capability-shell/test/coder-monitor-matrix.test.ts',
  F: 'local-features/capability-shell/test/coder-monitor-feature-matrix.test.ts',
  U: 'test/frontend-bg-panel.test.js',
  adapter: 'local-features/capability-shell/test/coder-shell.test.ts',
};

it('M9 matrix: each documented layer has a named test; no undocumented test cells', () => {
  const document = readFileSync(new URL('../docs/reference/thread-state-matrix.md', import.meta.url), 'utf8');
  const rows = [...document.matchAll(/^\| (M9-[A-Z-]+) \|[^\n]+\| ([^|]+) \|$/gm)];
  assert.ok(rows.length > 0, 'monitor matrix must exist');
  const documented = new Map(rows.map(row => [row[1], row[2].trim().split('、')]));
  assert.equal(documented.size, rows.length, 'duplicate matrix IDs');
  const coverage = new Map();
  for (const [layer, path] of Object.entries(files)) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const ids = new Set();
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'it' && node.arguments[0]) {
        for (const match of node.arguments[0].getText(ast).matchAll(/M9-[A-Z]+(?:-[A-Z]+)*/g)) ids.add(match[0]);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    assert.ok(ids.size > 0, `${path} has no matrix test titles`);
    for (const id of ids) assert.ok(documented.has(id), `${path} references undocumented ${id}`);
    coverage.set(layer, ids);
  }
  for (const [id, layers] of documented) {
    for (const layer of layers) {
      assert.ok(coverage.has(layer), `${id}: unknown layer ${layer}`);
      assert.ok(coverage.get(layer).has(id), `${id}: missing ${layer} test in ${files[layer]}`);
    }
  }
});
