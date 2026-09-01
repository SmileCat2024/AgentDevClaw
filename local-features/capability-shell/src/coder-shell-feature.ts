/**
 * CapabilityShellFeature — coder 领域 shell 挂载（ticket 034）
 *
 * 在 033 基座（管线四道检查点 + 工具工厂）上装配第一个领域 shell：
 * ProgrammingHelperAgent（main 身份）构造函数挂载，提供 `coder_shell`
 * 工具。CoderAgent 不挂（不自派工单，避免递归调度）。
 *
 * serverOrigin 解析参照 local-features/dispatch 的 runtimeIdentity 模式：
 * 显式配置 → PROTOCLAW_SERVER_ORIGIN → http://127.0.0.1:1420。
 */

import { fileURLToPath } from 'url';
import type { AgentFeature, Tool } from '@agentdevjs/core';
import { createCapabilityShellTool } from './tool-factory.js';
import { createThreadsAdapters } from './coder-shell.js';
import { createCoderShellPolicy } from './coder-policy.js';

const __filename = fileURLToPath(import.meta.url);

export interface CapabilityShellFeatureConfig {
  /** 调度控制面 origin（缺省 runtime env → http://127.0.0.1:1420） */
  serverOrigin?: string;
  /** 覆盖工具默认超时（毫秒；超时唯一闸门 = Tool.timeout 契约） */
  timeoutMs?: number;
  /** 覆盖超时上限（缺省 600000） */
  maxTimeoutMs?: number;
}

export class CapabilityShellFeature implements AgentFeature {
  readonly name = 'claw-coder-dispatch';
  readonly source = __filename.replace(/\\/g, '/');
  readonly description = 'Claw coder 智能体调度：经受控命令管线创建 WorkThread、派发工单、监视落定与收口（coder_shell 工具）';

  private readonly serverOrigin: string;
  private readonly options: { timeoutMs?: number; maxTimeoutMs?: number };

  constructor(config: { serverOrigin?: string; timeoutMs?: number; maxTimeoutMs?: number } = {}) {
    this.serverOrigin = config.serverOrigin
      || process.env.PROTOCLAW_SERVER_ORIGIN
      || 'http://127.0.0.1:1420';
    this.options = {
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.maxTimeoutMs !== undefined ? { maxTimeoutMs: config.maxTimeoutMs } : {}),
    };
  }

  getTools() {
    // adapter key 为 threads:<verb>（033 分派层传参不含动词，动词经 key 绑定）
    const adapters = createThreadsAdapters({ serverOrigin: this.serverOrigin });
    return [
      createCapabilityShellTool(
        createCoderShellPolicy(),
        adapters,
        // send 阻塞等落定，默认窗口给足（上限 10 分钟，与框架 clamp 对齐）
        {
          bashPath: null,
          timeoutMs: this.options.timeoutMs ?? 600_000,
          maxTimeoutMs: this.options.maxTimeoutMs ?? 600_000,
        },
      ),
    ];
  }
}
