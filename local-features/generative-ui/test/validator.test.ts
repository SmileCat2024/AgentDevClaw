/**
 * Generative UI Validator 契约测试
 *
 * 验证：合法 Spec 通过、非法引用被拒、循环被拒、未知组件被拒、
 * 超限被拒、action 越权被拒、图结构非法被拒。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateGenerativeUISpec } from '../src/validator.js';
import type { GenerativeUISpecV1 } from '../src/types.js';

// ═══════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════

/** 构造一个合法的最小 Spec */
function makeValidSpec(): GenerativeUISpecV1 {
  return {
    schemaVersion: 1,
    catalogVersion: 'v1',
    title: 'Test Page',
    root: 'root',
    elements: {
      root: {
        type: 'Stack',
        props: { gap: 'md' },
        children: ['title'],
      },
      title: {
        type: 'Text',
        props: { content: 'Hello World' },
        children: [],
      },
    },
  };
}

/** 构造一个带表单和提交的合法 Spec */
function makeSpecWithForm(): GenerativeUISpecV1 {
  return {
    schemaVersion: 1,
    catalogVersion: 'v1',
    title: 'Form',
    root: 'root',
    elements: {
      root: { type: 'Stack', props: { gap: 'md' }, children: ['name', 'env', 'submit'] },
      name: { type: 'TextInput', props: { name: 'username', label: 'Name', required: true }, children: [] },
      env: {
        type: 'Select',
        props: {
          name: 'environment',
          label: 'Environment',
          options: [
            { value: 'dev', label: 'Dev' },
            { value: 'prod', label: 'Prod' },
          ],
        },
        children: [],
      },
      submit: { type: 'Button', props: { label: 'Submit', actionId: 'submit-form' }, children: [] },
    },
    initialValues: { username: '', environment: 'dev' },
    actions: {
      'submit-form': {
        intent: 'submit',
        label: 'Submit Form',
        includeFields: ['username', 'environment'],
      },
    },
  };
}

function expectValid(result: { valid: boolean; errors: string[] }, msg?: string) {
  assert.ok(result.valid, `${msg ?? 'Spec should be valid'} — errors: ${result.errors.join('; ')}`);
}

function expectInvalid(result: { valid: boolean; errors: string[] }, msg?: string) {
  assert.ok(!result.valid, msg ?? 'Spec should be invalid');
}

function expectErrorContains(result: { valid: boolean; errors: string[] }, substring: string) {
  const found = result.errors.some(e => e.includes(substring));
  assert.ok(found, `Expected an error containing "${substring}", got: ${result.errors.join('; ')}`);
}

// ═══════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════

describe('validateGenerativeUISpec', () => {

  describe('合法 Spec', () => {
    it('最小合法 Spec 通过', () => {
      expectValid(validateGenerativeUISpec(makeValidSpec()));
    });

    it('带表单和 action 的 Spec 通过', () => {
      expectValid(validateGenerativeUISpec(makeSpecWithForm()));
    });

    it('嵌套结构通过', () => {
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Nested',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: { gap: 'md' }, children: ['card1', 'card2'] },
          card1: { type: 'Card', props: { title: 'Card 1' }, children: ['text1'] },
          card2: { type: 'Card', props: { title: 'Card 2', variant: 'subtle' }, children: ['badge1'] },
          text1: { type: 'Text', props: { content: 'Inside Card 1', variant: 'body' }, children: [] },
          badge1: { type: 'Badge', props: { text: 'New', variant: 'success' }, children: [] },
        },
      };
      expectValid(validateGenerativeUISpec(spec));
    });

    it('带 reset action 通过', () => {
      const spec = makeSpecWithForm();
      spec.actions!['reset-form'] = { intent: 'reset', label: 'Reset' };
      expectValid(validateGenerativeUISpec(spec));
    });

    it('第一批扩展组件和确认 action 通过', () => {
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Release controls',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: ['alert', 'progress', 'code', 'date', 'slider', 'switch', 'segment', 'submit'] },
          alert: { type: 'Alert', props: { variant: 'warning', title: 'Review changes' }, children: [] },
          progress: { type: 'Progress', props: { value: 65, label: 'Readiness' }, children: [] },
          code: { type: 'CodeBlock', props: { code: '{"safe":true}', language: 'json' }, children: [] },
          date: { type: 'DateInput', props: { name: 'releaseDate', min: '2026-01-01', max: '2026-12-31' }, children: [] },
          slider: { type: 'Slider', props: { name: 'rollout', min: 0, max: 100, step: 5 }, children: [] },
          switch: { type: 'Switch', props: { name: 'notify', label: 'Notify users' }, children: [] },
          segment: { type: 'SegmentedControl', props: { name: 'mode', options: [{ value: 'safe', label: 'Safe' }, { value: 'fast', label: 'Fast' }] }, children: [] },
          submit: { type: 'Button', props: { label: 'Apply', actionId: 'apply' }, children: [] },
        },
        initialValues: { releaseDate: '2026-08-05', rollout: 25, notify: true, mode: 'safe' },
        actions: {
          apply: { intent: 'submit', label: 'Apply', confirm: { title: 'Apply changes?', description: 'This sends the form values.', confirmLabel: 'Apply now' } },
        },
      };
      expectValid(validateGenerativeUISpec(spec));
    });

    it('stats 返回 elementCount 和 maxDepth', () => {
      const result = validateGenerativeUISpec(makeSpecWithForm());
      expectValid(result);
      assert.ok(result.stats);
      assert.equal(result.stats!.elementCount, 4);
      assert.ok(result.stats!.maxDepth >= 2);
    });
  });

  describe('非法 Spec — 顶层字段', () => {
    it('schemaVersion 不对', () => {
      const spec = makeValidSpec() as any;
      spec.schemaVersion = 2;
      expectInvalid(validateGenerativeUISpec(spec));
    });

    it('catalogVersion 不对', () => {
      const spec = makeValidSpec() as any;
      spec.catalogVersion = 'v2';
      expectInvalid(validateGenerativeUISpec(spec));
    });

    it('title 为空', () => {
      const spec = makeValidSpec();
      spec.title = '';
      expectInvalid(validateGenerativeUISpec(spec));
    });

    it('root 不存在', () => {
      const spec = makeValidSpec();
      spec.root = 'nonexistent';
      expectInvalid(validateGenerativeUISpec(spec));
    });

    it('elements 不是对象', () => {
      const spec = makeValidSpec() as any;
      spec.elements = [];
      expectInvalid(validateGenerativeUISpec(spec));
    });
  });

  describe('非法 Spec — 组件类型', () => {
    it('未知组件被拒', () => {
      const spec = makeValidSpec() as any;
      spec.elements.title.type = 'TextBox';
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'unknown type');
    });
  });

  describe('非法 Spec — 图结构', () => {
    it('child 引用不存在的元素', () => {
      const spec = makeValidSpec();
      spec.elements.root.children = ['ghost'];
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'unknown child');
    });

    it('循环被检测', () => {
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Cycle',
        root: 'a',
        elements: {
          a: { type: 'Stack', props: {}, children: ['b'] },
          b: { type: 'Stack', props: {}, children: ['a'] },
        },
      };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'Cycle');
    });

    it('多父节点被拒', () => {
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'MultiParent',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: ['shared', 'c1'] },
          c1: { type: 'Stack', props: {}, children: ['shared'] },
          shared: { type: 'Text', props: { content: 'X' }, children: [] },
        },
      };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'multiple parents');
    });

    it('孤立节点被拒', () => {
      const spec = makeValidSpec();
      spec.elements.orphan = { type: 'Text', props: { content: 'Orphan' }, children: [] };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'unreachable');
    });

    it('不接受 children 的组件有 children 被拒', () => {
      const spec = makeValidSpec();
      spec.elements.title.children = ['root'];
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'cannot have children');
    });
  });

  describe('非法 Spec — Props', () => {
    it('缺少 required prop', () => {
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Missing Prop',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: ['t'] },
          t: { type: 'Text', props: {}, children: [] },  // missing content
        },
      };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'missing required prop');
    });

    it('enum 值非法', () => {
      const spec = makeValidSpec();
      (spec.elements.root.props as any).gap = 'huge';
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'invalid value');
    });

    it('未知 prop 被拒', () => {
      const spec = makeValidSpec();
      (spec.elements.root.props as any).color = 'red';
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'unknown prop');
    });

    it('Grid columns 超出范围', () => {
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Grid',
        root: 'root',
        elements: {
          root: { type: 'Grid', props: { columns: 10 }, children: [] },
        },
      };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'exceeds maximum');
    });

    it('Select options 缺少 value', () => {
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Bad Select',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: ['sel'] },
          sel: {
            type: 'Select',
            props: { name: 'x', options: [{ label: 'A' }] },  // missing value
            children: [],
          },
        },
      };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'missing required field');
    });
  });

  describe('非法 Spec — Action', () => {
    it('Button 引用不存在的 action', () => {
      const spec = makeSpecWithForm();
      spec.elements.submit.props.actionId = 'nonexistent-action';
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'not defined');
    });

    it('action includeFields 引用不存在的字段', () => {
      const spec = makeSpecWithForm();
      spec.actions!['submit-form'].includeFields = ['ghost-field'];
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'unknown field');
    });

    it('action intent 非法', () => {
      const spec = makeSpecWithForm();
      (spec.actions!['submit-form'] as any).intent = 'delete';
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'intent');
    });

    it('Slider 的范围和步长必须有效', () => {
      const spec = makeSpecWithForm() as any;
      spec.elements.root.children = ['slider'];
      spec.elements.slider = { type: 'Slider', props: { name: 'rollout', min: 100, max: 0, step: 0 }, children: [] };
      delete spec.elements.name;
      delete spec.elements.env;
      delete spec.elements.submit;
      spec.initialValues = { rollout: 25 };
      spec.actions = {};
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'min to be less than max');
      expectErrorContains(result, 'step must be a positive');
    });

    it('DateInput 边界必须是 ISO 日期且顺序正确', () => {
      const spec = makeValidSpec() as any;
      spec.elements.root.children = ['date'];
      spec.elements.date = { type: 'DateInput', props: { name: 'date', min: '08/01/2026', max: '2026-01-01' }, children: [] };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'must use YYYY-MM-DD');
    });

    it('confirm 的文案受到长度和类型限制', () => {
      const spec = makeSpecWithForm() as any;
      spec.actions['submit-form'].confirm = { title: '', confirmLabel: 3 };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'confirm.title');
      expectErrorContains(result, 'confirm.confirmLabel');
    });
  });

  describe('非法 Spec — 限制', () => {
    it('重复字段名被拒', () => {
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Dup Field',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: ['a', 'b'] },
          a: { type: 'TextInput', props: { name: 'x', label: 'A' }, children: [] },
          b: { type: 'TextInput', props: { name: 'x', label: 'B' }, children: [] },
        },
      };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'Duplicate field name');
    });

    it('initialValues 引用不存在的字段', () => {
      const spec = makeSpecWithForm();
      spec.initialValues = { ghost: 'value' };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'does not match any input field');
    });

    it('元素过多被拒', () => {
      const spec = makeValidSpec();
      const elements: any = { root: { type: 'Stack', props: {}, children: [] } };
      for (let i = 0; i < 201; i++) {
        elements[`e${i}`] = { type: 'Text', props: { content: `E${i}` }, children: [] };
        elements.root.children.push(`e${i}`);
      }
      spec.elements = elements;
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
      expectErrorContains(result, 'Too many elements');
    });

    it('Table 列数超限', () => {
      const columns = Array.from({ length: 25 }, (_, i) => ({ key: `c${i}`, label: `C${i}` }));
      const spec: GenerativeUISpecV1 = {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Wide Table',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: ['tbl'] },
          tbl: { type: 'Table', props: { columns, rows: [] }, children: [] },
        },
      };
      const result = validateGenerativeUISpec(spec);
      expectInvalid(result);
    });
  });

  describe('Chart / Sparkline', () => {
    function specWith(elementId: string, type: string, props: Record<string, unknown>): GenerativeUISpecV1 {
      return {
        schemaVersion: 1,
        catalogVersion: 'v1',
        title: 'Charts',
        root: 'root',
        elements: {
          root: { type: 'Stack', props: {}, children: [elementId] },
          [elementId]: { type, props, children: [] },
        },
      };
    }

    const validChartProps = {
      chartType: 'line',
      labels: ['W31', 'W32', 'W33'],
      series: [
        { label: 'Claw', values: [48, 20, 137] },
        { label: 'Adv', values: [11, 9, 68], tone: 'success' },
      ],
      unit: 'commits',
      height: 200,
    };

    it('合法折线图通过', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', validChartProps));
      expectValid(result);
    });

    it('合法柱状图（含 yMin/yMax）通过', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', {
        chartType: 'bar',
        labels: ['a', 'b'],
        series: [{ label: 'S', values: [1, 2] }],
        yMin: 0,
        yMax: 10,
        showValues: true,
      }));
      expectValid(result);
    });

    it('values 长度与 labels 不一致被拒', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', {
        chartType: 'line',
        labels: ['a', 'b', 'c'],
        series: [{ label: 'S', values: [1, 2] }],
      }));
      expectInvalid(result);
      expectErrorContains(result, 'must match labels length');
    });

    it('series 为空数组被拒', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', {
        chartType: 'bar', labels: ['a'], series: [],
      }));
      expectInvalid(result);
      expectErrorContains(result, 'non-empty array');
    });

    it('series 超过 5 组被拒', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', {
        chartType: 'line',
        labels: ['a'],
        series: Array.from({ length: 6 }, (_, i) => ({ label: `S${i}`, values: [1] })),
      }));
      expectInvalid(result);
      expectErrorContains(result, 'too many series');
    });

    it('values 含非有限数字被拒', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', {
        chartType: 'line',
        labels: ['a', 'b'],
        series: [{ label: 'S', values: [1, 'oops'] }],
      }));
      expectInvalid(result);
      expectErrorContains(result, 'must be a finite number');
    });

    it('series tone 非法被拒', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', {
        chartType: 'line',
        labels: ['a'],
        series: [{ label: 'S', values: [1], tone: 'muted' }],
      }));
      expectInvalid(result);
      expectErrorContains(result, 'series[0].tone');
    });

    it('yMin >= yMax 被拒', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', {
        chartType: 'line', labels: ['a'], series: [{ label: 'S', values: [1] }], yMin: 5, yMax: 5,
      }));
      expectInvalid(result);
      expectErrorContains(result, 'yMin to be less than yMax');
    });

    it('Chart 未知 prop 被拒', () => {
      const result = validateGenerativeUISpec(specWith('c', 'Chart', {
        ...validChartProps,
        legend: true,
      }));
      expectInvalid(result);
      expectErrorContains(result, 'unknown prop "legend"');
    });

    it('合法 Sparkline 通过', () => {
      const result = validateGenerativeUISpec(specWith('s', 'Sparkline', {
        values: [1, 3, 2, 5, 4],
        tone: 'info',
        width: 140,
        height: 32,
      }));
      expectValid(result);
    });

    it('Sparkline values 少于 2 个被拒', () => {
      const result = validateGenerativeUISpec(specWith('s', 'Sparkline', { values: [1] }));
      expectInvalid(result);
      expectErrorContains(result, 'at least 2');
    });

    it('Sparkline values 超过 100 个被拒', () => {
      const result = validateGenerativeUISpec(specWith('s', 'Sparkline', {
        values: Array.from({ length: 101 }, (_, i) => i),
      }));
      expectInvalid(result);
      expectErrorContains(result, 'too many numbers');
    });
  });

  describe('边界 — 完全空/非法输入', () => {
    it('null 被拒', () => {
      expectInvalid(validateGenerativeUISpec(null));
    });

    it('数组被拒', () => {
      expectInvalid(validateGenerativeUISpec([]));
    });

    it('字符串被拒', () => {
      expectInvalid(validateGenerativeUISpec('hello'));
    });
  });
});
