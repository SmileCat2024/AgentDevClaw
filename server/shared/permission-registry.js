/**
 * OS 权限项目录。
 *
 * 该目录是权限项 ID 与值类型的唯一权威；用户配置可以携带的权限项必须在此登记。
 * 目前登记：runtime 并发上限（ADR-0027）、通知权限项族（ADR-0030）、coder
 * 上下文接续策略（contextRotationStrategy）。
 */

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isBoolean(value) {
  return typeof value === 'boolean';
}

/** 枚举值校验器工厂：限定在工作空间声明的取值集合内。 */
function isEnumValue(allowedValues) {
  const allowed = new Set(allowedValues);
  return (value) => typeof value === 'string' && allowed.has(value);
}

/** coder 自动接续（上下文过界线程接力）的策略面取值。 */
export const CONTEXT_ROTATION_STRATEGY_VALUES = Object.freeze(['adaptive', 'trim', 'summary']);

export const PERMISSION_ITEMS = Object.freeze({
  maxLiveRuntimes: Object.freeze({
    id: 'maxLiveRuntimes',
    valueType: 'positive-integer',
    validate: isPositiveInteger,
  }),
  contextRotationStrategy: Object.freeze({
    id: 'contextRotationStrategy',
    valueType: 'enum',
    values: CONTEXT_ROTATION_STRATEGY_VALUES,
    validate: isEnumValue(CONTEXT_ROTATION_STRATEGY_VALUES),
  }),
  'notifications.finish': Object.freeze({
    id: 'notifications.finish',
    valueType: 'boolean',
    validate: isBoolean,
  }),
  'notifications.reminder': Object.freeze({
    id: 'notifications.reminder',
    valueType: 'boolean',
    validate: isBoolean,
  }),
  'notifications.input': Object.freeze({
    id: 'notifications.input',
    valueType: 'boolean',
    validate: isBoolean,
  }),
});

const PERMISSION_ITEM_IDS = new Set(Object.keys(PERMISSION_ITEMS));

/** 校验工作空间声明的权限项 ID 列表，并规范化顺序与重复项。 */
export function normalizePermissionDeclarations(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('metadata.permissions 必须是数组。');

  const declarations = [];
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== 'string' || !PERMISSION_ITEM_IDS.has(id)) {
      throw new Error(`metadata.permissions 包含未知权限项：${String(id)}`);
    }
    if (seen.has(id)) throw new Error(`metadata.permissions 重复声明权限项：${id}`);
    seen.add(id);
    declarations.push(id);
  }
  return declarations;
}

/** 校验权限项 ID 与对应值；未知 ID 或类型错误均返回 false。 */
export function isValidPermissionValue(permissionId, value) {
  const item = PERMISSION_ITEMS[permissionId];
  return Boolean(item && item.validate(value));
}

/**
 * 校验 metadata.permissionDefaults（作者默认值，ADR-0030）：对象，键必须是
 * 该 metadata permissions 已声明的权限项 ID，值须通过该项 validate。未知项、
 * 未声明的键或值非法均抛错（与 permissions 声明同等级校验，启动扫描报错）。
 * undefined → 空对象。
 */
export function normalizePermissionDefaults(value, declaredIds) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('metadata.permissionDefaults 必须是对象。');
  }
  const declared = new Set(Array.isArray(declaredIds) ? declaredIds : []);
  const defaults = {};
  for (const [permissionId, defaultValue] of Object.entries(value)) {
    if (!declared.has(permissionId)) {
      throw new Error(`metadata.permissionDefaults 包含未声明的权限项：${permissionId}`);
    }
    if (!isValidPermissionValue(permissionId, defaultValue)) {
      throw new Error(`metadata.permissionDefaults 的 ${permissionId} 值非法。`);
    }
    defaults[permissionId] = defaultValue;
  }
  return defaults;
}

/** 将任意对象投影为已登记且值合法的权限项。 */
export function projectPermissionValues(values) {
  const projected = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return projected;

  for (const [permissionId, value] of Object.entries(values)) {
    if (isValidPermissionValue(permissionId, value)) projected[permissionId] = value;
  }
  return projected;
}
