/**
 * Generative UI Catalog 契约测试
 *
 * 验证：组件完备性（35个）、分类正确、JSON Schema 描述生成稳定、
 * helper 函数行为正确。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG,
  getComponentTypes,
  isKnownComponent,
  getComponentSchema,
  acceptsChildren,
  generateCatalogDescription,
} from '../src/catalog.js';

describe('Catalog', () => {

  describe('组件完备性', () => {
    it('包含全部 35 个 V1 组件', () => {
      const types = getComponentTypes();
      assert.equal(types.length, 35);
    });

    it('包含所有布局组件', () => {
      for (const name of ['Stack', 'Row', 'Grid', 'Card', 'Divider', 'Tabs', 'Accordion', 'Carousel']) {
        assert.ok(isKnownComponent(name), `Missing layout component: ${name}`);
      }
    });

    it('包含所有展示组件', () => {
      for (const name of ['Text', 'Badge', 'Table', 'Alert', 'Progress', 'CodeBlock', 'Steps', 'Spinner', 'Image', 'Avatar', 'Link', 'Stat', 'Skeleton', 'Tooltip', 'Chart', 'Sparkline']) {
        assert.ok(isKnownComponent(name), `Missing display component: ${name}`);
      }
    });

    it('包含所有输入组件', () => {
      for (const name of ['TextInput', 'NumberInput', 'Textarea', 'Select', 'Checkbox', 'RadioGroup', 'DateInput', 'Slider', 'Switch', 'SegmentedControl']) {
        assert.ok(isKnownComponent(name), `Missing input component: ${name}`);
      }
    });

    it('包含操作组件', () => {
      assert.ok(isKnownComponent('Button'));
    });

    it('不包含 V1 排除的组件', () => {
      // Markdown / HTML / iframe 有脚本注入面，FileInput / PasswordInput 涉及敏感输入，
      // 均不在 Catalog 中。Chart 曾在此清单，后以纯 SVG DOM 渲染实现并通过用户需求转正。
      for (const name of ['Markdown', 'HTML', 'FileInput', 'PasswordInput', 'iframe']) {
        assert.ok(!isKnownComponent(name), `Should not have component: ${name}`);
      }
    });
  });

  describe('分类', () => {
    it('布局组件都是 layout 类', () => {
      for (const name of ['Stack', 'Row', 'Grid', 'Card', 'Divider', 'Tabs', 'Accordion', 'Carousel']) {
        assert.equal(getComponentSchema(name)!.category, 'layout');
      }
    });

    it('展示组件都是 display 类', () => {
      for (const name of ['Text', 'Badge', 'Table', 'Alert', 'Progress', 'CodeBlock', 'Steps', 'Spinner', 'Image', 'Avatar', 'Link', 'Stat', 'Skeleton', 'Tooltip', 'Chart', 'Sparkline']) {
        assert.equal(getComponentSchema(name)!.category, 'display');
      }
    });

    it('输入组件都是 input 类', () => {
      for (const name of ['TextInput', 'NumberInput', 'Textarea', 'Select', 'Checkbox', 'RadioGroup', 'DateInput', 'Slider', 'Switch', 'SegmentedControl']) {
        assert.equal(getComponentSchema(name)!.category, 'input');
      }
    });

    it('Button 是 action 类', () => {
      assert.equal(getComponentSchema('Button')!.category, 'action');
    });
  });

  describe('children 能力', () => {
    it('容器组件接受 children', () => {
      for (const name of ['Stack', 'Row', 'Grid', 'Card', 'Tabs', 'Accordion', 'Carousel']) {
        assert.ok(acceptsChildren(name), `${name} should accept children`);
      }
    });

    it('Divider 不接受 children', () => {
      assert.ok(!acceptsChildren('Divider'));
    });

    it('展示组件不接受 children', () => {
      for (const name of ['Text', 'Badge', 'Table', 'Alert', 'Progress', 'CodeBlock', 'Steps', 'Spinner', 'Image', 'Avatar', 'Link', 'Stat', 'Skeleton', 'Tooltip', 'Chart', 'Sparkline']) {
        assert.ok(!acceptsChildren(name), `${name} should not accept children`);
      }
    });

    it('输入组件不接受 children', () => {
      for (const name of ['TextInput', 'NumberInput', 'Textarea', 'Select', 'Checkbox', 'RadioGroup', 'DateInput', 'Slider', 'Switch', 'SegmentedControl']) {
        assert.ok(!acceptsChildren(name), `${name} should not accept children`);
      }
    });
  });

  describe('required props', () => {
    it('Text 的 content 是 required', () => {
      assert.ok(CATALOG.Text.props.content.required);
    });

    it('TextInput 的 name 是 required', () => {
      assert.ok(CATALOG.TextInput.props.name.required);
    });

    it('Button 的 actionId 是 required', () => {
      assert.ok(CATALOG.Button.props.actionId.required);
    });

    it('Grid 的 columns 是 required', () => {
      assert.ok(CATALOG.Grid.props.columns.required);
    });

    it('Select 的 options 是 required', () => {
      assert.ok(CATALOG.Select.props.options.required);
    });
  });

  it('Text 支持与渲染器一致的 info tone', () => {
    assert.ok(CATALOG.Text.props.tone.enumValues?.includes('info'));
  });

  describe('helper 函数', () => {
    it('isKnownComponent 返回 false for 未知类型', () => {
      assert.ok(!isKnownComponent('FakeComponent'));
      assert.ok(!isKnownComponent(''));
    });

    it('getComponentSchema 返回 undefined for 未知类型', () => {
      assert.equal(getComponentSchema('FakeComponent'), undefined);
    });

    it('generateCatalogDescription 包含所有组件名', () => {
      const desc = generateCatalogDescription();
      for (const name of getComponentTypes()) {
        assert.ok(desc.includes(name), `Catalog description missing component: ${name}`);
      }
    });

    it('generateCatalogDescription 包含 catalogVersion', () => {
      const desc = generateCatalogDescription();
      assert.ok(desc.includes('v1'));
    });
  });
});
