/**
 * Generative UI Catalog — 组件目录单一来源
 *
 * 所有组件的类型、属性 schema、分类和限制都只在这里定义。
 * 以下消费者都从本文件派生：
 * - Validator 检查 props 时查这里的 schema
 * - 工具 JSON Schema 由本文件生成
 * - 前端 Renderer 的组件名必须与这里的 key 一一对应
 * - Agent 可阅读的 Catalog 文本由本文件生成
 */

import { UI_LIMITS } from './types.js';

// ═══════════════════════════════════════════════════════════════
// 组件分类
// ═══════════════════════════════════════════════════════════════

export type ComponentCategory = 'layout' | 'display' | 'input' | 'action';

// ═══════════════════════════════════════════════════════════════
// JSON Schema 类型（简化版，足够运行时校验用）
// ═══════════════════════════════════════════════════════════════

export type PropType = 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object';

export interface PropSchema {
  type: PropType;
  /** enum 类型的可选值 */
  enumValues?: readonly string[];
  /** array/object 类型的子 schema（简化：只描述单层） */
  itemSchema?: Record<string, PropSchema>;
  required?: boolean;
  /** 数值约束 */
  min?: number;
  max?: number;
  /** 字符串长度约束 */
  minLength?: number;
  maxLength?: number;
  description?: string;
}

export interface ComponentSchema {
  type: string;
  category: ComponentCategory;
  /** 是否可以有 children */
  acceptsChildren: boolean;
  /** props 定义 */
  props: Record<string, PropSchema>;
  description: string;
}

// ═══════════════════════════════════════════════════════════════
// V1 组件定义
// ═══════════════════════════════════════════════════════════════

const GAP_VALUES = ['xs', 'sm', 'md', 'lg'] as const;
const ALIGN_VALUES = ['start', 'center', 'end', 'stretch'] as const;

export const CATALOG: Record<string, ComponentSchema> = {
  // ── 布局 ──

  Stack: {
    type: 'Stack',
    category: 'layout',
    acceptsChildren: true,
    description: 'Vertical layout container.',
    props: {
      gap: { type: 'enum', enumValues: GAP_VALUES, description: 'Spacing between children.' },
      align: { type: 'enum', enumValues: ALIGN_VALUES, description: 'Cross-axis alignment.' },
    },
  },

  Row: {
    type: 'Row',
    category: 'layout',
    acceptsChildren: true,
    description: 'Horizontal layout container.',
    props: {
      gap: { type: 'enum', enumValues: GAP_VALUES },
      align: { type: 'enum', enumValues: ALIGN_VALUES },
      wrap: { type: 'boolean', description: 'Wrap to the next line when space is constrained. Defaults to true in the narrow right-side panel; set false only for a deliberate compact layout.' },
    },
  },

  Grid: {
    type: 'Grid',
    category: 'layout',
    acceptsChildren: true,
    description: 'Grid layout with fixed columns.',
    props: {
      columns: { type: 'number', min: 1, max: 4, required: true, description: 'Number of columns (1-4).' },
      gap: { type: 'enum', enumValues: GAP_VALUES },
    },
  },

  Card: {
    type: 'Card',
    category: 'layout',
    acceptsChildren: true,
    description: 'Bordered container with optional title.',
    props: {
      title: { type: 'string', maxLength: 200, description: 'Optional card title.' },
      variant: { type: 'enum', enumValues: ['default', 'subtle', 'emphasis'] as const },
    },
  },

  Divider: {
    type: 'Divider',
    category: 'layout',
    acceptsChildren: false,
    description: 'Horizontal separator line.',
    props: {},
  },

  // ── 展示 ──

  Text: {
    type: 'Text',
    category: 'display',
    acceptsChildren: false,
    description: 'Static text display.',
    props: {
      content: { type: 'string', maxLength: UI_LIMITS.maxTextPropChars, required: true, description: 'Text content.' },
      variant: { type: 'enum', enumValues: ['body', 'caption', 'heading', 'code'] as const },
      tone: { type: 'enum', enumValues: ['default', 'muted', 'success', 'warning', 'danger', 'info'] as const },
    },
  },

  Badge: {
    type: 'Badge',
    category: 'display',
    acceptsChildren: false,
    description: 'Small status badge.',
    props: {
      text: { type: 'string', maxLength: 100, required: true, description: 'Badge text.' },
      variant: { type: 'enum', enumValues: ['default', 'success', 'warning', 'danger', 'info'] as const },
    },
  },

  Table: {
    type: 'Table',
    category: 'display',
    acceptsChildren: false,
    description: 'Read-only data table.',
    props: {
      columns: {
        type: 'array',
        required: true,
        description: `Column definitions (max ${UI_LIMITS.maxTableColumns}).`,
        itemSchema: {
          key: { type: 'string', maxLength: 64, required: true },
          label: { type: 'string', maxLength: 100, required: true },
        },
      },
      rows: {
        type: 'array',
        required: true,
        description: `Row data (max ${UI_LIMITS.maxTableRows} rows).`,
      },
    },
  },

  Alert: {
    type: 'Alert',
    category: 'display',
    acceptsChildren: false,
    description: 'Static status callout for important information, success, warnings, or errors.',
    props: {
      variant: { type: 'enum', enumValues: ['info', 'success', 'warning', 'danger', 'neutral'] as const },
      title: { type: 'string', maxLength: 200, required: true, description: 'Short callout title.' },
      description: { type: 'string', maxLength: UI_LIMITS.maxTextPropChars, description: 'Optional supporting detail.' },
    },
  },

  Progress: {
    type: 'Progress',
    category: 'display',
    acceptsChildren: false,
    description: 'Read-only progress indicator from 0 to 100.',
    props: {
      value: { type: 'number', min: 0, max: 100, required: true, description: 'Current progress percentage (0-100).' },
      label: { type: 'string', maxLength: 200, description: 'Optional progress label.' },
      showValue: { type: 'boolean', description: 'Show the percentage beside the label.' },
      tone: { type: 'enum', enumValues: ['default', 'success', 'warning', 'danger'] as const },
    },
  },

  CodeBlock: {
    type: 'CodeBlock',
    category: 'display',
    acceptsChildren: false,
    description: 'Read-only plain-text code block. Content is always rendered as text, never HTML.',
    props: {
      code: { type: 'string', maxLength: UI_LIMITS.maxTextPropChars, required: true, description: 'Code or other preformatted plain text.' },
      language: { type: 'string', maxLength: 40, description: 'Optional language label; this does not execute or highlight code.' },
      title: { type: 'string', maxLength: 200, description: 'Optional code block title.' },
    },
  },

  // ── 输入 ──

  TextInput: {
    type: 'TextInput',
    category: 'input',
    acceptsChildren: false,
    description: 'Single-line text input.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true, description: 'Field name for value collection.' },
      label: { type: 'string', maxLength: 200 },
      placeholder: { type: 'string', maxLength: 200 },
      required: { type: 'boolean' },
      minLength: { type: 'number', min: 0, max: 10000 },
      maxLength: { type: 'number', min: 1, max: UI_LIMITS.maxTextPropChars },
    },
  },

  NumberInput: {
    type: 'NumberInput',
    category: 'input',
    acceptsChildren: false,
    description: 'Numeric input.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200 },
      min: { type: 'number' },
      max: { type: 'number' },
      step: { type: 'number', min: 0 },
      required: { type: 'boolean' },
    },
  },

  Textarea: {
    type: 'Textarea',
    category: 'input',
    acceptsChildren: false,
    description: 'Multi-line text input.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200 },
      rows: { type: 'number', min: 2, max: 12 },
      maxLength: { type: 'number', min: 1, max: UI_LIMITS.maxTextPropChars },
      required: { type: 'boolean' },
    },
  },

  Select: {
    type: 'Select',
    category: 'input',
    acceptsChildren: false,
    description: 'Dropdown selection.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200 },
      options: {
        type: 'array',
        required: true,
        description: `Selection options (max ${UI_LIMITS.maxSelectOptions}).`,
        itemSchema: {
          value: { type: 'string', maxLength: 200, required: true },
          label: { type: 'string', maxLength: 200, required: true },
        },
      },
      required: { type: 'boolean' },
    },
  },

  Checkbox: {
    type: 'Checkbox',
    category: 'input',
    acceptsChildren: false,
    description: 'Boolean checkbox.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200, required: true },
    },
  },

  RadioGroup: {
    type: 'RadioGroup',
    category: 'input',
    acceptsChildren: false,
    description: 'Radio button group.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200 },
      options: {
        type: 'array',
        required: true,
        description: `Radio options (max ${UI_LIMITS.maxSelectOptions}).`,
        itemSchema: {
          value: { type: 'string', maxLength: 200, required: true },
          label: { type: 'string', maxLength: 200, required: true },
        },
      },
      required: { type: 'boolean' },
    },
  },

  DateInput: {
    type: 'DateInput',
    category: 'input',
    acceptsChildren: false,
    description: 'Calendar date input. Submits an ISO calendar date string (YYYY-MM-DD) or null when empty.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200 },
      min: { type: 'string', maxLength: 10, description: 'Optional inclusive ISO date lower bound (YYYY-MM-DD).' },
      max: { type: 'string', maxLength: 10, description: 'Optional inclusive ISO date upper bound (YYYY-MM-DD).' },
      required: { type: 'boolean' },
    },
  },

  Slider: {
    type: 'Slider',
    category: 'input',
    acceptsChildren: false,
    description: 'Numeric range slider. Submits a finite number.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200 },
      min: { type: 'number', required: true, description: 'Minimum allowed value.' },
      max: { type: 'number', required: true, description: 'Maximum allowed value.' },
      step: { type: 'number', min: 0, description: 'Optional positive step; defaults to 1.' },
      showValue: { type: 'boolean', description: 'Show the current numeric value.' },
    },
  },

  Switch: {
    type: 'Switch',
    category: 'input',
    acceptsChildren: false,
    description: 'Boolean on/off switch.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200, required: true },
      description: { type: 'string', maxLength: 500, description: 'Optional supporting detail.' },
    },
  },

  SegmentedControl: {
    type: 'SegmentedControl',
    category: 'input',
    acceptsChildren: false,
    description: 'Compact single-choice segmented control. Submits the selected option value.',
    props: {
      name: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true },
      label: { type: 'string', maxLength: 200 },
      options: {
        type: 'array',
        required: true,
        description: `Segment options (max ${UI_LIMITS.maxSelectOptions}).`,
        itemSchema: {
          value: { type: 'string', maxLength: 200, required: true },
          label: { type: 'string', maxLength: 200, required: true },
        },
      },
      required: { type: 'boolean' },
    },
  },

  // ── 操作 ──

  Button: {
    type: 'Button',
    category: 'action',
    acceptsChildren: false,
    description: 'Action button. When clicked, triggers the referenced action.',
    props: {
      label: { type: 'string', maxLength: 100, required: true, description: 'Button text.' },
      actionId: { type: 'string', maxLength: UI_LIMITS.maxIdLength, required: true, description: 'References an action defined in spec.actions.' },
      variant: { type: 'enum', enumValues: ['primary', 'secondary', 'ghost', 'danger'] as const },
      disabled: { type: 'boolean' },
    },
  },
};

// ═══════════════════════════════════════════════════════════════
// 派生工具
// ═══════════════════════════════════════════════════════════════

/** 获取所有组件类型名 */
export function getComponentTypes(): string[] {
  return Object.keys(CATALOG);
}

/** 检查组件类型是否存在于 Catalog */
export function isKnownComponent(type: string): boolean {
  return type in CATALOG;
}

/** 获取组件 schema */
export function getComponentSchema(type: string): ComponentSchema | undefined {
  return CATALOG[type];
}

/** 检查组件是否接受 children */
export function acceptsChildren(type: string): boolean {
  return CATALOG[type]?.acceptsChildren ?? false;
}

/**
 * 生成 Agent 可阅读的 Catalog 精简描述。
 * 用于工具描述和 Feature Skill。
 */
export function generateCatalogDescription(): string {
  const lines: string[] = [
    'Available UI components (catalogVersion: v1):',
    '',
  ];

  for (const schema of Object.values(CATALOG)) {
    const propsList = Object.entries(schema.props)
      .map(([name, p]) => {
        const parts = [name];
        if (p.type === 'enum' && p.enumValues) {
          parts.push(`(${p.enumValues.join('|')})`);
        } else {
          parts.push(`(${p.type})`);
        }
        if (p.required) parts.push('[required]');
        return parts.join(' ');
      })
      .join(', ');

    const childNote = schema.acceptsChildren ? ' [has children]' : '';
    lines.push(`  ${schema.type}${childNote}: ${schema.description}`);
    if (propsList) {
      lines.push(`    props: ${propsList}`);
    }
  }

  return lines.join('\n');
}
