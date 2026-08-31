/**
 * bash 形态工具工厂（ticket 033）
 *
 * createCapabilityShellTool(policy, adapters)：把「管线四道检查点 + 分派」
 * 装配成一个 bash 形态工具（参数为 command 字符串 + timeout，超时唯一闸门 =
 * 框架 Tool.timeout 契约）。每次调用落结构化审计事件（createLogger，
 * capability 命名空间）。
 */

import { createLogger, createTool } from '@agentdevjs/core';
import type { Tool } from '@agentdevjs/core';
import { checkSyntax, findBashPath } from './syntax.js';
import { checkStructure } from './structure.js';
import { checkVerbs, listVerbs } from './verbs.js';
import { checkArgs } from './args.js';
import { dispatchPipeline } from './dispatch.js';
import type {
  AdapterMap,
  DispatchSegment,
} from './dispatch.js';
import type {
  CapabilityShellAuditEvent,
  CapabilityShellPolicy,
  ShellSegment,
} from './types.js';

/** 工具工厂超时契约默认值（唯一闸门 = 框架 Tool.timeout 契约）。 */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const log = createLogger('capability');

export interface CapabilityShellToolOptions {
  /** 覆盖默认超时（缺省 120000） */
  timeoutMs?: number;
  /** 覆盖超时上限（缺省 600000） */
  maxTimeoutMs?: number;
  /** 覆盖 bash 路径探测（缺省经 findBashPath 自动探测；null 强制降级模式） */
  bashPath?: string | null;
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
  const description = `${policy.description}\n\n可用动词：${verbList}。` +
    'v1 语法白名单：字面量参数 + 管道 | + 重定向 > >> <；' +
    '命令替换、变量、进程替换、glob、heredoc、后台一律拒绝。';

  return createTool({
    name: policy.name,
    description,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: `要执行的管道命令。可用动词：${verbList}。`,
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
    // CLI 风格时间 flag 不进动词表
    timeout: {
      defaultMs: 120_000,
      maxMs: 600_000,
    },
    execute: async (args, context) => {
      const command = typeof args.command === 'string' ? args.command : '';
      const result = await runCapabilityShellPipeline(policy, command, {
        adapters,
        signal: context?.signal,
        workdir: options?.workdir,
        bashPath: options?.bashPath,
      });
      return result.output;
    },
  });
}

/** 管线执行结果（工具 execute 返回值）。 */
export interface CapabilityShellRunResult {
  ok: boolean;
  /** 成功：最后一段 stdout；拒绝/失败：模型可读拒绝文案 */
  output: string;
  /** 拒绝报文契约：稳定错误码 + 阶段（拒绝时存在） */
  rejection?: {
    code: 'syntax_rejected' | 'structure_rejected' | 'unknown_verb' | 'arg_rejected' | 'dispatch_failed';
    stage: 'syntax' | 'structure' | 'verb' | 'args' | 'dispatch';
    message: string;
    segmentIndex?: number;
  };
}

/**
 * 完整管线：语法验收 → 结构分段 → 逐段动词校验 → 参数校验 → 分派。
 * 任一道命中拒绝即终态（PipelineRejection），不静默降级。
 */
export async function runCapabilityShellPipeline(
  policy: CapabilityShellPolicy,
  command: string,
  options: {
    adapters?: AdapterMap;
    signal?: AbortSignal;
    workdir?: string;
    bashPath?: string | null;
  } = {},
): Promise<CapabilityShellRunResult> {
  const audit: CapabilityShellAuditEvent = {
    shell: policy.name,
    command,
  };

  // 第一道：语法验收（bash -n；bash 缺失时降级并记录）
  const bashPath = options.bashPath !== undefined
    ? options.bashPath
    : await findBashPath();
  const syntax = await checkSyntax(command, { bashPath: bashPath ?? null });
  if (!syntax.ok) {
    log.warn('capability shell syntax rejected', {
      shell: policy.name,
      command,
      stderr: syntax.stderr,
      degraded: syntax.degraded,
    });
    return {
      ok: false,
      output: `syntax_rejected：命令未通过 bash 语法检查。${syntax.stderr ?? ''}\n` +
        `可用动词：${listVerbs(policy.verbs)}。`,
      rejection: {
        code: 'syntax_rejected',
        stage: 'syntax',
        message: syntax.stderr ?? 'bash -n failed',
      },
    };
  }

  // 第二道：结构分段 + v1 拒绝特征
  const structure = checkStructure(command);
  if (!structure.ok) {
    log.warn('capability shell structure rejected', {
      shell: policy.name,
      command,
      message: structure.message,
      segmentIndex: structure.segmentIndex,
    });
    return {
      ok: false,
      output: `${structure.message} 可用动词（${policy.name}）：${listVerbs(policy.verbs)}。`,
      rejection: {
        code: 'structure_rejected',
        stage: 'structure',
        message: structure.message ?? '',
        segmentIndex: structure.segmentIndex,
      },
    };
  }

  const segments = structure.segments ?? [];

  // 第三道：逐段动词校验
  const verbResult = checkVerbs(policy.name, segments, policy.verbs);
  if (!verbResult.ok) {
    log.warn('capability shell unknown verb', {
      shell: policy.name,
      command,
      segmentIndex: verbResult.segmentIndex,
      verb: verbResult.verb,
    });
    return {
      ok: false,
      output: verbResult.message ?? 'unknown verb',
      rejection: {
        code: 'unknown_verb',
        stage: 'verb',
        message: verbResult.message ?? '',
        segmentIndex: verbResult.segmentIndex,
      },
    };
  }

  // 第四道：参数校验
  const argResult = checkArgs(segments, policy.verbs);
  if (!argResult.ok) {
    log.warn('capability shell arg rejected', {
      shell: policy.name,
      command,
      segmentIndex: argResult.segmentIndex,
    });
    return {
      ok: false,
      output: argResult.message ?? 'arg rejected',
      rejection: {
        code: 'arg_rejected',
        stage: 'args',
        message: argResult.message ?? '',
        segmentIndex: argResult.segmentIndex,
      },
    };
  }

  // 分派：段声明的 adapter key → 进程内函数 or spawn
  const adapterMap = options.adapters ?? {};
  const dispatchSegments: DispatchSegment[] = segments.map((seg) => {
    const decl = policy.verbs[seg.verb];
    return {
      verb: seg.verb,
      args: seg.args,
      adapterKey: decl.adapter.key,
      kind: decl.adapter.key in adapterMap ? 'function' : 'spawn',
    };
  });

  const dispatch = await dispatchPipeline(dispatchSegments, {
    adapters: options.adapters,
    signal: options.signal,
    workdir: options.workdir,
  });

  // 审计事件（capability 命名空间；本票只落日志）
  log.info('capability shell dispatch', {
    shell: policy.name,
    command,
    segments: segments.map(s => ({ verb: s.verb, args: s.args })),
    dispatch: policy.name,
    outcome: dispatch.ok
      ? { ok: true, outputBytes: Buffer.byteLength(dispatch.output ?? '', 'utf-8') }
      : { ok: false, error: 'dispatch_failed' },
  } satisfies CapabilityShellAuditEvent);

  return dispatch.ok
    ? { ok: true, output: dispatch.output ?? '' }
    : {
        ok: false,
        output: dispatch.message ?? 'dispatch failed',
        rejection: {
          code: 'dispatch_failed',
          stage: 'dispatch',
          message: dispatch.message ?? 'dispatch failed',
        },
      };
}
