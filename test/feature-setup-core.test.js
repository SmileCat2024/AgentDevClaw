/**
 * Tests for public/src/modules/feature-setup-core.js
 *
 * 覆盖两态配置编辑器（跟随 / 接管）的纯逻辑：
 *   - 点路径原语（fsGetPathValue / fsHasField / fsSetPath / fsDeletePath）
 *   - 两态分类（fsClassifyField / fsFieldStates）：接管（存在即接管）/ 跟随
 *   - dirty 叠加（fsApplyDirty）与控件取值（fsControlValue）
 *   - 保存 payload（fsBuildLayerContent，diff-only 稀疏核心）
 *   - manifest 查找（fsPropFor）与目录名（fsBaseName）
 *
 * 对象断言走 JSON.parse + JSON.stringify，避免跨 VM realm 比较；
 * 多语句用例经 runBlock（IIFE）执行，隔离词法作用域避免重复 const 声明。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFrontendSandbox } from './helpers/frontend-vm.js';

function loadCore() {
  const ctx = createFrontendSandbox({ currentLanguage: 'en' });
  ctx.loadSource('public/src/modules/feature-setup-core.js');
  return ctx;
}

/** 沙箱内执行多语句块并返回末尾表达式的值。 */
function runBlock(ctx, code) {
  return ctx.run(`(() => { ${code} })()`);
}

/** 典型两层配置（全局 + 目录），用于两态分类测试。 */
const TYPED_LAYERS = `[
  { id: 'global', label: 'Global', sparse: {
      lsp: { typescript: { mode: 'exec' }, nodePath: '/usr/bin/node' },
      shell: { bashEnabled: true }
  } },
  { id: 'dir:/proj/a', label: 'Directory · a', sparse: {
      lsp: { typescript: { mode: 'runtime' } }
  } }
]`;

// ── 点路径原语 ────────────────────────────────────────────────

describe('feature-setup-core: fsGetPathValue', () => {
  const ctx = loadCore();

  it('returns nested leaf values', () => {
    assert.equal(ctx.run(`fsGetPathValue({ a: { b: { c: 1 } } }, ['a','b','c'])`), 1);
  });

  it('returns undefined when a segment is missing', () => {
    assert.equal(ctx.run(`fsGetPathValue({ a: {} }, ['a','b','c'])`), undefined);
  });

  it('returns undefined when traversal hits a scalar', () => {
    assert.equal(ctx.run(`fsGetPathValue({ a: 1 }, ['a','b'])`), undefined);
  });
});

describe('feature-setup-core: fsHasField', () => {
  const ctx = loadCore();

  it('returns true for existing key (存在即接管)', () => {
    assert.equal(ctx.run(`fsHasField({ a: { b: 0 } }, ['a','b'])`), true);
  });

  it('returns true for existing key with empty-string value', () => {
    assert.equal(ctx.run(`fsHasField({ a: { b: '' } }, ['a','b'])`), true);
  });

  it('returns false when key absent', () => {
    assert.equal(ctx.run(`fsHasField({ a: {} }, ['a','b'])`), false);
  });

  it('returns false when parent missing', () => {
    assert.equal(ctx.run(`fsHasField(null, ['a','b'])`), false);
  });
});

describe('feature-setup-core: fsSetPath', () => {
  const ctx = loadCore();

  it('creates nested containers on demand', () => {
    const r = runBlock(ctx, `const o = {}; fsSetPath(o, ['a','b','c'], 1); return JSON.stringify(o);`);
    assert.deepEqual(JSON.parse(r), { a: { b: { c: 1 } } });
  });

  it('replaces scalar mid-path with object', () => {
    const r = runBlock(ctx, `const o = { a: 1 }; fsSetPath(o, ['a','b'], 2); return JSON.stringify(o);`);
    assert.deepEqual(JSON.parse(r), { a: { b: 2 } });
  });
});

describe('feature-setup-core: fsDeletePath', () => {
  const ctx = loadCore();

  it('deletes the leaf and prunes empty containers', () => {
    const r = runBlock(ctx, `const o = { a: { b: { c: 1 } }, keep: 2 }; fsDeletePath(o, ['a','b','c']); return JSON.stringify(o);`);
    assert.deepEqual(JSON.parse(r), { keep: 2 });
  });

  it('keeps containers that still hold siblings', () => {
    const r = runBlock(ctx, `const o = { a: { b: { c: 1, d: 2 } } }; fsDeletePath(o, ['a','b','c']); return JSON.stringify(o);`);
    assert.deepEqual(JSON.parse(r), { a: { b: { d: 2 } } });
  });

  it('is a no-op when path missing', () => {
    const r = runBlock(ctx, `const o = { a: 1 }; fsDeletePath(o, ['x','y']); return JSON.stringify(o);`);
    assert.deepEqual(JSON.parse(r), { a: 1 });
  });
});

// ── 两态分类 ─────────────────────────────────────────────────

describe('feature-setup-core: fsClassifyField', () => {
  const ctx = loadCore();

  it('takeover: 本层存在该字段（存在即接管）', () => {
    const r = runBlock(ctx, `
      const layers = ${TYPED_LAYERS};
      return JSON.stringify(fsClassifyField('lsp.typescript.mode', 1, layers));
    `);
    assert.deepEqual(JSON.parse(r), {
      status: 'takeover',
      layerValue: 'runtime',
      upstream: { kind: 'layer', value: 'exec', label: 'Global', layerId: 'global' },
    });
  });

  it('接管值与上游相同仍为 takeover（无值同特判）', () => {
    const r = runBlock(ctx, `
      const layers = ${TYPED_LAYERS};
      layers[1].sparse.lsp.typescript.mode = 'exec';
      return fsClassifyField('lsp.typescript.mode', 1, layers).status;
    `);
    assert.equal(r, 'takeover');
  });

  it('follow: 本层无 + 上游有（携带上游层信息）', () => {
    const r = runBlock(ctx, `
      const layers = ${TYPED_LAYERS};
      return JSON.stringify(fsClassifyField('lsp.nodePath', 1, layers));
    `);
    assert.deepEqual(JSON.parse(r), {
      status: 'follow',
      upstream: { kind: 'layer', value: '/usr/bin/node', label: 'Global', layerId: 'global' },
    });
  });

  it('follow: 本层无 + 上游无（出厂默认虚拟上游）', () => {
    const r = runBlock(ctx, `return JSON.stringify(fsClassifyField('shell.missing', 1, ${TYPED_LAYERS}));`);
    assert.deepEqual(JSON.parse(r), {
      status: 'follow',
      upstream: { kind: 'default', label: null, layerId: null },
    });
  });

  it('global 层自身字段（无更早层）→ 存在即 takeover', () => {
    const r = runBlock(ctx, `return fsClassifyField('shell.bashEnabled', 0, ${TYPED_LAYERS}).status;`);
    assert.equal(r, 'takeover');
  });

  it('takeover 态携带 upstream（供重置后显示生效值）', () => {
    const r = runBlock(ctx, `return fsClassifyField('shell.bashEnabled', 0, ${TYPED_LAYERS}).upstream.kind;`);
    assert.equal(r, 'default');
  });

  it('层越界返回 follow + 默认上游', () => {
    const r = runBlock(ctx, `return JSON.stringify(fsClassifyField('lsp.typescript.mode', 5, ${TYPED_LAYERS}));`);
    assert.deepEqual(JSON.parse(r), {
      status: 'follow',
      upstream: { kind: 'default', label: null, layerId: null },
    });
  });

  it('多层命中时取最近上游层（索引最大）', () => {
    const r = runBlock(ctx, `
      const layers = [
        { id: 'global', sparse: { a: { x: 1 } } },
        { id: 'agent', sparse: { a: { x: 2 } } },
        { id: 'dir:/top', sparse: {} },
      ];
      return fsClassifyField('a.x', 2, layers).upstream.layerId;
    `);
    assert.equal(r, 'agent');
  });

  it('无 label 的上游层回退 #N', () => {
    const r = runBlock(ctx, `
      const layers = [{ id: 'g', sparse: { a: { x: 1 } } }, { id: 'd', sparse: {} }];
      return fsClassifyField('a.x', 1, layers).upstream.label;
    `);
    assert.equal(r, '#1');
  });
});

describe('feature-setup-core: fsFieldStates', () => {
  const ctx = loadCore();

  const SECTIONS = `[
    { featureName: 'lsp', propKeys: ['typescript', 'nodePath'], props: {
        typescript: { type: 'group', properties: { mode: { type: 'string' }, strict: { type: 'boolean' } } },
        nodePath: { type: 'string' } } },
    { featureName: 'shell', propKeys: ['bashEnabled'], props: { bashEnabled: { type: 'boolean' } } },
  ]`;

  it('展开 group 子字段与非 group 字段', () => {
    const keys = runBlock(ctx, `
      const sections = ${SECTIONS};
      return JSON.stringify([...fsFieldStates(sections, ${TYPED_LAYERS}, 'dir:/proj/a').keys()]);
    `);
    assert.deepEqual(JSON.parse(keys), [
      'lsp.typescript.mode',
      'lsp.typescript.strict',
      'lsp.nodePath',
      'shell.bashEnabled',
    ]);
  });

  it('scopeId 不在 layers 中返回空表', () => {
    const size = runBlock(ctx, `return fsFieldStates(${SECTIONS}, ${TYPED_LAYERS}, 'dir:/nope').size;`);
    assert.equal(size, 0);
  });

  it('propKeys 中缺失的 prop 定义被跳过', () => {
    const keys = runBlock(ctx, `
      const sections = [{ featureName: 'x', propKeys: ['a', 'ghost'], props: { a: { type: 'string' } } }];
      const layers = [{ id: 'global', sparse: {} }];
      return JSON.stringify([...fsFieldStates(sections, layers, 'global').keys()]);
    `);
    assert.deepEqual(JSON.parse(keys), ['x.a']);
  });
});

// ── dirty 叠加与控件取值 ─────────────────────────────────────

describe('feature-setup-core: fsApplyDirty', () => {
  const ctx = loadCore();

  const BASE_STATES = `new Map([
    ['a.over', { status: 'takeover', layerValue: 1, upstream: { kind: 'layer', value: 0, label: 'Global', layerId: 'global' } }],
    ['a.inh', { status: 'follow', upstream: { kind: 'layer', value: 2, label: 'Global', layerId: 'global' } }],
    ['a.def', { status: 'follow', upstream: { kind: 'default', value: undefined, label: null, layerId: null } }],
  ])`;

  it('null（重置为跟随）+ 有上游 → follow（保留 upstream 显示生效值）', () => {
    const r = runBlock(ctx, `
      const dirty = new Map([['a.over', { value: null }]]);
      return JSON.stringify(fsApplyDirty(${BASE_STATES}, dirty).get('a.over'));
    `);
    assert.deepEqual(JSON.parse(r), {
      status: 'follow',
      upstream: { kind: 'layer', value: 0, label: 'Global', layerId: 'global' },
    });
  });

  it('null + 无上游 → follow（出厂默认虚拟上游）', () => {
    const r = runBlock(ctx, `
      const dirty = new Map([['a.def', { value: null }]]);
      return JSON.stringify(fsApplyDirty(${BASE_STATES}, dirty).get('a.def'));
    `);
    assert.deepEqual(JSON.parse(r), {
      status: 'follow',
      upstream: { kind: 'default', label: null, layerId: null },
    });
  });

  it('null 重置 takeover 缺 upstream 时补默认虚拟上游', () => {
    const r = runBlock(ctx, `
      const base = new Map([['a.raw', { status: 'takeover', layerValue: 7 }]]);
      return JSON.stringify(fsApplyDirty(base, new Map([['a.raw', { value: null }]])).get('a.raw'));
    `);
    assert.deepEqual(JSON.parse(r), {
      status: 'follow',
      upstream: { kind: 'default', label: null, layerId: null },
    });
  });

  it('新值 → takeover + pendingValue（与上游相同也照写，无值同特判）', () => {
    const r = runBlock(ctx, `
      const dirty = new Map([['a.inh', { value: 2 }]]);
      return JSON.stringify(fsApplyDirty(${BASE_STATES}, dirty).get('a.inh'));
    `);
    assert.deepEqual(JSON.parse(r), {
      status: 'takeover',
      upstream: { kind: 'layer', value: 2, label: 'Global', layerId: 'global' },
      pendingValue: 2,
    });
  });

  it('base 中不存在的 key 被跳过', () => {
    const size = runBlock(ctx, `
      const dirty = new Map([['a.unknown', { value: 1 }]]);
      return fsApplyDirty(${BASE_STATES}, dirty).size;
    `);
    assert.equal(size, 3);
  });
});

describe('feature-setup-core: fsControlValue', () => {
  const ctx = loadCore();

  it('takeover 优先 pendingValue，其次 layerValue', () => {
    assert.equal(ctx.run(`fsControlValue({ status: 'takeover', pendingValue: 5, layerValue: 1 })`), 5);
    assert.equal(ctx.run(`fsControlValue({ status: 'takeover', layerValue: 1 })`), 1);
  });

  it('follow + 上游层 → 上游生效值', () => {
    assert.equal(ctx.run(`fsControlValue({ status: 'follow', upstream: { kind: 'layer', value: 'exec' } })`), 'exec');
  });

  it('follow + 出厂默认 → manifest default', () => {
    assert.equal(ctx.run(`fsControlValue({ status: 'follow' }, { default: 'x' })`), 'x');
    assert.equal(ctx.run(`fsControlValue(null, { default: 'x' })`), 'x');
    assert.equal(ctx.run(`fsControlValue(undefined, {})`), undefined);
  });
});

// ── 保存 payload（diff-only 稀疏核心）─────────────────────────

describe('feature-setup-core: fsBuildLayerContent', () => {
  const ctx = loadCore();

  it('未碰字段原样保留（以原始 sparse 为底）', () => {
    const r = runBlock(ctx, `
      const dirty = new Map([['shell.bashEnabled', { value: false }]]);
      return JSON.stringify(fsBuildLayerContent(${TYPED_LAYERS}, 'dir:/proj/a', dirty));
    `);
    assert.deepEqual(JSON.parse(r), {
      lsp: { typescript: { mode: 'runtime' } },
      shell: { bashEnabled: false },
    });
  });

  it('set 覆盖本层已有字段', () => {
    const r = runBlock(ctx, `
      const dirty = new Map([['lsp.typescript.mode', { value: 'auto' }]]);
      return JSON.stringify(fsBuildLayerContent(${TYPED_LAYERS}, 'dir:/proj/a', dirty));
    `);
    assert.deepEqual(JSON.parse(r), { lsp: { typescript: { mode: 'auto' } } });
  });

  it('delete（null 重置）移除字段并剪枝空容器', () => {
    const r = runBlock(ctx, `
      const dirty = new Map([['lsp.typescript.mode', { value: null }]]);
      return JSON.stringify(fsBuildLayerContent(${TYPED_LAYERS}, 'dir:/proj/a', dirty));
    `);
    assert.deepEqual(JSON.parse(r), {});
  });

  it('稀疏性：只碰一个字段 → diff 恰好只有该字段', () => {
    const r = runBlock(ctx, `
      const layers = [
        { id: 'global', sparse: { lsp: { a: 1, b: 2, c: 3 } } },
        { id: 'dir:/p', sparse: { shell: { x: 'keep' }, other: { y: 1 } } },
      ];
      const dirty = new Map([['shell.x', { value: 'touched' }]]);
      return JSON.stringify(fsBuildLayerContent(layers, 'dir:/p', dirty));
    `);
    // 未碰的 other.* 与 shell 兄弟结构原样保留；唯一的值变化是 shell.x
    assert.deepEqual(JSON.parse(r), { shell: { x: 'touched' }, other: { y: 1 } });
  });

  it('层无 sparse（层文件不存在）从空对象构造', () => {
    const r = runBlock(ctx, `
      const layers = [{ id: 'global', sparse: { a: 1 } }, { id: 'dir:/new' }];
      const dirty = new Map([['b.c', { value: 2 }]]);
      return JSON.stringify(fsBuildLayerContent(layers, 'dir:/new', dirty));
    `);
    assert.deepEqual(JSON.parse(r), { b: { c: 2 } });
  });

  it('scopeId 找不到返回 null', () => {
    assert.equal(
      runBlock(ctx, `return fsBuildLayerContent(${TYPED_LAYERS}, 'dir:/ghost', new Map());`),
      null
    );
  });

  it('不变异原始层 sparse', () => {
    ctx.run(`globalThis.__snap = JSON.stringify((${TYPED_LAYERS})[0].sparse);`);
    runBlock(ctx, `
      const layers = ${TYPED_LAYERS};
      fsBuildLayerContent(layers, 'dir:/proj/a', new Map([['lsp.nodePath', { value: '/x' }]]));
      return null;
    `);
    const after = JSON.parse(ctx.run(`globalThis.__snap`));
    assert.deepEqual(after, {
      lsp: { typescript: { mode: 'exec' }, nodePath: '/usr/bin/node' },
      shell: { bashEnabled: true },
    });
  });
});

// ── manifest 查找与目录名 ─────────────────────────────────────

describe('feature-setup-core: fsBaseName', () => {
  const ctx = loadCore();

  it('linux / windows 分隔符与尾部斜杠', () => {
    assert.equal(ctx.run(`fsBaseName('/home/dev/proj')`), 'proj');
    assert.equal(ctx.run(`fsBaseName('D:\\\\code\\\\proj\\\\')`), 'proj');
  });

  it('空输入返回原样字符串', () => {
    assert.equal(ctx.run(`fsBaseName('')`), '');
  });
});

describe('feature-setup-core: fsPropFor', () => {
  const ctx = loadCore();

  const SECTIONS = `[
    { featureName: 'lsp', props: {
        typescript: { type: 'group', properties: { mode: { type: 'string', default: 'exec' } } },
        nodePath: { type: 'string' } } },
  ]`;

  it('两段命中普通字段', () => {
    assert.equal(ctx.run(`fsPropFor(${SECTIONS}, 'lsp.nodePath').type`), 'string');
  });

  it('三段命中 group 子字段', () => {
    assert.equal(ctx.run(`fsPropFor(${SECTIONS}, 'lsp.typescript.mode').default`), 'exec');
  });

  it('两段指向 group / 未知 feature / 单段 → null', () => {
    assert.equal(ctx.run(`fsPropFor(${SECTIONS}, 'lsp.typescript')`), null);
    assert.equal(ctx.run(`fsPropFor(${SECTIONS}, 'ghost.x')`), null);
    assert.equal(ctx.run(`fsPropFor(${SECTIONS}, 'lsp')`), null);
  });
});
