import { BasicAgent } from '@agentdevjs/core';
import { assemblePhFeatureConfig } from '../../../prebuilt-agents/official/programming-helper/agent.js';

/**
 * PH 项目配置隔离探针夹具（ticket 043）。
 *
 * 类本身是哑装配（不挂业务 feature，模型调用即抛错）；唯一职责是用真实
 * 编程小助手的配置队列实现（assemblePhFeatureConfig——真实层文件读取 +
 * $mount 提取 + 累加折叠 + merge，与产品路径同一段代码）组装本实例配置，
 * 并把结果经 IPC 探针外发。宿主（run-prebuilt-agent）从 Session 索引逐
 * 实例注入的 projectId 驱动目录层/项目层选择——本夹具不复制任何归属规则。
 */
export default class PhProjectConfigProbeAgent extends BasicAgent {
  constructor(options) {
    super({ ...options, llm: { modelName: 'fixture', async onCall() { throw new Error('Fixture must not call a model'); } } });
    const { layerIds, merged } = assemblePhFeatureConfig({
      projectId: options.projectId,
      workspaceDir: process.env.FIXTURE_DIR_D || process.cwd(),
      sessionConfig: {},
    });
    process.send({
      type: 'config-probe',
      sessionId: options.sessionId ?? null,
      projectId: options.projectId ?? null,
      layerIds,
      probe: merged.probe?.value ?? null,
      extraDirs: merged.skill?.extraDirs ?? [],
    });
  }
}
