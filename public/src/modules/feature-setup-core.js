/**
 * feature-setup-core.js — Feature 配置三态编辑器纯逻辑（ticket 06）
 *
 * 从 feature-setup-ui.js 提取的无 DOM / 无全局状态依赖部分：
 *   - 点路径原语（fsGetPathValue / fsHasField / fsSetPath / fsDeletePath）
 *   - 三态分类（fsUpstreamInfo / fsClassifyField / fsFieldStates）：
 *     覆盖 = 本层 sparse 存在该字段（存在即覆盖，D8）；
 *     继承 = 本层无 + 上游层有；出厂默认 = 本层无 + 上游无（manifest default 虚拟第 0 层）
 *   - dirty 叠加（fsApplyDirty）：value === null 表示"重置为继承"
 *   - 保存 payload 构造（fsBuildLayerContent，diff only D9）：
 *     以原始 sparse 为底仅套用本次会话碰过的字段，未碰字段绝不写入
 *   - 值同判定（fsValuesEqual，D8）：数组排序归一 / 布尔字符串化 / trim
 *   - 作用域构建（fsBuildScopes / fsBaseName / fsPropFor）
 *
 * UI 模块（feature-setup-ui.js）持有状态并调用这些函数；
 * 测试见 test/feature-setup-core.test.js（frontend-vm 沙箱）。
 */

// ── 点路径原语 ────────────────────────────────────────────────

function fsGetPathValue(obj, segs) {
  let cur = obj;
  for (const seg of segs) {
    if (!cur || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function fsHasField(obj, segs) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (!cur || typeof cur !== 'object' || !(segs[i] in cur)) return false;
    cur = cur[segs[i]];
  }
  return !!cur && typeof cur === 'object' && (segs[segs.length - 1] in cur);
}

function fsSetPath(obj, segs, value) {
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (cur[segs[i]] == null || typeof cur[segs[i]] !== 'object') cur[segs[i]] = {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
}

function fsDeletePath(obj, segs) {
  const del = (cur, i) => {
    if (!cur || typeof cur !== 'object') return;
    const seg = segs[i];
    if (i === segs.length - 1) {
      delete cur[seg];
      return;
    }
    if (!(seg in cur)) return;
    del(cur[seg], i + 1);
    if (Object.keys(cur[seg]).length === 0) delete cur[seg];
  };
  del(obj, 0);
}

// ── 三态分类（判定数据全部来自 resolved layers，前端不自算合并）──

/** 上游信息：早于本层、最后包含该字段的层；都没有则是出厂默认（虚拟第 0 层）。 */
function fsUpstreamInfo(fullKey, layerIndex, layers) {
  for (let i = layerIndex - 1; i >= 0; i--) {
    const segs = fullKey.split('.');
    if (fsHasField(layers[i]?.sparse, segs)) {
      return {
        kind: 'layer',
        value: fsGetPathValue(layers[i].sparse, segs),
        label: layers[i].label || `#${i + 1}`,
        layerId: layers[i].id,
      };
    }
  }
  return { kind: 'default', value: undefined, label: null, layerId: null };
}

/** 基于层稀疏内容的三态分类（不含本次会话的 dirty 修正）。 */
function fsClassifyField(fullKey, layerIndex, layers) {
  const local = layers[layerIndex];
  if (!local) return { status: 'default' };
  const segs = fullKey.split('.');
  const inLocal = fsHasField(local.sparse, segs);
  const upstream = fsUpstreamInfo(fullKey, layerIndex, layers);
  if (inLocal) {
    return { status: 'override', layerValue: fsGetPathValue(local.sparse, segs), upstream };
  }
  if (upstream.kind === 'layer') {
    return { status: 'inherit', upstream };
  }
  return { status: 'default' };
}

/** 全部 manifest 字段的三态表（不含 dirty）。sections 为 UI 侧 _buildSections 产物。 */
function fsFieldStates(sections, layers, activeScopeId) {
  const idx = layers.findIndex((l) => l.id === activeScopeId);
  const map = new Map();
  if (idx < 0) return map;
  for (const sec of sections) {
    const props = sec.props || {};
    for (const key of sec.propKeys) {
      const prop = props[key];
      if (!prop) continue;
      if (prop.type === 'group') {
        for (const sk of Object.keys(prop.properties || {})) {
          const fullKey = `${sec.featureName}.${key}.${sk}`;
          map.set(fullKey, fsClassifyField(fullKey, idx, layers));
        }
      } else {
        const fullKey = `${sec.featureName}.${key}`;
        map.set(fullKey, fsClassifyField(fullKey, idx, layers));
      }
    }
  }
  return map;
}

/** 叠加本次会话 dirty 后的渲染用三态表（就地修改 base Map）。 */
function fsApplyDirty(baseStates, dirty) {
  for (const [fullKey, entry] of dirty) {
    const cur = baseStates.get(fullKey);
    if (!cur) continue;
    if (entry.value === null) {
      // 本会话已重置 → 按继承/出厂默认显示
      baseStates.set(fullKey, cur.upstream?.kind === 'layer'
        ? { status: 'inherit', upstream: cur.upstream }
        : { status: 'default' });
    } else {
      baseStates.set(fullKey, { ...cur, status: 'override', pendingValue: entry.value });
    }
  }
  return baseStates;
}

/** 控件初值：覆盖→本层（或待保存）值；继承→上游生效值；出厂默认→manifest default。 */
function fsControlValue(state, prop) {
  if (state?.status === 'override') {
    return state.pendingValue !== undefined ? state.pendingValue : state.layerValue;
  }
  if (state?.status === 'inherit') {
    return state.upstream?.value;
  }
  return prop?.default;
}

// ── 保存 payload 构造（diff only，D9）─────────────────────────

/** 该层稀疏内容 = 原始 sparse 为底（深拷贝），仅套用本次会话碰过的字段。 */
function fsBuildLayerContent(layers, activeScopeId, dirty) {
  const idx = layers.findIndex((l) => l.id === activeScopeId);
  if (idx < 0) return null;
  const content = JSON.parse(JSON.stringify(layers[idx].sparse || {}));
  for (const [fullKey, entry] of dirty) {
    const segs = fullKey.split('.');
    if (entry.value === null) {
      fsDeletePath(content, segs);
    } else {
      fsSetPath(content, segs, entry.value);
    }
  }
  return content;
}

// ── 值同判定（D8：值 == 上游生效值时 UI 提示二选一）──────────

function fsNormVal(v) {
  if (Array.isArray(v)) {
    return v.map((x) => String(x ?? '').trim()).filter(Boolean).sort().join('\u0001');
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v ?? '').trim();
}

function fsValuesEqual(a, b) {
  return fsNormVal(a) === fsNormVal(b);
}

// ── 作用域构建与字段查找 ──────────────────────────────────────

function fsBaseName(dir) {
  const parts = String(dir || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(dir || '');
}

/** 作用域列表：全局 + 各目录（dirs 由 UI 侧采集；resolved 层目录也纳入，大小写去重）。 */
function fsBuildScopes(resolved, dirs, t) {
  const scopes = [{ id: 'global', label: t('全局', 'Global') }];
  const list = [...dirs];
  for (const layer of (Array.isArray(resolved?.layers) ? resolved.layers : [])) {
    if (typeof layer?.id === 'string' && layer.id.startsWith('dir:')) {
      const dir = layer.id.slice(4);
      if (!list.some((d) => d.toLowerCase() === dir.toLowerCase())) list.push(dir);
    }
  }
  for (const dir of list) {
    scopes.push({
      id: `dir:${dir}`,
      label: `${t('目录', 'Directory')} · ${fsBaseName(dir)}`,
      dir,
    });
  }
  return scopes;
}

/** 按 fullKey（feature[.group].prop）在 sections 中找 manifest 属性定义。 */
function fsPropFor(sections, fullKey) {
  const segs = String(fullKey || '').split('.');
  if (segs.length < 2) return null;
  for (const sec of sections) {
    if (sec.featureName !== segs[0]) continue;
    const prop = sec.props?.[segs[1]];
    if (!prop) continue;
    if (segs.length === 2) return prop.type === 'group' ? null : prop;
    if (prop.type === 'group') return prop.properties?.[segs[2]] || null;
    return null;
  }
  return null;
}
