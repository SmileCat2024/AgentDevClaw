/**
 * plugin-manifest.js — APP 前端插件清单
 *
 * 宿主需要知道「哪个 APP 的界面在哪个模块里，才能按需装载」。插件文件本身
 * 无法在被加载之前声明自己，所以清单必须由宿主侧持有。
 *
 * 新增 APP 前端插件时在此登记一行；agentId 与 metadata.json 的 id 一致。
 *
 * ESM 迁移状态（P4 T3 批次）：**已转 ESM**，原 classic 标签删除。
 * 时序审计（R1–R4 + S）：本文件是纯声明（一张清单 + 一个纯解析函数），顶层
 * 无 DOM 查询、无事件注册、无网络、无状态写入——加载相 → 模块求值相不改变
 * 任何可观测行为；无 sloppy 依赖（无隐式全局、无 with、无顶层 this）。
 *
 * 桥键（domain `plugin-manifest`，注册相位 = 模块求值相）：
 *   - `resolveAgentPlugin` ← app-ui.js（classic）：`window.resolveAgentPlugin?.(agent.id)`
 *     与 `ClawHost.setPluginResolver(...)` 的闭包体。两处都是渲染 / 插件装载
 *     回调里的运行时调用，晚于模块求值，无 classic 相触达点。
 *   注销条件：app-ui 迁 ESM 并改具名 import 后注销本桥键。
 *
 * `ClawPluginManifest` 生产零外部读者（清单只经 resolveAgentPlugin 解析），
 * 按配方步 2 收敛为模块私有：不导出、不上桥。
 */

const ClawPluginManifest = {
  // url 相对站点根解析（不是相对某个模块文件），避免随调用点漂移
  memo: { id: 'memo', url: '/src/plugins/memo/index.js' },
  'claw-guide': { id: 'claw-guide', url: '/src/plugins/claw-guide/guide-docset.js' },
  'agent-studio': { id: 'agent-studio', url: '/src/plugins/agent-studio/index.js' },
  coder: { id: 'coder', url: '/src/plugins/coder/index.js' },
};

/** 返回该 agent 需要的插件描述，没有则返回 null。 */
export function resolveAgentPlugin(agentId) {
  const key = String(agentId || '');
  const entry = ClawPluginManifest[key];
  if (!entry) return null;
  return typeof entry === 'string' ? { id: key, url: entry } : { id: entry.id || key, url: entry.url };
}

const bridged = { resolveAgentPlugin };
window.KernelState.defineKey('plugin-manifest', 'resolveAgentPlugin', bridged.resolveAgentPlugin);
window.KernelState.claim('plugin-manifest', {
  get: (key) => bridged[key],
  set: (key, value) => { bridged[key] = value; },
});
