/**
 * OS 权限项目录。
 *
 * 该目录是权限项 ID 与值类型的唯一权威；用户配置可以携带的权限项必须在此登记。
 * 目前登记：线程并发上限（ADR-0027 修订一，maxLiveThreads）、通知权限项族
 * （ADR-0030；值域为三态呈现模式 NOTIFICATION_MODE_VALUES；完成通知含焦点
 * 子场景项 FINISH_FOCUS_PERMISSION_IDS，修订见 ADR-0030 修订记录）、coder
 * 上下文接续策略（contextRotationStrategy）。
 */

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * 通知呈现模式（ADR-0030 修订：布尔 → 三态枚举）。
 * off = 不通知；auto = 弹出后自动收进系统通知中心；persistent = 常驻屏幕
 * 直到用户处理（requireInteraction / 壳内 Reminder toast）。
 */
export const NOTIFICATION_MODE_VALUES = Object.freeze(['off', 'auto', 'persistent']);

/**
 * 完成通知的焦点子场景键（信息层级目标：编程小助手完成通知按焦点状态
 * 细分三档，各自独立配置）。子场景与前端呈现器选键一一对应：
 * focused = 页面聚焦且正选中该会话；elsewhere = 页面聚焦但在看其他
 * 对话/页面；background = 页面失焦（最小化 / 后台标签 / 被遮挡）。
 */
export const FINISH_FOCUS_MODE_KEYS = Object.freeze(['focused', 'elsewhere', 'background']);

/** 完成通知焦点子场景的权限项 ID（与 FINISH_FOCUS_MODE_KEYS 同序）。 */
export const FINISH_FOCUS_PERMISSION_IDS = Object.freeze([
  'notifications.finish.focused',
  'notifications.finish.elsewhere',
  'notifications.finish.background',
]);

const NOTIFICATION_PERMISSION_IDS = new Set([
  'notifications.finish',
  ...FINISH_FOCUS_PERMISSION_IDS,
  'notifications.reminder',
  'notifications.input',
]);

/** 枚举值校验器工厂：限定在工作空间声明的取值集合内。 */
function isEnumValue(allowedValues) {
  const allowed = new Set(allowedValues);
  return (value) => typeof value === 'string' && allowed.has(value);
}

/** 通知呈现模式校验器（三个通知项共用同一值域）。 */
const isNotificationMode = isEnumValue(NOTIFICATION_MODE_VALUES);

/** coder 自动接续（上下文过界线程接力）的策略面取值。 */
export const CONTEXT_ROTATION_STRATEGY_VALUES = Object.freeze(['adaptive', 'trim', 'summary']);

/** Coder runtime execution mode selected by the user. */
export const CODER_RUNTIME_MODE_VALUES = Object.freeze(['standard', 'container', 'agent-choice']);

export const PERMISSION_ITEMS = Object.freeze({
  maxLiveThreads: Object.freeze({
    id: 'maxLiveThreads',
    valueType: 'positive-integer',
    validate: isPositiveInteger,
  }),
  contextRotationStrategy: Object.freeze({
    id: 'contextRotationStrategy',
    valueType: 'enum',
    values: CONTEXT_ROTATION_STRATEGY_VALUES,
    validate: isEnumValue(CONTEXT_ROTATION_STRATEGY_VALUES),
  }),
  runtimeExecutionMode: Object.freeze({
    id: 'runtimeExecutionMode',
    valueType: 'enum',
    values: CODER_RUNTIME_MODE_VALUES,
    validate: isEnumValue(CODER_RUNTIME_MODE_VALUES),
  }),
  'notifications.finish': Object.freeze({
    id: 'notifications.finish',
    valueType: 'enum',
    values: NOTIFICATION_MODE_VALUES,
    validate: isNotificationMode,
  }),
  ...Object.fromEntries(FINISH_FOCUS_PERMISSION_IDS.map((id) => [id, Object.freeze({
    id,
    valueType: 'enum',
    values: NOTIFICATION_MODE_VALUES,
    validate: isNotificationMode,
  })])),
  'notifications.reminder': Object.freeze({
    id: 'notifications.reminder',
    valueType: 'enum',
    values: NOTIFICATION_MODE_VALUES,
    validate: isNotificationMode,
  }),
  'notifications.input': Object.freeze({
    id: 'notifications.input',
    valueType: 'enum',
    values: NOTIFICATION_MODE_VALUES,
    validate: isNotificationMode,
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
 * 历史布尔值 → 通知模式归一（true→auto、false→off）。布尔值域退役前的
 * 存量 workspace-settings 用户覆盖与旧调用方仍可能携带布尔；读路径投影
 * （projectPermissionValues）与判定链（app-notification）先经它归一。
 * 写路径不走它——writeWorkspacePermissionValue 按 registry validate 严格
 * 拒布尔，前端统一写模式串。非法输入返回 null（视为未配置）。
 */
export function normalizeNotificationModeValue(value) {
  if (value === true) return 'auto';
  if (value === false) return 'off';
  return NOTIFICATION_MODE_VALUES.includes(value) ? value : null;
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

/**
 * 将任意对象投影为已登记且值合法的权限项。通知项族的历史布尔值先经
 * normalizeNotificationModeValue 归一（true→auto、false→off）：直接丢弃
 * 会让存量用户覆盖静默失效、回退作者默认，改变用户既定行为。
 */
export function projectPermissionValues(values) {
  const projected = {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return projected;

  for (const [permissionId, value] of Object.entries(values)) {
    let candidate = value;
    if (NOTIFICATION_PERMISSION_IDS.has(permissionId)) {
      candidate = normalizeNotificationModeValue(candidate);
    }
    if (isValidPermissionValue(permissionId, candidate)) projected[permissionId] = candidate;
  }
  return projected;
}
