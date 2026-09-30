/**
 * 累加型多值字段的跨层叠加（层组装语义）
 *
 * 配置队列的 merge 规范（框架 resolveFeatureConfig 规范 3）规定数组整体替换，
 * 这对有序列表（如 lsp.runtimes）是正确语义；但对累加型多值字段——多个层各
 * 自声明若干条目、期望下层在上游基础上追加（如 skill.extraDirs 的多个技能
 * 目录）——整体替换会让目录层的一条配置把工作空间级配置整个顶掉。
 *
 * 叠加语义（产品决策：多选字段天然累加，不做任何下层覆盖机制）：
 * - 跨层按序 concat，上游在前、下层追加，精确去重（首个出现位置保留）
 * - 非数组贡献（null / 标量等）不贡献条目；null 不再承担"清空上游"语义
 * - 单层提及不触发折叠（无跨层交互）；并集写回最后一个提及层，交由
 *   resolveFeatureConfig 的既有"数组整体替换"得出最终 merged——merge 规范
 *   本身不变，叠加只发生在层组装阶段（层语义归 Claw，框架不认识层）。
 *
 * agent 侧（agent.js / coder-agent.js 构造期）与 server 侧（resolved API）
 * 共用本折叠，保证运行时行为与 UI 预览一致。
 */

/** 累加型字段点路径清单（featureName.field 形式，可扩展）。 */
export const ACCUMULATED_FIELD_PATHS = ['skill.extraDirs'];

const MISSING = Symbol('missing');

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && ! Array.isArray(value);
}

function getPathValue(root, segments) {
  let cursor = root;
  for (const segment of segments) {
    if (!isPlainObject(cursor) || !(segment in cursor)) return MISSING;
    cursor = cursor[segment];
  }
  return cursor;
}

/** 沿路径写值，copy-on-write：返回新层对象，输入层不被污染。 */
function setPathValue(root, segments, value) {
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    return { ...root, [head]: value };
  }
  return { ...root, [head]: setPathValue(root[head] ?? {}, rest, value) };
}

function sameEntries(a, b) {
  return Array.isArray(a) && a.length === b.length && a.every((entry, i) => entry === b[i]);
}

/**
 * 把队列中累加型字段折叠为单一并集数组，写回最后一个提及该字段的层。
 * 无需折叠时原样返回输入队列（同引用）。
 *
 * @param {object[]} queue 有序配置层（稀疏对象，后层优先）
 * @returns {object[]} 折叠后的队列
 */
export function collapseAccumulatedFields(queue) {
  const layers = Array.isArray(queue) ? queue : [];
  let result = layers;
  for (const fieldPath of ACCUMULATED_FIELD_PATHS) {
    const segments = fieldPath.split('.');
    const mentionIndices = [];
    const contributions = [];
    for (const [index, layer] of layers.entries()) {
      const value = getPathValue(layer, segments);
      if (value === MISSING) continue;
      mentionIndices.push(index);
      if (Array.isArray(value)) contributions.push(...value);
    }
    // 单层提及没有跨层交互；并集为空说明全部提及都不是数组，均无需折叠
    if (mentionIndices.length < 2 || contributions.length === 0) continue;

    // Set 按插入序去重：上游在前、首现位置保留
    const union = [...new Set(contributions)];
    const lastIndex = mentionIndices[mentionIndices.length - 1];
    if (sameEntries(getPathValue(layers[lastIndex], segments), union)) continue;

    if (result === layers) result = layers.slice();
    result[lastIndex] = setPathValue(layers[lastIndex], segments, union);
  }
  return result;
}
