/**
 * Tests for public/src/modules/feature-setup-core.js
 *
 * 覆盖两态配置编辑器（跟随 / 接管）的纯逻辑：
 *   - 点路径原语（fsGetPathValue / fsHasField / fsSetPath / fsDeletePath）
 *   - 两态分类（fsClassifyField / fsFieldStates）：接管（存在即接管）/ 跟随
 *   - 控件取值（fsControlValue）
 *   - 即时保存（fsWithField，单字段 set/delete 稀疏核心）
 *   - manifest 查找（fsPropFor）与目录名（fsBaseName）
 *
 * ESM 化（P2 迁移批次 6）：装载路线从 frontend-vm 沙箱（loadSource）改为真实
 * import（esm-module-loader，唯一 query 拿全新实例）。模块是纯逻辑、无模块
 * 状态、无宿主全局引用，因此不需要任何桩面；断言从「沙箱内表达式」改为
 * 直接调用导入的命名导出。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadModuleOnce } from './helpers/esm-module-loader.js';

let core;

before(async () => {
  // 模块无模块状态、无宿主全局引用：不装浏览器桩（installGlobals: false），
  // 避免装桩却没人调用 cleanup 造成全局泄漏
  const { module } = await loadModuleOnce('public/src/modules/feature-setup-core.js', { installGlobals: false });
  core = module;
});

/** 典型两层配置（全局 + 目录），用于两态分类测试。 */
const TYPED_LAYERS = () => ([
  {
    id: 'global',
    label: 'Global',
    sparse: {
      lsp: { typescript: { mode: 'exec' }, nodePath: '/usr/bin/node' },
      shell: { bashEnabled: true },
    },
  },
  { id: 'dir:/proj/a', label: 'Directory · a', sparse: { lsp: { typescript: { mode: 'runtime' } } } },
]);

// ── 点路径原语 ────────────────────────────────────────────────

describe('feature-setup-core: fsGetPathValue', () => {
  it('returns nested leaf values', () => {
    assert.equal(core.fsGetPathValue({ a: { b: { c: 1 } } }, ['a', 'b', 'c']), 1);
  });

  it('returns undefined when a segment is missing', () => {
    assert.equal(core.fsGetPathValue({ a: {} }, ['a', 'b', 'c']), undefined);
  });

  it('returns undefined when traversal hits a scalar', () => {
    assert.equal(core.fsGetPathValue({ a: 1 }, ['a', 'b']), undefined);
  });
});

describe('feature-setup-core: fsHasField', () => {
  it('returns true for existing key (存在即接管)', () => {
    assert.equal(core.fsHasField({ a: { b: 0 } }, ['a', 'b']), true);
  });

  it('returns true for existing key with empty-string value', () => {
    assert.equal(core.fsHasField({ a: { b: '' } }, ['a', 'b']), true);
  });

  it('returns false when key absent', () => {
    assert.equal(core.fsHasField({ a: {} }, ['a', 'b']), false);
  });

  it('returns false when parent missing', () => {
    assert.equal(core.fsHasField(null, ['a', 'b']), false);
  });
});

describe('feature-setup-core: fsSetPath', () => {
  it('creates nested containers on demand', () => {
    const o = {};
    core.fsSetPath(o, ['a', 'b', 'c'], 1);
    assert.deepEqual(o, { a: { b: { c: 1 } } });
  });

  it('replaces scalar mid-path with object', () => {
    const o = { a: 1 };
    core.fsSetPath(o, ['a', 'b'], 2);
    assert.deepEqual(o, { a: { b: 2 } });
  });
});

describe('feature-setup-core: fsDeletePath', () => {
  it('deletes the leaf and prunes empty containers', () => {
    const o = { a: { b: { c: 1 } }, keep: 2 };
    core.fsDeletePath(o, ['a', 'b', 'c']);
    assert.deepEqual(o, { keep: 2 });
  });

  it('keeps containers that still hold siblings', () => {
    const o = { a: { b: { c: 1, d: 2 } } };
    core.fsDeletePath(o, ['a', 'b', 'c']);
    assert.deepEqual(o, { a: { b: { d: 2 } } });
  });

  it('is a no-op when path missing', () => {
    const o = { a: 1 };
    core.fsDeletePath(o, ['x', 'y']);
    assert.deepEqual(o, { a: 1 });
  });
});

// ── 两态分类 ─────────────────────────────────────────────────

describe('feature-setup-core: fsClassifyField', () => {
  it('takeover: 本层存在该字段（存在即接管）', () => {
    assert.deepEqual(core.fsClassifyField('lsp.typescript.mode', 1, TYPED_LAYERS()), {
      status: 'takeover',
      layerValue: 'runtime',
      upstream: { kind: 'layer', value: 'exec', label: 'Global', layerId: 'global' },
    });
  });

  it('接管值与上游相同仍为 takeover（无值同特判）', () => {
    const layers = TYPED_LAYERS();
    layers[1].sparse.lsp.typescript.mode = 'exec';
    assert.equal(core.fsClassifyField('lsp.typescript.mode', 1, layers).status, 'takeover');
  });

  it('follow: 本层无 + 上游有（携带上游层信息）', () => {
    assert.deepEqual(core.fsClassifyField('lsp.nodePath', 1, TYPED_LAYERS()), {
      status: 'follow',
      upstream: { kind: 'layer', value: '/usr/bin/node', label: 'Global', layerId: 'global' },
    });
  });

  it('follow: 本层无 + 上游无（出厂默认虚拟上游）', () => {
    assert.deepEqual(core.fsClassifyField('shell.missing', 1, TYPED_LAYERS()), {
      status: 'follow',
      upstream: { kind: 'default', value: undefined, label: null, layerId: null },
    });
  });

  it('global 层自身字段（无更早层）→ 存在即 takeover', () => {
    assert.equal(core.fsClassifyField('shell.bashEnabled', 0, TYPED_LAYERS()).status, 'takeover');
  });

  it('takeover 态携带 upstream（供重置后显示生效值）', () => {
    assert.equal(core.fsClassifyField('shell.bashEnabled', 0, TYPED_LAYERS()).upstream.kind, 'default');
  });

  it('层越界返回 follow + 默认上游', () => {
    assert.deepEqual(core.fsClassifyField('lsp.typescript.mode', 5, TYPED_LAYERS()), {
      status: 'follow',
      upstream: { kind: 'default', value: undefined, label: null, layerId: null },
    });
  });

  it('多层命中时取最近上游层（索引最大）', () => {
    const layers = [
      { id: 'global', sparse: { a: { x: 1 } } },
      { id: 'agent', sparse: { a: { x: 2 } } },
      { id: 'dir:/top', sparse: {} },
    ];
    assert.equal(core.fsClassifyField('a.x', 2, layers).upstream.layerId, 'agent');
  });

  it('无 label 的上游层回退 #N', () => {
    const layers = [{ id: 'g', sparse: { a: { x: 1 } } }, { id: 'd', sparse: {} }];
    assert.equal(core.fsClassifyField('a.x', 1, layers).upstream.label, '#1');
  });
});

describe('feature-setup-core: fsFieldStates', () => {
  const SECTIONS = () => ([
    {
      featureName: 'lsp',
      propKeys: ['typescript', 'nodePath'],
      props: {
        typescript: { type: 'group', properties: { mode: { type: 'string' }, strict: { type: 'boolean' } } },
        nodePath: { type: 'string' },
      },
    },
    { featureName: 'shell', propKeys: ['bashEnabled'], props: { bashEnabled: { type: 'boolean' } } },
  ]);

  it('展开 group 子字段与非 group 字段', () => {
    const keys = [...core.fsFieldStates(SECTIONS(), TYPED_LAYERS(), 'dir:/proj/a').keys()];
    assert.deepEqual(keys, [
      'lsp.typescript.mode',
      'lsp.typescript.strict',
      'lsp.nodePath',
      'shell.bashEnabled',
    ]);
  });

  it('scopeId 不在 layers 中返回空表', () => {
    assert.equal(core.fsFieldStates(SECTIONS(), TYPED_LAYERS(), 'dir:/nope').size, 0);
  });

  it('propKeys 中缺失的 prop 定义被跳过', () => {
    const sections = [{ featureName: 'x', propKeys: ['a', 'ghost'], props: { a: { type: 'string' } } }];
    const layers = [{ id: 'global', sparse: {} }];
    assert.deepEqual([...core.fsFieldStates(sections, layers, 'global').keys()], ['x.a']);
  });
});

// ── 控件取值与即时保存 ───────────────────────────────────────

describe('feature-setup-core: fsControlValue', () => {
  it('takeover 取本层值', () => {
    assert.equal(core.fsControlValue({ status: 'takeover', layerValue: 1 }), 1);
  });

  it('follow + 上游层 → 上游生效值', () => {
    assert.equal(core.fsControlValue({ status: 'follow', upstream: { kind: 'layer', value: 'exec' } }), 'exec');
  });

  it('follow + 出厂默认 → manifest default', () => {
    assert.equal(core.fsControlValue({ status: 'follow' }, { default: 'x' }), 'x');
    assert.equal(core.fsControlValue(null, { default: 'x' }), 'x');
    assert.equal(core.fsControlValue(undefined, {}), undefined);
  });
});

// ── 重置按钮显示条件（语义按层区分）───────────────────────────

describe('feature-setup-core: fsShowReset', () => {
  it('follow 态一律不显示', () => {
    assert.equal(core.fsShowReset('global', { status: 'follow' }, { default: 1 }), false);
    assert.equal(core.fsShowReset('dir:/p', { status: 'follow' }, {}), false);
    assert.equal(core.fsShowReset('agent', null, {}), false);
  });

  it('全局层：接管值等于出厂默认时不显示（按钮无意义）', () => {
    assert.equal(core.fsShowReset('global', { status: 'takeover', layerValue: 5 }, { default: 5 }), false);
    assert.equal(core.fsShowReset('global', { status: 'takeover', layerValue: ['a', 'b'] }, { default: ['b', 'a'] }), true);
  });

  it('agent / 目录层：接管即显示（值相同也存在锁定需解除）', () => {
    assert.equal(core.fsShowReset('agent', { status: 'takeover', layerValue: 5 }, { default: 5 }), true);
    assert.equal(core.fsShowReset('dir:/p', { status: 'takeover', layerValue: 5 }, {}), true);
  });
});

// ── 即时保存（单字段写入稀疏核心）─────────────────────────────

describe('feature-setup-core: fsWithField', () => {
  const DIR_SPARSE = () => TYPED_LAYERS()[1].sparse;

  it('set 新字段：未碰字段原样保留（以层 sparse 为底）', () => {
    assert.deepEqual(core.fsWithField(DIR_SPARSE(), 'shell.bashEnabled', false), {
      lsp: { typescript: { mode: 'runtime' } },
      shell: { bashEnabled: false },
    });
  });

  it('set 覆盖本层已有字段', () => {
    assert.deepEqual(core.fsWithField(DIR_SPARSE(), 'lsp.typescript.mode', 'auto'), {
      lsp: { typescript: { mode: 'auto' } },
    });
  });

  it('delete（null 重置）移除字段并剪枝空容器', () => {
    assert.deepEqual(core.fsWithField(DIR_SPARSE(), 'lsp.typescript.mode', null), {});
  });

  it('delete 不存在的字段：无异常、内容不变', () => {
    assert.deepEqual(core.fsWithField({ shell: { x: 1 } }, 'lsp.ghost', null), { shell: { x: 1 } });
  });

  it('值等于上游也照写（存在即接管，无值同特判）', () => {
    assert.deepEqual(core.fsWithField({}, 'shell.bashEnabled', true), { shell: { bashEnabled: true } });
  });

  it('sparse 缺失（层文件不存在）从空对象构造', () => {
    assert.deepEqual(core.fsWithField(undefined, 'b.c', 2), { b: { c: 2 } });
  });

  it('不变异原始层 sparse', () => {
    const sparse = DIR_SPARSE();
    const snapshot = JSON.stringify(sparse);
    core.fsWithField(sparse, 'lsp.nodePath', '/x');
    assert.equal(JSON.stringify(sparse), snapshot);
    assert.deepEqual(sparse, { lsp: { typescript: { mode: 'runtime' } } });
  });
});

// ── manifest 查找与目录名 ─────────────────────────────────────

describe('feature-setup-core: fsBaseName', () => {
  it('linux / windows 分隔符与尾部斜杠', () => {
    assert.equal(core.fsBaseName('/home/dev/proj'), 'proj');
    assert.equal(core.fsBaseName('D:\\code\\proj\\'), 'proj');
  });

  it('空输入返回原样字符串', () => {
    assert.equal(core.fsBaseName(''), '');
  });
});

describe('feature-setup-core: fsPropFor', () => {
  const SECTIONS = () => ([
    {
      featureName: 'lsp',
      props: {
        typescript: { type: 'group', properties: { mode: { type: 'string', default: 'exec' } } },
        nodePath: { type: 'string' },
      },
    },
  ]);

  it('两段命中普通字段', () => {
    assert.equal(core.fsPropFor(SECTIONS(), 'lsp.nodePath').type, 'string');
  });

  it('三段命中 group 子字段', () => {
    assert.equal(core.fsPropFor(SECTIONS(), 'lsp.typescript.mode').default, 'exec');
  });

  it('两段指向 group / 未知 feature / 单段 → null', () => {
    assert.equal(core.fsPropFor(SECTIONS(), 'lsp.typescript'), null);
    assert.equal(core.fsPropFor(SECTIONS(), 'ghost.x'), null);
    assert.equal(core.fsPropFor(SECTIONS(), 'lsp'), null);
  });
});
