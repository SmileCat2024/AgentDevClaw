import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// resolveFrameworkDependencySpecs 的 vendor 分支（打包树形态）纯函数行为：
// 声明解析、manifest 校验、digest 输出、错误路径。真实 npm install 走
// user-feature-mount / pack:desktop E2E，此处不重复。

import { resolveFrameworkDependencySpecs } from '../server/feature-runtime/provisioner.js';

const PKGS = ['@agentdevjs/core', '@agentdevjs/llm', '@agentdevjs/viewer', '@agentdevjs/mcp'];

function makeTree() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'prov-vendor-'));
  return {
    root: projectRoot,
    pkg(overrides = {}) {
      const deps = {};
      for (const name of PKGS) deps[name] = overrides[name] ?? 'file:vendor/agentdevjs-' + name.slice(12) + '-0.1.0.tgz';
      writeFileSync(join(projectRoot, 'package.json'), JSON.stringify({ dependencies: deps }));
    },
    manifest(entries) {
      mkdirSync(join(projectRoot, 'vendor'), { recursive: true });
      writeFileSync(join(projectRoot, 'vendor', 'manifest.json'), JSON.stringify(entries));
    },
    tgz(name) {
      mkdirSync(join(projectRoot, 'vendor'), { recursive: true });
      const rel = 'vendor/agentdevjs-' + name.slice(12) + '-0.1.0.tgz';
      writeFileSync(join(projectRoot, rel), 'fake-archive');
      return rel;
    },
    fullVendor(shaByPkg = {}) {
      const entries = {};
      for (const name of PKGS) {
        const rel = this.tgz(name);
        entries[name] = { version: '0.1.0', tgz: rel, sha256: shaByPkg[name] ?? ('sha-' + name.slice(12)) };
      }
      this.manifest(entries);
    },
    dispose() { rmSync(projectRoot, { recursive: true, force: true }); },
  };
}

const EMPTY_AGENTDEV_ROOT = join(tmpdir(), 'prov-vendor-no-agentdev-' + process.pid);

test('vendor 分支：specs 指向 tgz 实体、digests 输出', () => {
  const tree = makeTree();
  try {
    tree.pkg();
    tree.fullVendor();
    const { specs, vendorDigests } = resolveFrameworkDependencySpecs(tree.root, EMPTY_AGENTDEV_ROOT);
    for (const name of PKGS) {
      assert.match(specs[name], /^file:.+vendor\/agentdevjs-.+-0\.1\.0\.tgz$/);
      assert.equal(vendorDigests[name], 'sha-' + name.slice(12));
    }
  } finally { tree.dispose(); }
});

test('vendor 分支：digest 随 manifest 变化（同版本重打包 → hash 输入变化）', () => {
  const a = makeTree();
  const b = makeTree();
  try {
    a.pkg(); a.fullVendor();
    b.pkg(); b.fullVendor({ '@agentdevjs/core': 'sha-core-repacked' });
    const da = resolveFrameworkDependencySpecs(a.root, EMPTY_AGENTDEV_ROOT).vendorDigests;
    const db = resolveFrameworkDependencySpecs(b.root, EMPTY_AGENTDEV_ROOT).vendorDigests;
    assert.notEqual(da['@agentdevjs/core'], db['@agentdevjs/core']);
    assert.equal(da['@agentdevjs/llm'], db['@agentdevjs/llm']);
  } finally { a.dispose(); b.dispose(); }
});

test('vendor 分支：manifest 缺失 / 不匹配 / tgz 实体缺失 → 明确报错', () => {
  const cases = [
    { label: 'manifest 缺失', setup(t) { t.pkg(); /* 不写 manifest */ } },
    { label: 'manifest 条目 tgz 不匹配', setup(t) { t.pkg(); t.manifest(PKGS.reduce((m, n) => { m[n] = { version: '0.1.0', tgz: 'vendor/other.tgz', sha256: 'x' }; return m; }, {})); t.tgz(PKGS[0]); } },
    { label: 'tgz 实体缺失', setup(t) { t.pkg(); t.manifest(PKGS.reduce((m, n) => { m[n] = { version: '0.1.0', tgz: 'vendor/agentdevjs-' + n.slice(12) + '-0.1.0.tgz', sha256: 'x' }; return m; }, {})); /* 不写 tgz */ } },
    { label: '混合形态', setup(t) { const deps = {}; for (const [i, n] of PKGS.entries()) deps[n] = i < 2 ? 'file:vendor/agentdevjs-' + n.slice(12) + '-0.1.0.tgz' : '0.1.0'; writeFileSync(join(t.root, 'package.json'), JSON.stringify({ dependencies: deps })); t.fullVendor(); } },
  ];
  for (const { label, setup } of cases) {
    const tree = makeTree();
    try {
      setup(tree);
      assert.throws(() => resolveFrameworkDependencySpecs(tree.root, EMPTY_AGENTDEV_ROOT), { name: 'Error' }, label);
    } finally { tree.dispose(); }
  }
});

test('registry 分支回归：精确 semver 声明 → 版本号 spec、digests 为 null', () => {
  const tree = makeTree();
  try {
    const deps = {};
    for (const name of PKGS) deps[name] = '0.2.0';
    writeFileSync(join(tree.root, 'package.json'), JSON.stringify({ dependencies: deps }));
    const { specs, vendorDigests } = resolveFrameworkDependencySpecs(tree.root, EMPTY_AGENTDEV_ROOT);
    for (const name of PKGS) assert.equal(specs[name], '0.2.0');
    assert.equal(vendorDigests, null);
  } finally { tree.dispose(); }
});

test('开发态分支回归：相邻框架仓库存在 → file: 源码目录、digests 为 null', () => {
  const agentdevRoot = mkdtempSync(join(tmpdir(), 'prov-vendor-dev-'));
  try {
    mkdirSync(join(agentdevRoot, 'packages', 'core'), { recursive: true });
    writeFileSync(join(agentdevRoot, 'packages', 'core', 'package.json'), '{}');
    const tree = makeTree();
    try {
      tree.pkg();
      const { specs, vendorDigests } = resolveFrameworkDependencySpecs(tree.root, agentdevRoot);
      assert.match(specs['@agentdevjs/core'], /^file:.+packages\/core$/);
      assert.equal(vendorDigests, null);
    } finally { tree.dispose(); }
  } finally { rmSync(agentdevRoot, { recursive: true, force: true }); }
});
