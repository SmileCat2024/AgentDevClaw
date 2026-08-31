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

  // ── 导航/折叠 ──

  Tabs: {
    type: 'Tabs',
    category: 'layout',
    acceptsChildren: true,
    description: 'Tab navigation. Each child element is one tab panel, in the same order as items.',
    props: {
      items: {
        type: 'array',
        required: true,
        description: 'Tab definitions. Each child element renders as the corresponding tab panel by index.',
        itemSchema: {
          label: { type: 'string', maxLength: 100, required: true },
          value: { type: 'string', maxLength: 100, required: true },
        },
      },
      defaultIndex: { type: 'number', min: 0, description: 'Index of the initially active tab (0-based). Defaults to 0.' },
    },
  },

  Accordion: {
    type: 'Accordion',
    category: 'layout',
    acceptsChildren: true,
    description: 'Collapsible sections. Each child element is one section body, in the same order as items.',
    props: {
      items: {
        type: 'array',
        required: true,
        description: 'Section headers. Each child element renders as the corresponding section body by index.',
        itemSchema: {
          title: { type: 'string', maxLength: 200, required: true },
        },
      },
      defaultOpen: {
        type: 'array',
        description: 'Indices of sections open by default (0-based). Empty or omitted = all collapsed.',
      },
      multiple: { type: 'boolean', description: 'Allow multiple sections open at once. Defaults to true.' },
    },
  },

  // ── 展示扩展 ──

  Steps: {
    type: 'Steps',
    category: 'display',
    acceptsChildren: false,
    description: 'Horizontal step progress indicator.',
    props: {
      items: {
        type: 'array',
        required: true,
        description: 'Step definitions.',
        itemSchema: {
          title: { type: 'string', maxLength: 100, required: true },
          description: { type: 'string', maxLength: 500 },
        },
      },
      current: { type: 'number', min: 0, required: true, description: 'Index of the current step (0-based).' },
    },
  },

  Spinner: {
    type: 'Spinner',
    category: 'display',
    acceptsChildren: false,
    description: 'Loading spinner indicator.',
    props: {
      size: { type: 'enum', enumValues: ['sm', 'md', 'lg'] as const },
      label: { type: 'string', maxLength: 200, description: 'Optional loading text.' },
    },
  },

  Image: {
    type: 'Image',
    category: 'display',
    acceptsChildren: false,
    description: 'Image display.',
    props: {
      src: { type: 'string', maxLength: UI_LIMITS.maxTextPropChars, required: true, description: 'Image URL.' },
      alt: { type: 'string', maxLength: 500, required: true, description: 'Alt text for accessibility.' },
      width: { type: 'number', min: 1, max: 2000, description: 'Optional width in CSS pixels.' },
      height: { type: 'number', min: 1, max: 2000, description: 'Optional height in CSS pixels.' },
    },
  },

  Avatar: {
    type: 'Avatar',
    category: 'display',
    acceptsChildren: false,
    description: 'User avatar. Shows an image when src is provided, otherwise falls back to initials from name.',
    props: {
      name: { type: 'string', maxLength: 200, required: true, description: 'Person name. Used for initials fallback.' },
      src: { type: 'string', maxLength: UI_LIMITS.maxTextPropChars, description: 'Optional avatar image URL.' },
      size: { type: 'enum', enumValues: ['sm', 'md', 'lg'] as const },
    },
  },

  Link: {
    type: 'Link',
    category: 'display',
    acceptsChildren: false,
    description: 'Hyperlink that opens in a new tab.',
    props: {
      text: { type: 'string', maxLength: 500, required: true, description: 'Link display text.' },
      href: { type: 'string', maxLength: UI_LIMITS.maxTextPropChars, required: true, description: 'Target URL.' },
    },
  },

  Stat: {
    type: 'Stat',
    category: 'display',
    acceptsChildren: false,
    description: 'Key-value metric card for dashboards. Displays a label and a large value.',
    props: {
      label: { type: 'string', maxLength: 200, required: true, description: 'Metric label.' },
      value: { type: 'string', maxLength: 200, required: true, description: 'Metric value.' },
      unit: { type: 'string', maxLength: 50, description: 'Optional unit suffix displayed after value.' },
      tone: { type: 'enum', enumValues: ['default', 'success', 'warning', 'danger', 'info'] as const },
    },
  },

  Skeleton: {
    type: 'Skeleton',
    category: 'display',
    acceptsChildren: false,
    description: 'Loading placeholder skeleton.',
    props: {
      variant: { type: 'enum', enumValues: ['text', 'rect', 'circle'] as const },
      width: { type: 'number', min: 1, max: 2000, description: 'CSS pixel width.' },
      height: { type: 'number', min: 1, max: 2000, description: 'CSS pixel height.' },
      rounded: { type: 'boolean', description: 'Use fully rounded corners. Defaults to false; circles always fully round.' },
    },
  },

  Carousel: {
    type: 'Carousel',
    category: 'layout',
    acceptsChildren: true,
    description: 'Horizontally scrollable carousel of slides. Each child element is one slide.',
    props: {
      loop: { type: 'boolean', description: 'Loop back to the first slide after the last. Defaults to false.' },
    },
  },

  Tooltip: {
    type: 'Tooltip',
    category: 'display',
    acceptsChildren: false,
    description: 'Inline text with a hover tooltip.',
    props: {
      text: { type: 'string', maxLength: 500, required: true, description: 'Visible inline text.' },
      content: { type: 'string', maxLength: 1000, required: true, description: 'Tooltip content shown on hover.' },
    },
  },

  Chart: {
    type: 'Chart',
    category: 'display',
    acceptsChildren: false,
    description: 'Read-only line or bar chart rendered as inline SVG. Prefer this over Image/SVG data URIs for data visualization.',
    props: {
      chartType: { type: 'enum', enumValues: ['line', 'bar'] as const, required: true, description: 'Chart type.' },
      series: {
        type: 'array',
        required: true,
        description: 'Data series (1-5). Every series must provide a values array whose length matches labels. Tones default to the catalog palette order when omitted.',
        itemSchema: {
          label: { type: 'string', maxLength: 100, required: true },
          tone: { type: 'enum', enumValues: ['default', 'success', 'warning', 'danger', 'info'] as const },
        },
      },
      labels: { type: 'array', required: true, description: 'X-axis category labels (1-60 strings), one per data point.' },
      unit: { type: 'string', maxLength: 50, description: 'Optional unit suffix shown beside y-axis ticks and in hover titles.' },
      showLegend: { type: 'boolean', description: 'Show the series legend. Defaults to true when there is more than one series.' },
      showGrid: { type: 'boolean', description: 'Show horizontal grid lines. Defaults to true.' },
      showValues: { type: 'boolean', description: 'Bar chart only: print each value above its bar. Defaults to false.' },
      height: { type: 'number', min: 120, max: 600, description: 'Chart height in CSS pixels. Defaults to 220.' },
      yMin: { type: 'number', description: 'Optional fixed y-axis lower bound.' },
      yMax: { type: 'number', description: 'Optional fixed y-axis upper bound.' },
    },
  },

  Sparkline: {
    type: 'Sparkline',
    category: 'display',
    acceptsChildren: false,
    description: 'Tiny inline trend line for embedding beside text or inside Stat cards.',
    props: {
      values: { type: 'array', required: true, description: 'Data points (2-100 finite numbers).' },
      tone: { type: 'enum', enumValues: ['default', 'success', 'warning', 'danger', 'info'] as const },
      width: { type: 'number', min: 40, max: 2000, description: 'Width in CSS pixels. Defaults to 120.' },
      height: { type: 'number', min: 16, max: 96, description: 'Height in CSS pixels. Defaults to 32.' },
      showArea: { type: 'boolean', description: 'Fill the area under the line with a translucent tint. Defaults to true.' },
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
