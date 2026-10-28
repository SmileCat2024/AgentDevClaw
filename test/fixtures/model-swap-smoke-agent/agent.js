import { BasicAgent } from '@agentdevjs/core';
import { ModelSelectionFeature } from '../../../local-features/dist/model-selection/src/index.js';

/**
 * 模型热切换冒烟 fixture（ADR-0034 新链路）。
 *
 * 装配 model-selection Feature：冒烟测试经宿主 feature-comms 请求面
 * （feature-comms-request IPC → onHostRequest selectModel）驱动切换，
 * 断言回执语义与进程存活。
 *
 * serverOrigin 指向不存在的端口：declareChannel 失败被 Feature 容错
 * （declared=false，仅影响事件镜像），请求面不受影响。
 */
export class SmokeAgent extends BasicAgent {
  constructor(config = {}) {
    super(config);
    this.use(new ModelSelectionFeature({
      agentId: 'smoke-agent',
      sessionId: config.runtime?.sessionId ?? '',
      serverOrigin: 'http://127.0.0.1:1',
    }));
  }

  async prepareRuntime() {
    // 冒烟专用：无会话无 call 的场景也要让 feature 完成 onInitiate
    //（注入 modelControl）——请求面才能驱动 setModel。
    if (typeof this.ensureFeatureTools === 'function') await this.ensureFeatureTools();
  }
}
export default SmokeAgent;
