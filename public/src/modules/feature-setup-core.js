/**
 * feature-setup-core.js — Feature 配置两态编辑器纯逻辑
 *
 * 字段级模型（跟随 / 接管）：
 *   - 跟随（follow）= 本层 sparse 无该字段 → 控件灰显生效值（上游最近层值，
 *     无则 manifest default），不写库；
 *   - 接管（takeover）= 本层 sparse 有该字段（或本次会话已编辑待保存）→
 *     值完全跟本层走，即使与上游相同也照写（存在即接管）；
 *   - 重置为跟随 = 删除本层该字段条目（null 语义，仅存在于 dirty 会话内）。
 *
 * 配置队列：出厂默认 → 全局层 → agent 层 → 目录层；编辑器只编辑调用方
 * 绑定的那一层（scopeId = 'global' | 'agent' | 'dir:<path>'），
 * 上游生效值与 merged 全部来自 resolved API，前端不自算合并。
 *
 * 从 feature-setup-ui.js 提取的无 DOM / 无全局状态依赖部分：
 *   - 点路径原语（fsGetPathValue / fsHasField / fsSetPath / fsDeletePath）
 *   - 两态分类（fsUpstreamInfo / fsClassifyField / fsFieldStates）
 *   - dirty 叠加（fsApplyDirty）：value === null 表示"重置为跟随"
 *   - 控件取值（fsControlValue）
 *   - 保存 payload 构造（fsBuildLayerContent，diff only）：
 *     以原始 sparse 为底仅套用本次会话碰过的字段，未碰字段绝不写入
 *   - manifest 属性查找（fsPropFor）与目录名（fsBaseName）
 *
 * UI 模块持有状态并调用这些函数；测试见 test/feature-setup-core.test.js
 * （frontend-vm 沙箱）。
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

// ── 两态分类（判定数据全部来自 resolved layers，前端不自算合并）──

/** 上游信息：早于本层、最后包含该字段的层；都没有则出厂默认（虚拟第 0 层）。 */
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

/**
 * 基于层稀疏内容的两态分类（不含本次会话的 dirty 修正）：
 * 接管 = 本层 sparse 存在该字段（存在即接管）；跟随 = 本层无（生效值经
 * fsControlValue 由 upstream / manifest default 决定）。
 * 接管态也携带 upstream（"重置为跟随"后据此显示生效值）。
 */
function fsClassifyField(fullKey, layerIndex, layers) {
  const local = layers[layerIndex];
  if (!local) {
    return { status: 'follow', upstream: { kind: 'default', value: undefined, label: null, layerId: null } };
  }
  const segs = fullKey.split('.');
  const upstream = fsUpstreamInfo(fullKey, layerIndex, layers);
  if (fsHasField(local.sparse, segs)) {
    return { status: 'takeover', layerValue: fsGetPathValue(local.sparse, segs), upstream };
  }
  return { status: 'follow', upstream };
}

/** 全部 manifest 字段的两态表（不含 dirty）。sections 为 UI 侧 _buildSections 产物。 */
function fsFieldStates(sections, layers, scopeId) {
  const idx = layers.findIndex((l) => l.id === scopeId);
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

/** 叠加本次会话 dirty 后的渲染用两态表（就地修改 base Map）。 */
function fsApplyDirty(baseStates, dirty) {
  for (const [fullKey, entry] of dirty) {
    const cur = baseStates.get(fullKey);
    if (!cur) continue;
    if (entry.value === null) {
      // 本会话已重置 → 回到跟随（保留 upstream 供生效值显示）
      const upstream = cur.upstream
        || { kind: 'default', value: undefined, label: null, layerId: null };
      baseStates.set(fullKey, { status: 'follow', upstream });
    } else {
      baseStates.set(fullKey, { ...cur, status: 'takeover', pendingValue: entry.value });
    }
  }
  return baseStates;
}

/** 控件值：接管→本层（或待保存）值；跟随→上游最近层值，无则 manifest default。 */
function fsControlValue(state, prop) {
  if (state?.status === 'takeover') {
    return state.pendingValue !== undefined ? state.pendingValue : state.layerValue;
  }
  if (state?.upstream?.kind === 'layer') {
    return state.upstream.value;
  }
  return prop?.default;
}

// ── 保存 payload 构造（diff only）─────────────────────────────

/** 该层稀疏内容 = 原始 sparse 为底（深拷贝），仅套用本次会话碰过的字段。 */
function fsBuildLayerContent(layers, scopeId, dirty) {
  const idx = layers.findIndex((l) => l.id === scopeId);
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

// ── 杂项 ──────────────────────────────────────────────────────

function fsBaseName(dir) {
  const parts = String(dir || '').split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(dir || '');
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
