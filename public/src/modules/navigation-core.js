/**
 * navigation-core.js — 会话导航事务核心原语（ADR-0014 Phase 1）
 *
 * 统一"等待 runtime 就绪"的散装实现。存量四种形态的收敛：
 *   - waitForTargetRuntimeSession（sidebar-render.js）→ 委托本模块，行为不变
 *   - ctx-menu-handlers restart 手写 20×500ms 全量轮询 → 已删除，与通用菜单
 *     ctxRestartAgent 对齐（restart_agent 响应已含服务端就绪等待结果）
 *   - RemoteConnections.waitForRuntimeForSession → 保留（远程目录缓存查询），
 *     新代码经 waitForRemoteRuntimeRef 调用
 *   - waitForPrebuiltRuntimeSession（sidebar-render.js）→ Phase 2 收编候选
 *     （start_agent 响应已含 agent 与 status.selectedSessionId）
 *
 * waitForRuntimeReady 走轻量 runtime_status 端点（per agentId+sessionId，不随
 * 会话总量放大），ready 判定与 switchAgent 前的全量列表扫描同源：runtime
 * ready + 进程存活 + viewer connected。
 *
 * 后续 Phase 将在此模块上叠加 NavigationHandle 事务对象（beginNavigation）。
 *
 * 依赖（全局，由先序脚本或宿主环境提供）：fetch、window。
 */
window.NavigationCore = (() => {
  /**
   * 轮询轻量 runtime_status 端点直到目标 runtime 就绪。
   *
   * @param {object} options
   * @param {string} options.agentId 宿主 agent id
   * @param {string} options.sessionId 目标会话 id
   * @param {string} [options.expectRuntimeId] 要求就绪的 runtime 恰为该 id
   *   （restart 场景：绑定该会话的还是旧 runtime 时继续等待）
   * @param {string} [options.excludeRuntimeId] 排除的 runtime id（语义与
   *   expectRuntimeId 互补，二者给其一即可）
   * @param {number} [options.attempts=50] 轮询次数上限
   * @param {number} [options.intervalMs=200] 轮询间隔
   * @param {string} [options.operationId] 透传服务端诊断事件的操作 id
   * @returns {Promise<object|null>} 就绪的 agent 条目；超时返回 null
   * @throws {Error} code='target_runtime_stopped' — runtime 在就绪前停止/消失。
   *   这是终态信号而非传输错误：继续轮询没有意义，调用方应中止导航。
   */
  async function waitForRuntimeReady(options) {
    const {
      agentId,
      sessionId,
      expectRuntimeId = '',
      excludeRuntimeId = '',
      attempts = 50,
      intervalMs = 200,
      operationId = '',
    } = options || {};
    const expect = String(expectRuntimeId || '').trim();
    const exclude = String(excludeRuntimeId || '').trim();
    if (!agentId || !sessionId) {
      throw new Error('waitForRuntimeReady requires agentId and sessionId');
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const params = new URLSearchParams({ agentId, sessionId });
        if (operationId) params.set('operationId', operationId);
        const response = await fetch('/protoclaw/runtime_status?' + params.toString());
        if (response.ok) {
          const result = await response.json();
          if (result?.ready === true && result?.agent) {
            const runtimeId = String(
              result.agent.runtime_session_id || result.agent.id || '',
            ).trim();
            if (exclude && runtimeId === exclude) {
              // 绑定该会话的仍是旧 runtime（restart 未换代），继续等待。
            } else if (expect && runtimeId !== expect) {
              // 绑定该会话的不是期望的新 runtime，继续等待。
            } else {
              return result.agent;
            }
          } else if (result?.lifecycle === 'stopped' || result?.lifecycle === 'missing') {
            const error = new Error(
              `Runtime ${result.lifecycle} before becoming ready: ${agentId}/${sessionId}`,
            );
            error.code = 'target_runtime_stopped';
            throw error;
          }
        }
      } catch (error) {
        if (error?.code === 'target_runtime_stopped') throw error;
        // 轮询传输错误既不是会话失败也不是启动失败，静默重试。
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  }

  /**
   * 等待远程目录投影出目标会话的 runtime（ADR-0011/0012 远程写链路的就绪
   * 观察）。远程 catalog 由 RemoteConnections 周期刷新，此处是本地缓存查询
   * 轮询，不打网络。超时返回 null——目录未及时出现交给 catalog 轮询自然
   * 带出，不构成失败。
   */
  async function waitForRemoteRuntimeRef(namespacedSessionId, attempts = 50) {
    if (typeof window.RemoteConnections?.waitForRuntimeForSession === 'function') {
      return window.RemoteConnections.waitForRuntimeForSession(namespacedSessionId, attempts);
    }
    return null;
  }

  return { waitForRuntimeReady, waitForRemoteRuntimeRef };
})();
