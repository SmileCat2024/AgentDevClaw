/**
 * Tests for the feature-config queue resolved/layer route logic (ticket 05).
 *
 * Pure logic coverage: scope registry, queue assembly via shared layer
 * readers, resolveFeatureConfig consistency (merged = provenance.value,
 * sourceIndex points at a sparse layer holding the field), PUT validation
 * (object / top-level keys / null rejection), write-target resolution
 * (global compat path + unknown layerId 404). Uses temp dirs — never the
 * real user directory.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  buildScopeLayers,
  collectSensitiveFields,
  listRegisteredScopes,
  registerScopeResolver,
  resolveScopeConfig,
  resolveWriteTarget,
  validateLayerContent,
} from '../server/routes/feature-config.js';
import { encodeDirConfigFile } from '../server/shared/feature-config-layers.js';

let tempDir;
let featureConfigDir;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'feature-config-resolved-test-'));
  featureConfigDir = join(tempDir, 'feature-config');
  mkdirSync(featureConfigDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// 测试专用注册表：registerScopeResolver 操作模块级全局表，会污染真实路径；
// 为了隔离测试，直接构造局部表注入 buildScopeLayers / resolveWriteTarget。
// global 表中 programming-helper 的注册由路由模块自身保证（listRegisteredScopes 覆盖）。
function localTable() {
  const table = new Map();
  table.set('test-scope', ({ dir } = {}) => {
    const layers = [{ id: 'global', label: '全局', path: join(tempDir, 'global.json') }];
    if (dir) {
      layers.push({
        id: `dir:${dir}`,
        label: 'dir-layer',
        path: join(featureConfigDir, encodeDirConfigFile(dir)),
      });
    }
    return { layers };
  });
  return table;
}

describe('scope registry', () => {
  it('registers programming-helper at module load (first consumer)', () => {
    assert.ok(listRegisteredScopes().includes('programming-helper'));
  });

  it('rejects invalid registrations', () => {
    assert.throws(() => registerScopeResolver('', () => ({})));
    assert.throws(() => registerScopeResolver('x', 'not-a-function'));
  });
});

describe('buildScopeLayers / resolveScopeConfig', () => {
  it('throws for unregistered agentId', () => {
    assert.throws(
      () => buildScopeLayers({ agentId: 'nope' }, localTable()),
      /未注册的 scope/,
    );
  });

  it('returns layers with sparse content and consistent merged/provenance', () => {
    const dir = join(tempDir, 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(tempDir, 'global.json'), JSON.stringify({
      lsp: { typescript: { mode: 'exec' } },
      github: { token: 'ghp_test' },
    }), 'utf8');
    writeFileSync(join(featureConfigDir, encodeDirConfigFile(dir)), JSON.stringify({
      lsp: { typescript: { mode: 'runtime', package: 'x' } },
    }), 'utf8');

    const result = resolveScopeConfig({ agentId: 'test-scope', dir }, localTable());

    assert.equal(result.layers.length, 2);
    assert.equal(result.layers[0].id, 'global');
    assert.equal(result.layers[1].id, `dir:${dir}`);
    assert.deepEqual(result.layers[0].sparse, {
      lsp: { typescript: { mode: 'exec' } },
      github: { token: 'ghp_test' },
    });

    // 验收标准：merged 字段值 = provenance.value；sourceIndex 指向的层 sparse 有该字段
    assert.deepEqual(result.merged.lsp.typescript, { mode: 'runtime', package: 'x' });
    assert.equal(result.provenance['lsp.typescript.mode'].value, 'runtime');
    assert.equal(result.provenance['lsp.typescript.mode'].sourceIndex, 1);
    assert.equal(result.provenance['lsp.typescript.mode'].value, result.merged.lsp.typescript.mode);
    assert.ok('mode' in result.layers[1].sparse.lsp.typescript);
    assert.equal(result.provenance['github.token'].sourceIndex, 0);
    assert.equal(result.merged.github.token, 'ghp_test');

    assert.deepEqual(result.warnings, []);
  });

  it('treats missing layer files as empty layers and still resolves', () => {
    const result = resolveScopeConfig({ agentId: 'test-scope' }, localTable());
    assert.deepEqual(result.layers[0].sparse, {});
    assert.deepEqual(result.merged, {});
    assert.deepEqual(result.sensitiveFields, []);
  });

  it('declares agent layer between global and dir (real programming-helper resolver)', () => {
    // 真实注册表：只断言声明的层结构与顺序（id/label/path 文件名），
    // sparse 读取无写入副作用，与用户目录实际内容无关。
    const dir = join(tempDir, 'proj');
    const { layers } = buildScopeLayers({ agentId: 'programming-helper', dir });
    assert.deepEqual(layers.map((layer) => layer.id), ['global', 'agent', `dir:${dir}`]);
    assert.equal(layers[1].label, '编程小助手');
    assert.ok(layers[1].path.endsWith(join('workspaces', 'programming-helper', 'feature-config', 'agent.json')));

    const noDir = buildScopeLayers({ agentId: 'programming-helper' });
    assert.deepEqual(noDir.layers.map((layer) => layer.id), ['global', 'agent']);
  });

  it('resolves agent layer as a write target (real programming-helper resolver)', () => {
    const target = resolveWriteTarget({ agentId: 'programming-helper', layerId: 'agent' });
    assert.ok(target.endsWith(join('workspaces', 'programming-helper', 'feature-config', 'agent.json')));
  });

  it('declares coder identity queue as [global, coder] with no dir layer', () => {
    // coder 是编程小助手工作空间内的平行身份：队列只有全局层 + coder 层。
    const { layers } = buildScopeLayers({ agentId: 'coder', dir: join(tempDir, 'proj') });
    assert.deepEqual(layers.map((layer) => layer.id), ['global', 'coder']);
    assert.equal(layers[1].label, 'coder');
    assert.ok(layers[1].path.endsWith(join('workspaces', 'programming-helper', 'feature-config', 'coder.json')));
  });

  it('resolves coder layer as a write target', () => {
    const target = resolveWriteTarget({ agentId: 'coder', layerId: 'coder' });
    assert.ok(target.endsWith(join('workspaces', 'programming-helper', 'feature-config', 'coder.json')));
  });

  it('surfaces null warnings from layer files', () => {
    writeFileSync(join(tempDir, 'global.json'), JSON.stringify({
      shell: { bashPath: null },
    }), 'utf8');
    const result = resolveScopeConfig({ agentId: 'test-scope' }, localTable());
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].kind, 'null-removed');
    assert.equal(result.warnings[0].fieldPath, 'shell.bashPath');
    assert.equal(result.merged.shell?.bashPath, undefined);
  });

  it('lists sensitive fields present in merged output (anchor only)', () => {
    writeFileSync(join(tempDir, 'global.json'), JSON.stringify({
      github: { token: 'secret' },
      lsp: { typescript: { mode: 'runtime' } },
    }), 'utf8');
    const result = resolveScopeConfig({ agentId: 'test-scope' }, localTable());
    assert.deepEqual(result.sensitiveFields, ['github.token']);

    assert.deepEqual(collectSensitiveFields({}), []);
    assert.deepEqual(collectSensitiveFields({ github: {} }), []);
    assert.deepEqual(collectSensitiveFields({ github: { token: '' } }), ['github.token']);
  });
});

describe('validateLayerContent', () => {
  it('accepts plain objects', () => {
    assert.equal(validateLayerContent({}), null);
    assert.equal(validateLayerContent({ lsp: { typescript: { mode: 'runtime' } } }), null);
    assert.equal(validateLayerContent({ shell: { args: ['a', 'b'] } }), null);
  });

  it('rejects non-objects', () => {
    assert.ok(validateLayerContent(null));
    assert.ok(validateLayerContent(undefined));
    assert.ok(validateLayerContent([]));
    assert.ok(validateLayerContent('x'));
    assert.ok(validateLayerContent(42));
  });

  it('rejects null anywhere in the payload', () => {
    assert.match(validateLayerContent({ lsp: null }), /null is not allowed/);
    assert.match(validateLayerContent({ lsp: { nested: { deep: null } } }), /null is not allowed/);
    assert.match(validateLayerContent({ shell: { args: ['a', null] } }), /null is not allowed/);
  });

  it('rejects empty top-level keys', () => {
    assert.match(validateLayerContent({ '': {} }), /non-empty feature names/);
  });
});

describe('resolveWriteTarget', () => {
  it('maps global to the global layer path regardless of declared layers', () => {
    const target = resolveWriteTarget({ agentId: 'test-scope', layerId: 'global' }, localTable());
    assert.equal(target, join(tempDir, 'global.json'));
  });

  it('resolves dir layer ids through the registered resolver', () => {
    const dir = join(tempDir, 'proj');
    const target = resolveWriteTarget({ agentId: 'test-scope', layerId: `dir:${dir}` }, localTable());
    assert.equal(target, join(featureConfigDir, encodeDirConfigFile(dir)));
  });

  it('computes a fresh target for a not-yet-existing dir layer (sparse normal state)', () => {
    const dir = join(tempDir, 'brand-new');
    const target = resolveWriteTarget({ agentId: 'test-scope', layerId: `dir:${dir}` }, localTable());
    assert.equal(target, join(featureConfigDir, encodeDirConfigFile(dir)));
    assert.equal(existsSync(target), false);
  });

  it('returns null for truly unknown layerIds (route maps to 404)', () => {
    assert.equal(resolveWriteTarget({ agentId: 'test-scope', layerId: 'bogus' }, localTable()), null);
    assert.equal(resolveWriteTarget({ agentId: 'test-scope', layerId: 'agent:x' }, localTable()), null);
  });

  it('throws for unregistered agentId (route maps to 404)', () => {
    assert.throws(
      () => resolveWriteTarget({ agentId: 'nope', layerId: 'global' }, localTable()),
      /未注册的 scope/,
    );
  });
});
