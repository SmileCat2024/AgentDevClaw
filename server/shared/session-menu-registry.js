/**
 * 会话菜单声明面（ADR-0049）的服务端校验与归一。
 *
 * prebuilt APP 的 metadata.json 声明 ui.sessionMenu.items（自定义右键菜单
 * 项）；agent-discovery 扫描时经 normalizeSessionMenu 校验并归一，随 agent
 * 记录（...metadata 展开）下发前端。消费端是 public/src/modules/
 * session-menu-decls.js。
 *
 * 校验语义与 permissions（permission-registry.js，非法抛错、启动扫描报错）
 * 不同：菜单项是增益 UX，坏声明丢弃并告警即可，不得阻塞整个 APP 的发现。
 *
 * 谓词词表与动作绑定前缀（claw: 宿主内建 / plugin: APP 插件模块）是公开
 * 契约，与前端 session-menu-decls.js 保持同步；按 ADR-0049 取舍，v1 只
 * 追加不与内建族交错，无排序字段。
 */

// 宿主求值的谓词词表（v1）：每个新谓词都是新的公开契约，按需增长。
export const SESSION_MENU_PREDICATES = Object.freeze(['not-archived', 'has-thread', 'thread-busy']);

const SESSION_MENU_ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const SESSION_MENU_ACTION_PATTERN = /^(?:claw:[a-z][a-z0-9-]*|plugin:[a-z0-9][a-z0-9-]*\.[a-zA-Z0-9-]+)$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeLabel(label, agentId, itemId) {
  if (!label || typeof label !== 'object' || Array.isArray(label)) {
    console.warn(`[session-menu] ${agentId}: 项 ${itemId} 缺少 label 对象，已丢弃。`);
    return null;
  }
  const normalized = {};
  if (isNonEmptyString(label.zh)) normalized.zh = label.zh;
  if (isNonEmptyString(label.en)) normalized.en = label.en;
  if (!normalized.zh && !normalized.en) {
    console.warn(`[session-menu] ${agentId}: 项 ${itemId} 的 label 缺少 zh/en 文案，已丢弃。`);
    return null;
  }
  return normalized;
}

/**
 * 归一 ui.sessionMenu：逐项校验（id 唯一且匹配 ^[a-z0-9][a-z0-9.-]*$、label
 * 至少一种语言、action 带合法前缀、when ∈ 词表、danger 为布尔），非法项
 * 丢弃并 console.warn；未知字段裁剪为规范形状。
 * 返回 { items }（无有效项时返回 null，记录上不保留空壳）。
 */
export function normalizeSessionMenu(value, agentId = '(unknown)') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    console.warn(`[session-menu] ${agentId}: ui.sessionMenu 必须是对象，已忽略。`);
    return null;
  }
  if (value.items === undefined || value.items === null) return null;
  if (!Array.isArray(value.items)) {
    console.warn(`[session-menu] ${agentId}: ui.sessionMenu.items 必须是数组，已忽略。`);
    return null;
  }

  const items = [];
  const seenIds = new Set();
  for (const entry of value.items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      console.warn(`[session-menu] ${agentId}: items 含非对象条目，已丢弃。`);
      continue;
    }
    const itemId = typeof entry.id === 'string' ? entry.id : '(no id)';
    if (!isNonEmptyString(entry.id) || !SESSION_MENU_ITEM_ID_PATTERN.test(entry.id)) {
      console.warn(`[session-menu] ${agentId}: 项 id "${itemId}" 非法（须 ^[a-z0-9][a-z0-9.-]*$），已丢弃。`);
      continue;
    }
    if (seenIds.has(entry.id)) {
      console.warn(`[session-menu] ${agentId}: 项 id "${entry.id}" 重复声明，已丢弃后值。`);
      continue;
    }
    if (!isNonEmptyString(entry.action) || !SESSION_MENU_ACTION_PATTERN.test(entry.action)) {
      console.warn(`[session-menu] ${agentId}: 项 ${entry.id} 的 action "${String(entry.action)}" 非法（须 claw:<name> 或 plugin:<pluginId>.<name>），已丢弃。`);
      continue;
    }
    const label = normalizeLabel(entry.label, agentId, entry.id);
    if (!label) continue;
    const when = [];
    if (entry.when !== undefined) {
      if (!Array.isArray(entry.when)) {
        console.warn(`[session-menu] ${agentId}: 项 ${entry.id} 的 when 必须是谓词数组，已丢弃。`);
        continue;
      }
      let invalidWhen = false;
      for (const predicate of entry.when) {
        if (!SESSION_MENU_PREDICATES.includes(predicate)) {
          console.warn(`[session-menu] ${agentId}: 项 ${entry.id} 引用未知谓词 "${String(predicate)}"（词表：${SESSION_MENU_PREDICATES.join(' / ')}），已丢弃。`);
          invalidWhen = true;
          break;
        }
        if (!when.includes(predicate)) when.push(predicate);
      }
      if (invalidWhen) continue;
    }
    if (entry.danger !== undefined && typeof entry.danger !== 'boolean') {
      console.warn(`[session-menu] ${agentId}: 项 ${entry.id} 的 danger 必须是布尔，已丢弃。`);
      continue;
    }
    seenIds.add(entry.id);
    const normalized = { id: entry.id, label, action: entry.action };
    if (when.length > 0) normalized.when = when;
    if (entry.danger === true) normalized.danger = true;
    items.push(normalized);
  }
  if (items.length === 0) return null;
  return { items };
}
