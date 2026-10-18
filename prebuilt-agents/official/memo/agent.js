/**
 * Memo（memo）— 备忘录 APP，APP 型工作空间的第一个实体 agent（壳）
 *
 * ADR-0024 定位的 APP 形态：对话流即主交互，长期单线程承接连续性，
 * 线程事实由 Claw server 侧线程设施持有（创建 / 接力 / 归档均不在
 * agent 内）。本文件刻意保持空壳装配：
 *
 * - UserInputFeature：面向「人类在面板输入」的交互式输入；
 * - ContextRotationTriggerFeature：上下文过界 → 自动线程接力
 *   （与 coder 同构的阈值触发，ADR-0024「APP 接续更频繁」方向的基础
 *   形态；后续 memo 的自定义接续变换在装配层叠加，不在本壳内实现）；
 * - TimeAwarenessFeature：系统时间注入，每次用户输入前都注入（提醒登记
 *   的相对时间解析前提；默认 4 小时节奏对「一分钟后」类解析太粗）；
 * - MemoNotesFeature / MemoRemindersFeature：便签与定时提醒的工具面
 *   （数据落 workspaces/memo/，首页便签墙 / 提醒列表 block 的数据面在
 *   server 侧 memo-app 路由，同域）。
 *
 * 与线程的关系同 coder：agent 本身不感知线程；会话创建 / trim / 摘要的
 * 线程接线由 server/thread-control/thread-integration.js 在会话生命
 * 周期钩子上完成，runtime 只按普通会话运行。唯一活动线程、新建换代
 * 归档等 APP 业务状态由服务端 memo-app 模块持有（qqbot 接线员会话的
 * workspace 配置先例同构）。
 */

import { BasicAgent, TemplateComposer, UserInputFeature } from '@agentdevjs/core';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ContextRotationTriggerFeature } from '../../../local-features/dist/context-guard/src/index.js';
import { TimeAwarenessFeature } from '../../../local-features/dist/time-awareness/src/index.js';
import { MemoNotesFeature } from '../../../local-features/dist/memo-notes/src/index.js';
import { MemoRemindersFeature } from '../../../local-features/dist/memo-reminders/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SYSTEM_PROMPT_PATH = join(__dirname, '.agentdev', 'prompts', 'system.md');

/**
 * Memo Agent（空壳）
 */
export default class MemoAgent extends BasicAgent {
  constructor(config = {}) {
    const workspaceDir = config.workspaceDir || process.cwd();
    super({ ...config, workspaceDir });

    // 面板输入：memo 是交互式 APP，用户输入是常态输入形态。
    this.use(new UserInputFeature());

    // 便签存储：增删改查工具面（数据落 workspaces/memo/notes/，首页便签墙
    // 的数据面在 server 侧 memo-app 路由，同域）。
    this.use(new MemoNotesFeature());

    const runtime = config.runtime && typeof config.runtime === 'object' ? config.runtime : {};
    const runtimeIdentity = {
      agentId: runtime.agentId || process.env.PROTOCLAW_PREBUILT_AGENT_ID || 'memo',
      sessionId: runtime.sessionId ?? process.env.PROTOCLAW_PREBUILT_SESSION_ID ?? '',
      serverOrigin: runtime.serverOrigin || process.env.PROTOCLAW_SERVER_ORIGIN || 'http://127.0.0.1:1420',
    };
    // 上下文过界 → 自动线程接力：过界时打断并上报，由服务端 thread-rotation
    // 执行 trim+摘要接力（与 coder 同构，装配即确定、零配置）。
    this.use(new ContextRotationTriggerFeature({
      ...(config.contextGuard && typeof config.contextGuard === 'object'
        ? config.contextGuard : {}),
      agentId: runtimeIdentity.agentId,
      sessionId: runtimeIdentity.sessionId,
      serverOrigin: runtimeIdentity.serverOrigin,
    }));

    // 时间感知：每次用户输入前注入系统时间与时区——提醒登记的相对时间解析
    //（「明天 9 点」「一分钟后」→ 带时区 ISO）以此为前提。APP 形态下相邻
    // 输入可能相隔数小时，默认 4 小时节奏会让模型拿过时时间算提醒，故取
    // reportIntervalMs: 0 全量注入。
    this.use(new TimeAwarenessFeature({ reportIntervalMs: 0 }));

    // 定时提醒：工具面登记 + 到点投递（定时器住 runtime，boot 自启是提醒
    // 刚性的前提；数据落 workspaces/memo/reminders.json，首页提醒列表
    // block 的数据面在 server 侧 memo-app 路由，同域）。
    this.use(new MemoRemindersFeature({
      agentId: runtimeIdentity.agentId,
      sessionId: runtimeIdentity.sessionId,
      serverOrigin: runtimeIdentity.serverOrigin,
    }));
  }

  async onInitiate(ctx) {
    await super.onInitiate(ctx);
    this.setSystemPrompt(new TemplateComposer()
      .add({ file: SYSTEM_PROMPT_PATH }));
  }
}
