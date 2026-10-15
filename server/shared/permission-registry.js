/**
 * OS 权限项目录。
 *
 * 该目录是权限项 ID 与值类型的唯一权威；用户配置可以携带的权限项必须在此登记。
 * 目前只登记已落地的 runtime 并发上限，不包含申请、授权或展示流程。
 */

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export const PERMISSION_ITEMS = Object.freeze({
  maxLiveRuntimes: Object.freeze({
    id: 'maxLiveRuntimes',
    valueType: 'positive-integer',
    validate: isPositiveInteger,
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

/** 将任意对象投影为已登记且值合法的权限项。 */
export function projectPermissionValues(values) {
  const projected = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return projected;

  for (const [permissionId, value] of Object.entries(values)) {
    if (isValidPermissionValue(permissionId, value)) projected[permissionId] = value;
  }
  return projected;
}
