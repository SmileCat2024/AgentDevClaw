/**
 * plugin-server-bus.js — 数据面重建信号桥（ADR-0045 P2 / ADR-0046）
 *
 * 数据面（/protoclaw/plugin/<prefix>/*）按装配事实挂载，catalog 与 $mount
 * 声明的任何变化都可能改变挂载集合。变更点（导入、删除、安装、层编辑）分散
 * 在各路由模块，而 remount 能力（app 引用）在 server.js 主流程——本模块是
 * 两者之间的进程内解耦桥：
 *
 *   - 变更方：notifyPluginServerDirty(reason) —— 成功路径上广播"数据面可能
 *     过期"。fire-and-forget，不阻塞路由响应。
 *   - 宿主：onPluginServerDirty(fn) —— server.js 注册自动 remount（串行链，
 *     防并发 remount 竞态）；返回退订函数。
 *
 * 零依赖（node:events），不导入 plugin-server 本体——feature-config.js 与
 * plugin-server.js 互为导入（resolveScopeConfig），桥放 plugin-server 会成环。
 * remount 幂等且毫秒级，重复/多余的 notify 无行为副作用。
 */

import { EventEmitter } from 'events';

const bus = new EventEmitter();

/** 数据面可能过期：装配/导入/删除/层编辑成功路径上调用。reason 仅用于日志。 */
export function notifyPluginServerDirty(reason) {
  bus.emit('dirty', String(reason || 'unknown'));
}

/** 注册数据面变更监听（宿主 remount 接线）。返回退订函数。 */
export function onPluginServerDirty(fn) {
  bus.on('dirty', fn);
  return () => bus.off('dirty', fn);
}
