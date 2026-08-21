/**
 * Thread Control — 框架 WorkThread + WorkThreadBoard 的 Claw 装配点
 *
 * 线程定位（悬置地基）：一个稳定、可寻址的连续性锚点——把一组先后
 * 接力的 Session 认定为同一项进行中的工作，并负责把「之后要做什么」
 * 送到当前承接的 Session。
 *
 * ticket 008：controller 核心调用改走框架（agentdev）双对象装配——
 *   - core（WorkThread）：连续性锚点 / 交接挡板 / 指令 Inbox / hold；
 *   - board（WorkThreadBoard）：执行调度看板（executionEvents /
 *     recordRuntimeEvent / resume / mode），经 workThreadId 关联 core，
 *     永不反写锚点状态。
 *
 * 本文件不再持有自研状态机；Claw 侧保留的是装配与宿主接线：
 *   - 数据目录（THREADS_ROOT，历史线程原地兼容，见 thread-store.js 薄壳）；
 *   - bridge 生产装配：enabled + runtime 真相源（listAgentRuntimes 扫描，
 *     running 且 selectedSessionId 匹配 head 时返回 viewerAgentId）；
 *   - 真实投递函数 submitUserTurn（框架 core 域不背 HTTP 依赖，必须注入）。
 *
 * 宿主接线层（integration / rotation / gateway / routes / CLI / 前端）
 * 留在 Claw，不经本层迁移。
 */

import {
  WorkThread,
  WorkThreadBoard,
  WorkThreadRuntimeBridge,
} from '@agentdev/core';
import { ThreadStore } from './thread-store.js';
import { THREADS_ROOT } from '../shared/constants.js';
import { submitUserTurn } from '../shared/user-turn.js';
import { listAgentRuntimes, isManagedRuntimeRunning } from '../shared/agent-access.js';
import { sanitizeSessionFragment } from '../shared/string-helpers.js';

/**
 * 装配一套线程控制面。
 *
 * @param {object} [options]
 * @param {string} [options.rootDir] - 数据根目录（默认 THREADS_ROOT，测试注入临时目录）
 * @param {object} [options.bridge] - 桥实例（测试 stub）；缺省按生产装配构建
 * @returns {{ core: WorkThread, board: WorkThreadBoard, store: ThreadStore }}
 */
export function createThreadControl({ rootDir = THREADS_ROOT, bridge } = {}) {
  const store = new ThreadStore({ rootDir });
  const core = new WorkThread({
    store,
    bridge: bridge
      || new WorkThreadRuntimeBridge({
        enabled: true,
        // 框架桥不带 HTTP 客户端：真实投递必须由宿主注入（viewer 原子
        // user-turn 契约，排队语义由 runtime 侧 CallArbiter 串行消费）。
        submitTurn: submitUserTurn,
        // runtime 真相：扫描该 host 的 managed runtimes，找「运行中且当前
        // 绑定会话 === head」的进程（shared-by-project 模式下注册键可能
        // 漂移，selectedSessionId 才是当前绑定事实）。
        resolveRuntimeViewerId: (agentId, sessionId) => {
          const runtime = listAgentRuntimes(agentId).find(
            (r) => isManagedRuntimeRunning(r)
              && sanitizeSessionFragment(r.selectedSessionId) === sanitizeSessionFragment(sessionId),
          );
          return runtime?.viewerAgentId ?? null;
        },
      }),
  });
  const board = new WorkThreadBoard({ core, rootDir });
  return { core, board, store };
}

// ── 默认单例（server.js 装配）────────────────────────────────────

let _defaultControl = null;

/**
 * 默认控制面：数据落 USER_DATA_ROOT/threads（锚点）与 boards/（看板）。
 *
 * 注意：只有会话归属线程（当前仅 coder 工作空间经 thread-integration 创建）
 * 才会产生投递；无线程的工作空间（PH 等）完全不经过本控制面。
 */
export function getThreadControl() {
  if (!_defaultControl) {
    _defaultControl = createThreadControl();
  }
  return _defaultControl;
}
