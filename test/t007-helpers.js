/**
 * T007 回归测试共享夹具
 *
 * 三个回归测试文件（successor 身份继承 / 重启恢复 / coder 真实装配链）
 * 共用的环境构建与断言辅助。不承载场景语义——场景断言在各测试文件内。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WorkThreadRuntimeBridge } from '@agentdevjs/core';

import { createThreadControl } from '../server/thread-control/thread-controller.js';
import { createThreadIntegration } from '../server/thread-control/thread-integration.js';

/**
 * 构建一个独立的线程控制面环境（真实 WorkThread + ThreadStore + Board）。
 *
 * @param {object} options
 * @param {string} options.baseDir 共享临时根（调用方负责清理）
 * @param {string} options.suffix 环境名（用于子目录隔离）
 * @param {object} [options.bridgeOptions] WorkThreadRuntimeBridge 选项
 * @returns {{
 *   root: string,
 *   identity: { register: Function, identitySource: Function },
 *   control: object,
 *   core: object,
 *   board: object,
 *   archive: object,
 *   integration: object,
 *   cleanup: Function,
 * }}
 */
export function makeThreadEnv({ baseDir, suffix, bridgeOptions } = {}) {
  const root = path.join(baseDir, suffix);
  const sessions = new Map();
  const identity = {
    register(sessionId, identityValue) { sessions.set(String(sessionId), identityValue); },
    unregister(sessionId) { sessions.delete(String(sessionId)); },
    identitySource: async (_agentId, sessionId) => {
      const id = String(sessionId || '').trim();
      if (!id) return null;
      const value = sessions.get(id);
      return value === undefined ? null : value;
    },
  };
  const control = createThreadControl({
    rootDir: root,
    bridge: new WorkThreadRuntimeBridge(bridgeOptions || { enabled: false }),
    identitySource: identity.identitySource,
  });
  const integration = createThreadIntegration({ control });
  return {
    root,
    identity,
    control,
    core: control.core,
    board: control.board,
    archive: control.archive,
    integration,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 启动一个 coder 根线程（身份注册 + core.start）。 */
export async function startCoderThread(env, rootSessionId = 's1') {
  env.identity.register(rootSessionId, 'coder');
  return env.core.start({ sessionRef: { agentId: 'programming-helper', sessionId: rootSessionId } });
}

export function makeBaseDir(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}
