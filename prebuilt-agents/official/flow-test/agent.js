/**
 * Flow 测试 Agent
 *
 * 用于验证 Flow 编排层运行时的测试 Agent。
 * 挂载 FlowFeature + MockCountingFeature，验证：
 * - 手动节点切换（complete_node）
 * - 变量驱动的自动切换（exitWhen）
 * - 工具 scope 管理
 */

import { BasicAgent, createTool, UserInputFeature } from 'agentdev';
import { FlowFeature } from '../../../local-features/dist/flow/src/index.js';

// ========== MockCountingFeature ==========

class MockCountingFeature {
  constructor() {
    this.name = 'mock-counting';
    this.dependencies = [];
    this.source = import.meta.url;
    this.description = '测试用计数器 Feature，暴露 mockCounter 变量给 Flow';
    this._counter = 0;
  }

  getFlowVariables() {
    const self = this;
    return [
      {
        key: 'mockCounter',
        type: 'number',
        title: '测试计数器',
        description: '每次调用 mock_increment 后增加的计数器',
        resolver: () => self._counter,
      },
    ];
  }

  getTools() {
    const self = this;
    return [
      createTool({
        name: 'mock_increment',
        description: '增加测试计数器。每次调用计数器 +1。用于测试 Flow 的变量驱动自动切换。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        execute: async () => {
          self._counter++;
          return { success: true, counter: self._counter, message: `计数器已增加到 ${self._counter}` };
        },
      }),
      createTool({
        name: 'mock_decrement',
        description: '减少测试计数器。每次调用计数器 -1。',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
        execute: async () => {
          self._counter--;
          return { success: true, counter: self._counter, message: `计数器已减少到 ${self._counter}` };
        },
      }),
    ];
  }

  captureState() {
    return { counter: this._counter };
  }

  restoreState(snapshot) {
    if (snapshot && typeof snapshot.counter === 'number') {
      this._counter = snapshot.counter;
    }
  }
}

// ========== FlowTestAgent ==========

export class FlowTestAgent extends BasicAgent {
  constructor(config = {}) {
    super(config);

    this.use(new MockCountingFeature());
    this.use(new FlowFeature());
    this.use(new UserInputFeature());
  }
}

export default FlowTestAgent;
