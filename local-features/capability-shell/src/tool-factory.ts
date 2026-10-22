/**
 * bash 形态工具工厂（ticket 033）
 *
 * createCapabilityShellTool(policy, adapters)：把 Bash AST 校验、解释执行与领域
 * adapter 装配成一个工具（参数为 command 脚本 + timeout，超时唯一闸门 =
 * 框架 Tool.timeout 契约）。每次调用落结构化审计事件（createLogger，
 * capability 命名空间）。
 */

import { createLogger, createTool } from '@agentdevjs/core';
import type { Tool } from '@agentdevjs/core';
import { processOutputWithPersistence } from '@agentdevjs/shell-feature';
import { BASH_SYNTAX_DESCRIPTION, parseBashProgram } from './bash-program.js';
import { executeBashProgram } from './bash-runtime.js';
import { listVerbs } from './verbs.js';
import type { AdapterMap } from './dispatch.js';
import type { CapabilityShellPolicy } from './types.js';

/** 工具工厂超时契约默认值（唯一闸门 = 框架 Tool.timeout 契约）。 */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const log = createLogger('capability');

export interface CapabilityShellToolOptions {
  /** 覆盖默认超时（缺省 120000） */
  timeoutMs?: number;
  /** 覆盖超时上限（缺省 600000） */
  maxTimeoutMs?: number;
  /** spawn 工作目录（缺省 process.cwd()） */
  workdir?: string;
}

/**
 * 创建 bash 形态的 capability shell 工具。
 *
 * @param policy 领域 shell 策略声明（动词表 + 参数约束 + adapter 映射）
 * @param adapters adapter map（注入以便测试；键 = 动词声明的 adapter key）
 */
export function createCapabilityShellTool(
  policy: CapabilityShellPolicy,
  adapters: AdapterMap = {},
  options: CapabilityShellToolOptions = {},
): Tool {
  const verbList = listVerbs(policy.verbs);
  const description = `${policy.description}\n\n可用动词：${verbList}。${BASH_SYNTAX_DESCRIPTION}`;

  return createTool({
    name: policy.name,
    description,
    // 并行性由策略声明（领域决策）；未声明时按框架默认串行
    parallelizable: policy.parallelizable === true,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: `要执行的领域 Bash 脚本。可用动词：${verbList}。`,
        },
        timeout: {
          type: 'number',
          description: '可选超时毫秒数（唯一闸门 = 框架 Tool.timeout 契约）。',
        },
      },
      required: ['command'],
    },
    render: { call: 'bash', result: 'bash' },
    // 超时唯一闸门 = 框架 Tool.timeout 契约（defaultMs/maxMs/fromArg）；
    // CLI 风格时间 flag 不进动词表。timeout 参数由框架 fromArg 读取并
    // clamp 到 [1, maxMs]；CLI 风格时间 flag 不进动词表。
    timeout: {
      defaultMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxMs: options?.maxTimeoutMs ?? MAX_TIMEOUT_MS,
      fromArg: 'timeout',
    },
    execute: async (args, context) => {
      const command = typeof args.command === 'string' ? args.command : '';
      const result = await runCapabilityShellPipeline(policy, command, {
        adapters,
        signal: context?.signal,
        workdir: options?.workdir,
        termination: context?.termination,
      });
      // 超长输出自动落盘，与 bash 工具同实现同语义（@agentdevjs/shell-feature
      // 的共享函数）：完整内容写 <workdir>/.agentdev/temp/<shell>-output-*.log，
      // 返回头尾截断版 + 落盘路径；两链路行为收拢一致，阈值 30k 字符。
      const [output] = await processOutputWithPersistence(
        result.output,
        options?.workdir ?? process.cwd(),
        undefined,
        false,
        `${policy.name}-output`,
      );
      return output;
    },
  });
}

/** 管线执行结果（工具 execute 返回值）。 */
export interface CapabilityShellRunResult {
  ok: boolean;
  /** 成功：最后一段 stdout；拒绝/失败：模型可读拒绝文案 */
  output: string;
  commands?: import('./dispatch.js').CommandExecution[];
  /** 拒绝报文契约：稳定错误码 + 阶段（拒绝时存在） */
  rejection?: {
    code: 'syntax_rejected' | 'structure_rejected' | 'unknown_verb' | 'arg_rejected' | 'dispatch_failed';
    stage: 'syntax' | 'structure' | 'verb' | 'args' | 'dispatch';
    message: string;
    segmentIndex?: number;
  };
}

/** help 输出：从策略声明生成动词表用法（usage + description 逐动词列出）。 */
export function formatShellHelp(policy: CapabilityShellPolicy): string {
  const verbs = Object.keys(policy.verbs).sort();
  return [
    `${policy.name} — ${policy.description}`,
    '',
    `可用动词（${verbs.length} 个）：`,
    ...verbs.map((verb) => {
      const decl = policy.verbs[verb];
      return `  ${decl.usage || verb}  — ${decl.description}`;
    }),
    '',
    BASH_SYNTAX_DESCRIPTION,
    '详细用法与调度纪律：invoke_skill 激活对应领域技能。',
  ].join('\n');
}

/**
 * 完整管线：Bash AST → 完整命令入口/静态参数校验 → 解释执行 → 展开后参数校验。
 * 不把未校验的脚本交给系统 shell，也不降级到旧字面量解析器。
 */
export async function runCapabilityShellPipeline(
  policy: CapabilityShellPolicy,
  command: string,
  options: {
    adapters?: AdapterMap;
    signal?: AbortSignal;
    workdir?: string;
    /** 框架终止原因查询（timeout / user / null），透传给进程内 adapter（ticket 034） */
    termination?: () => 'timeout' | 'user' | null;
  } = {},
): Promise<CapabilityShellRunResult> {
  const program = parseBashProgram(command, policy);
  if ('code' in program) {
    log.warn('capability shell rejected', { shell: policy.name, command, ...program });
    return { ok: false, output: `${program.message} 可用动词：${listVerbs(policy.verbs)}。`, rejection: program };
  }
  if (command.trim() === 'help') return { ok: true, output: formatShellHelp(policy) };
  const result = await executeBashProgram(policy, program, { ...options, help: formatShellHelp(policy) }, command);
  log.info('capability shell dispatch', { shell: policy.name, command,
    commands: result.commands, outcome: { ok: result.ok, outputBytes: Buffer.byteLength(result.output) } });
  return result;
}
