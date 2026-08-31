/**
 * Generative UI Spec Validator
 *
 * 纯函数，无副作用。检查 Spec 的结构完整性、图合法性、
 * 组件 props 合规性、action 引用有效性和所有限制。
 *
 * 被 surface-feature.ts（工具侧）和 server/routes/ui-surfaces.js
 * （服务端二次校验）共同调用。
 */

import type { GenerativeUISpecV1, ValidationResult } from './types.js';
import { UI_LIMITS } from './types.js';
import { CATALOG, isKnownComponent, acceptsChildren, type PropSchema } from './catalog.js';

// ═══════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════

export function validateGenerativeUISpec(spec: unknown): ValidationResult {
  const errors: string[] = [];

  // ── 0. 类型检查 ──
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: ['Spec must be a JSON object.'] };
  }

  const s = spec as Record<string, unknown>;
  const specBytes = Buffer.byteLength(JSON.stringify(s), 'utf8');

  // ── 1. 顶层字段 ──
  if (s.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1, got ${JSON.stringify(s.schemaVersion)}.`);
  }
  if (s.catalogVersion !== 'v1') {
    errors.push(`catalogVersion must be "v1", got ${JSON.stringify(s.catalogVersion)}.`);
  }
  if (typeof s.title !== 'string' || s.title.trim().length === 0) {
    errors.push('title must be a non-empty string.');
  } else if (s.title.length > 200) {
    errors.push(`title is too long (${s.title.length} chars, max 200).`);
  }
  if (s.description !== undefined && typeof s.description !== 'string') {
    errors.push('description must be a string if present.');
  }
  if (typeof s.root !== 'string' || s.root.length === 0) {
    errors.push('root must be a non-empty string referencing an element ID.');
  }

  // ── 2. elements 存在且是对象 ──
  if (!s.elements || typeof s.elements !== 'object' || Array.isArray(s.elements)) {
    errors.push('elements must be a JSON object mapping element IDs to element definitions.');
    return { valid: errors.length === 0, errors };
  }

  const elements = s.elements as Record<string, unknown>;

  // ── 3. 大小限制 ──
  const elementCount = Object.keys(elements).length;
  if (elementCount === 0) {
    errors.push('elements must contain at least one element.');
  }
  if (elementCount > UI_LIMITS.maxElementsPerSurface) {
    errors.push(`Too many elements: ${elementCount} (max ${UI_LIMITS.maxElementsPerSurface}).`);
  }
  if (specBytes > UI_LIMITS.maxSpecBytes) {
    errors.push(`Spec too large: ${specBytes} bytes (max ${UI_LIMITS.maxSpecBytes}).`);
  }

  // ── 4. root 引用存在 ──
  if (typeof s.root === 'string' && s.root.length > 0 && !(s.root in elements)) {
    errors.push(`root "${s.root}" does not exist in elements.`);
  }

  // ── 5. 校验每个元素 ──
  const fieldNames = new Map<string, string>(); // name → elementId
  const buttonActions = new Set<string>();      // Button 引用的 actionId

  for (const [id, raw] of Object.entries(elements)) {
    // ID 格式
    if (!UI_LIMITS.idPattern.test(id)) {
      errors.push(`Element ID "${id}" is invalid (must match ${UI_LIMITS.idPattern}).`);
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`Element "${id}" must be an object.`);
      continue;
    }

    const el = raw as Record<string, unknown>;

    // type
    if (typeof el.type !== 'string') {
      errors.push(`Element "${id}" is missing "type".`);
      continue;
    }

    if (!isKnownComponent(el.type)) {
      errors.push(`Element "${id}" has unknown type "${el.type}".`);
      continue;
    }

    // children — 只有容器组件才要求有 children 数组
    if (acceptsChildren(el.type)) {
      if (!Array.isArray(el.children)) {
        errors.push(`Element "${id}" (${el.type}) children must be an array.`);
      }
    } else {
      // 叶子组件不能有非空 children
      if (Array.isArray(el.children) && el.children.length > 0) {
        errors.push(`Element "${id}" (type "${el.type}") cannot have children.`);
      }
    }

    // props 必须是对象
    if (el.props !== undefined && (typeof el.props !== 'object' || Array.isArray(el.props))) {
      errors.push(`Element "${id}" props must be an object.`);
    }

    // 校验 props 值
    const props = (el.props || {}) as Record<string, unknown>;
    const propsResult = validateElementProps(id, el.type, props);
    errors.push(...propsResult);
    errors.push(...validateComponentConstraints(id, el.type, props));

    // 收集 input 组件的 name 字段
    const schema = CATALOG[el.type];
    if (schema?.category === 'input' && el.props && typeof el.props === 'object') {
      const name = (el.props as Record<string, unknown>).name;
      if (typeof name === 'string' && name.length > 0) {
        if (fieldNames.has(name)) {
          errors.push(`Duplicate field name "${name}" in elements "${fieldNames.get(name)}" and "${id}".`);
        } else {
          fieldNames.set(name, id);
        }
      }
    }

    // 收集 Button 的 actionId
    if (el.type === 'Button' && el.props && typeof el.props === 'object') {
      const actionId = (el.props as Record<string, unknown>).actionId;
      if (typeof actionId === 'string' && actionId.length > 0) {
        buttonActions.add(actionId);
      }
    }
  }

  // ── 6. 图结构校验：引用完整 + 无环 + 单父 + 无孤立 ──
  const rootKey = typeof s.root === 'string' ? s.root : '';
  const graphErrors = validateElementGraph(rootKey, elements);
  errors.push(...graphErrors);

  // ── 7. action 校验 ──
  const actions = s.actions as Record<string, unknown> | undefined;
  const allFieldNames = new Set(fieldNames.keys());

  // Button 引用的 action 必须在 actions 中定义
  for (const actionId of buttonActions) {
    if (!actions || !(actionId in actions)) {
      errors.push(`Button references action "${actionId}" but it is not defined in spec.actions.`);
    }
  }

  if (actions && typeof actions === 'object') {
    for (const [actionId, rawAction] of Object.entries(actions)) {
      if (!UI_LIMITS.idPattern.test(actionId)) {
        errors.push(`Action ID "${actionId}" is invalid.`);
      }

      if (!rawAction || typeof rawAction !== 'object') {
        errors.push(`Action "${actionId}" must be an object.`);
        continue;
      }

      const action = rawAction as Record<string, unknown>;

      // intent
      if (action.intent !== 'submit' && action.intent !== 'reset') {
        errors.push(`Action "${actionId}" intent must be "submit" or "reset".`);
      }

      // label
      if (typeof action.label !== 'string' || action.label.trim().length === 0) {
        errors.push(`Action "${actionId}" must have a non-empty "label".`);
      }

      // includeFields 引用的字段必须存在
      if (Array.isArray(action.includeFields)) {
        for (const fname of action.includeFields) {
          if (typeof fname !== 'string' || !allFieldNames.has(fname)) {
            errors.push(`Action "${actionId}" includeFields references unknown field "${fname}".`);
          }
        }
      }

      // confirm 结构
      if (action.confirm !== undefined) {
        if (typeof action.confirm !== 'object' || Array.isArray(action.confirm)) {
          errors.push(`Action "${actionId}" confirm must be an object.`);
        } else {
          const confirm = action.confirm as Record<string, unknown>;
          if (typeof confirm.title !== 'string' || confirm.title.trim().length === 0) {
            errors.push(`Action "${actionId}" confirm.title must be a non-empty string.`);
          } else if (confirm.title.length > 200) {
            errors.push(`Action "${actionId}" confirm.title is too long (max 200).`);
          }
          if (confirm.description !== undefined && (typeof confirm.description !== 'string' || confirm.description.length > 1000)) {
            errors.push(`Action "${actionId}" confirm.description must be a string up to 1000 characters.`);
          }
          if (confirm.confirmLabel !== undefined && (typeof confirm.confirmLabel !== 'string' || confirm.confirmLabel.trim().length === 0 || confirm.confirmLabel.length > 100)) {
            errors.push(`Action "${actionId}" confirm.confirmLabel must be a non-empty string up to 100 characters.`);
          }
        }
      }
    }
  }

  // ── 8. initialValues 中的 key 应对应字段名 ──
  if (s.initialValues && typeof s.initialValues === 'object' && !Array.isArray(s.initialValues)) {
    for (const key of Object.keys(s.initialValues as Record<string, unknown>)) {
      if (!allFieldNames.has(key)) {
        errors.push(`initialValues key "${key}" does not match any input field name.`);
      }
    }
  }

  // 计算最大深度
  const maxDepth = rootKey && rootKey in elements ? computeMaxDepth(rootKey, elements, new Set()) : 0;
  if (maxDepth > UI_LIMITS.maxTreeDepth) {
    errors.push(`Tree depth ${maxDepth} exceeds max ${UI_LIMITS.maxTreeDepth}.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    stats: { elementCount, maxDepth, specBytes },
  };
}

// ═══════════════════════════════════════════════════════════════
// 图结构校验
// ═══════════════════════════════════════════════════════════════

function validateElementGraph(root: string, elements: Record<string, unknown>): string[] {
  const errors: string[] = [];

  // children 引用完整性
  for (const [id, raw] of Object.entries(elements)) {
    const el = raw as Record<string, unknown>;
    const children = el?.children;
    if (!Array.isArray(children)) continue;

    for (const child of children) {
      if (typeof child !== 'string') {
        errors.push(`Element "${id}" has a non-string child reference.`);
        continue;
      }
      if (!(child in elements)) {
        errors.push(`Element "${id}" references unknown child "${child}".`);
      }
    }
  }

  // 单父节点：一个元素不能被多个父节点引用
  const childParents = new Map<string, string[]>();
  for (const [id, raw] of Object.entries(elements)) {
    const el = raw as Record<string, unknown>;
    const children = el?.children;
    if (!Array.isArray(children)) continue;
    for (const child of children) {
      if (typeof child !== 'string') continue;
      if (!childParents.has(child)) childParents.set(child, []);
      childParents.get(child)!.push(id);
    }
  }
  for (const [child, parents] of childParents) {
    if (parents.length > 1) {
      errors.push(`Element "${child}" has multiple parents: ${parents.join(', ')}.`);
    }
  }

  // 无环检测（从 root DFS）
  if (root && root in elements) {
    const visited = new Set<string>();
    const stack = new Set<string>();
    const cycleFound = detectCycle(root, elements, visited, stack);
    if (cycleFound) {
      errors.push('Cycle detected in element tree.');
    }
  }

  // 孤立节点：不在 root 子树中的元素
  if (root && root in elements) {
    const reachable = new Set<string>([root]);
    collectReachable(root, elements, reachable, new Set());
    for (const id of Object.keys(elements)) {
      if (!reachable.has(id)) {
        errors.push(`Element "${id}" is unreachable from root "${root}".`);
      }
    }
  }

  return errors;
}

function detectCycle(
  id: string,
  elements: Record<string, unknown>,
  visited: Set<string>,
  stack: Set<string>,
): boolean {
  visited.add(id);
  stack.add(id);

  const el = elements[id] as Record<string, unknown> | undefined;
  const children = el?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (typeof child !== 'string') continue;
      if (!visited.has(child)) {
        if (detectCycle(child, elements, visited, stack)) return true;
      } else if (stack.has(child)) {
        return true;
      }
    }
  }

  stack.delete(id);
  return false;
}

function collectReachable(
  id: string,
  elements: Record<string, unknown>,
  reachable: Set<string>,
  visited: Set<string>,
): void {
  if (visited.has(id)) return;
  visited.add(id);

  const el = elements[id] as Record<string, unknown> | undefined;
  const children = el?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      if (typeof child === 'string') {
        reachable.add(child);
        collectReachable(child, elements, reachable, visited);
      }
    }
  }
}

function computeMaxDepth(id: string, elements: Record<string, unknown>, visited: Set<string>): number {
  if (visited.has(id)) return 0; // cycle guard
  visited.add(id);

  const el = elements[id] as Record<string, unknown> | undefined;
  const children = el?.children;
  if (!Array.isArray(children) || children.length === 0) return 1;

  let maxChild = 0;
  for (const child of children) {
    if (typeof child === 'string' && child in elements) {
      maxChild = Math.max(maxChild, computeMaxDepth(child, elements, visited));
    }
  }
  return maxChild + 1;
}

// ═══════════════════════════════════════════════════════════════
// Props 校验
// ═══════════════════════════════════════════════════════════════

function validateElementProps(
  elementId: string,
  type: string,
  props: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  const schema = CATALOG[type];
  if (!schema) return errors;

  // 检查 required props
  for (const [propName, propSchema] of Object.entries(schema.props)) {
    const value = props[propName];

    if (propSchema.required && (value === undefined || value === null)) {
      errors.push(`Element "${elementId}" (${type}) is missing required prop "${propName}".`);
      continue;
    }

    if (value === undefined || value === null) continue;

    errors.push(...validatePropValue(elementId, type, propName, propSchema, value));
  }

  // 检查未知 props（V1 fail closed：不允许 Catalog 未声明的 props）
  for (const propName of Object.keys(props)) {
    if (!(propName in schema.props)) {
      errors.push(`Element "${elementId}" (${type}) has unknown prop "${propName}".`);
    }
  }

  return errors;
}

/** Validate relationships that cannot be expressed by individual prop schemas. */
function validateComponentConstraints(
  elementId: string,
  type: string,
  props: Record<string, unknown>,
): string[] {
  const errors: string[] = [];

  if (type === 'Slider') {
    const min = props.min;
    const max = props.max;
    const step = props.step;
    if (typeof min === 'number' && typeof max === 'number' && min >= max) {
      errors.push(`Element "${elementId}" (Slider) requires min to be less than max.`);
    }
    if (step !== undefined && (typeof step !== 'number' || !isFinite(step) || step <= 0)) {
      errors.push(`Element "${elementId}" (Slider) step must be a positive finite number.`);
    }
  }

  if (type === 'DateInput') {
    for (const propName of ['min', 'max']) {
      const value = props[propName];
      if (value !== undefined && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
        errors.push(`Element "${elementId}" (DateInput) ${propName} must use YYYY-MM-DD.`);
      }
    }
    if (typeof props.min === 'string' && typeof props.max === 'string' && props.min > props.max) {
      errors.push(`Element "${elementId}" (DateInput) requires min to be no later than max.`);
    }
  }

  if (type === 'Chart') {
    errors.push(...validateChartSeries(elementId, props));
    if (typeof props.yMin === 'number' && typeof props.yMax === 'number' && props.yMin >= props.yMax) {
      errors.push(`Element "${elementId}" (Chart) requires yMin to be less than yMax.`);
    }
  }

  if (type === 'Sparkline') {
    errors.push(...validateNumberArray(elementId, 'Sparkline', 'values', props.values, 2, 100));
  }

  return errors;
}

/** Chart 系列 / 标签 / 值数组之间的数量与类型关系。 */
function validateChartSeries(elementId: string, props: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const series = props.series;
  const labels = props.labels;

  if (!Array.isArray(series) || series.length === 0) {
    errors.push(`Element "${elementId}" (Chart) series must be a non-empty array.`);
  } else if (series.length > 5) {
    errors.push(`Element "${elementId}" (Chart) has too many series (${series.length}, max 5).`);
  }
  if (!Array.isArray(labels) || labels.length === 0) {
    errors.push(`Element "${elementId}" (Chart) labels must be a non-empty array.`);
  } else if (labels.length > 60) {
    errors.push(`Element "${elementId}" (Chart) has too many labels (${labels.length}, max 60).`);
  }

  if (Array.isArray(series)) {
    for (let i = 0; i < series.length; i++) {
      const s = series[i] as Record<string, unknown> | null | undefined;
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
      errors.push(...validateNumberArray(elementId, 'Chart', `series[${i}].values`, s.values, 1, 60, Array.isArray(labels) ? labels.length : undefined));
      const tone = s.tone;
      if (tone !== undefined && (typeof tone !== 'string' || !['default', 'success', 'warning', 'danger', 'info'].includes(tone))) {
        errors.push(`Element "${elementId}" (Chart) series[${i}].tone has invalid value "${String(tone)}" (allowed: default, success, warning, danger, info).`);
      }
    }
  }

  return errors;
}

/** 校验数字数组：元素必须是有限数字，长度在 [min, max] 内，可选与期望长度一致。 */
function validateNumberArray(
  elementId: string,
  type: string,
  label: string,
  value: unknown,
  minLength: number,
  maxLength: number,
  expectedLength?: number,
): string[] {
  const errors: string[] = [];
  const path = `Element "${elementId}" (${type}) ${label}`;
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of numbers.`);
    return errors;
  }
  if (value.length < minLength) {
    errors.push(`${path} needs at least ${minLength} numbers, got ${value.length}.`);
  }
  if (value.length > maxLength) {
    errors.push(`${path} has too many numbers (${value.length}, max ${maxLength}).`);
  }
  if (expectedLength !== undefined && value.length !== expectedLength) {
    errors.push(`${path} length (${value.length}) must match labels length (${expectedLength}).`);
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'number' || !isFinite(value[i] as number)) {
      errors.push(`${path}[${i}] must be a finite number.`);
    }
  }
  return errors;
}

function validatePropValue(
  elementId: string,
  type: string,
  propName: string,
  schema: PropSchema,
  value: unknown,
): string[] {
  const errors: string[] = [];
  const label = `"${elementId}".${propName}`;

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${label} must be a string.`);
        break;
      }
      if (schema.maxLength && value.length > schema.maxLength) {
        errors.push(`${label} is too long (${value.length}, max ${schema.maxLength}).`);
      }
      if (schema.minLength && value.length < schema.minLength) {
        errors.push(`${label} is too short (${value.length}, min ${schema.minLength}).`);
      }
      break;
    }

    case 'number': {
      if (typeof value !== 'number' || !isFinite(value)) {
        errors.push(`${label} must be a finite number.`);
        break;
      }
      if (schema.min !== undefined && value < schema.min) {
        errors.push(`${label} is below minimum (${value} < ${schema.min}).`);
      }
      if (schema.max !== undefined && value > schema.max) {
        errors.push(`${label} exceeds maximum (${value} > ${schema.max}).`);
      }
      break;
    }

    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push(`${label} must be a boolean.`);
      }
      break;
    }

    case 'enum': {
      if (typeof value !== 'string') {
        errors.push(`${label} must be a string.`);
        break;
      }
      if (schema.enumValues && !schema.enumValues.includes(value)) {
        errors.push(`${label} has invalid value "${value}" (allowed: ${schema.enumValues.join(', ')}).`);
      }
      break;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${label} must be an array.`);
        break;
      }

      // Table rows/columns 上限
      if (propName === 'columns' && value.length > UI_LIMITS.maxTableColumns) {
        errors.push(`${label} has too many entries (${value.length}, max ${UI_LIMITS.maxTableColumns}).`);
      }
      if (propName === 'rows' && value.length > UI_LIMITS.maxTableRows) {
        errors.push(`${label} has too many entries (${value.length}, max ${UI_LIMITS.maxTableRows}).`);
      }
      if ((propName === 'options') && value.length > UI_LIMITS.maxSelectOptions) {
        errors.push(`${label} has too many options (${value.length}, max ${UI_LIMITS.maxSelectOptions}).`);
      }

      // itemSchema 校验（仅对有 itemSchema 的 array）
      if (schema.itemSchema) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            errors.push(`${label}[${i}] must be an object.`);
            continue;
          }
          const itemObj = item as Record<string, unknown>;
          for (const [itemKey, itemPropSchema] of Object.entries(schema.itemSchema)) {
            if (itemPropSchema.required && (itemObj[itemKey] === undefined || itemObj[itemKey] === null)) {
              errors.push(`${label}[${i}] is missing required field "${itemKey}".`);
            }
            if (typeof itemObj[itemKey] === 'string' && itemPropSchema.maxLength) {
              if ((itemObj[itemKey] as string).length > itemPropSchema.maxLength) {
                errors.push(`${label}[${i}].${itemKey} is too long.`);
              }
            }
            if (itemPropSchema.type === 'string' && typeof itemObj[itemKey] !== 'string' && itemPropSchema.required) {
              errors.push(`${label}[${i}].${itemKey} must be a string.`);
            }
          }
        }
      }
      break;
    }

    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${label} must be an object.`);
      }
      break;
    }
  }

  return errors;
}
