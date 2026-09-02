/**
 * Capability Shell 基座类型（ticket 033）
 *
 * 每个领域 shell = 一份策略声明（动词表 + 参数约束）+ 若干 adapter 映射。
 * 边界 = 管线确定性拒绝：语法验收 → 结构分段 → 逐段动词校验 → 参数校验，
 * 任一道命中拒绝即终态。不是沙箱，无环境隔离。
 */

/** 拒绝报文稳定错误码（模型可自我纠正的契约）。 */
export type CapabilityShellErrorCode =
  | 'empty_input'
  | 'syntax_rejected'
  | 'structure_rejected'
  | 'unknown_verb'
  | 'arg_rejected'
  | 'dispatch_failed';

/** 单个管道段的解析结果（第二道检查点产物）。 */
export interface ShellSegment {
  /** 段首动词（command 名，已 trim） */
  verb: string;
  /** 段内参数（字面量，已剥引号） */
  args: string[];
}

export interface ShellRedirect {
  op: '>' | '>>' | '<';
  /** 重定向目标（文件路径字面量，重定向不允许管道） */
  target: string;
}

/** 领域 shell 策略声明：动词表 + 每-动词参数与 adapter 约束。 */
export interface CapabilityShellPolicy {
  /** shell 名（审计与报错文案用，如 'github_shell'） */
  name: string;
  /** 工具描述（注入 LLM 的工具 description） */
  description: string;
  /** 动词表：首词 → 动词声明 */
  verbs: Record<string, ShellVerbDecl>;
  /**
   * 可选：显式排除动词的结构化指引（ticket 034）。
   * 动词道对这里的键返回 unknown_verb 时，报文附加对应指引文本——
   * 用于 advance / resume 等需人工介入的操作（与技能故障表一致），
   * 让模型得到结构化指引而不是泛化的动词清单。
   */
  unknownVerbHints?: Record<string, string>;
  /**
   * 可选：该 shell 是否可并行（透传框架 Tool.parallelizable，react-loop 按
   * 工具粒度并发同批次调用）。是否声明是领域决策：副作用为线程作用域、
   * 同线程冲突由服务端结构化拒绝仲裁的派发型 shell 才声明。
   */
  parallelizable?: boolean;
}

/** 单个动词的声明：参数约束 + 分派去向。 */
export interface ShellVerbDecl {
  /** 动词一句话说明（进入 unknown_verb 报文的可用动词清单） */
  description: string;
  /** 按位置声明的参数约束；长度即期望参数个数（超缺均拒绝） */
  params: ShellParamDecl[];
  /** 可选：给模型的一句话用法提示（参数个数不符时附在报错里） */
  usage?: string;
  /**
   * 可选：尾随 flag 白名单（如 ['--no-wait']）。只在参数尾部识别，
   * 参数校验前从位置参数中剥离、不计入参数个数；未声明的 `--` 前缀
   * 参数仍按位置参数校验（防误吞指令文本中的连字符词）。adapter 收到
   * 的仍是原始参数数组（含尾部 flag），按本声明自行剥离。
   */
  flags?: string[];
  /**
   * 分派去向：
   * - 进程内函数：直接调用，args 为校验后的参数数组
   * - 文本工具：数组 spawn（每元素一个管道段；管道前段 stdout 写后段 stdin）
   */
  adapter: CapabilityAdapterRef;
}

/** adapter 键：进程内函数查 inProcess；否则视为 spawn 段命令名。 */
export type CapabilityAdapterDecl =
  | { kind: 'function'; name: string }
  | { kind: 'spawn'; argv: string[] };

/** 动词声明的 adapter 引用：键必须存在于注入的 adapter map。 */
export interface CapabilityAdapterRef {
  /** adapter map 中的键 */
  key: string;
  /** 可选：进程内 adapter 的固定 argv 前缀（拼在参数前） */
  argPrefix?: string[];
}

export type ShellParamKind = 'literal' | 'path';

export interface ShellParamDecl {
  /** 参数名（报错文案用，如 'repo'） */
  name: string;
  kind: ShellParamKind;
  /** 必填（缺省时该参数必须出现） */
  required?: boolean;
  /**
   * 尾参可变：true 时末位参数声明可重复出现，参数个数上限不再受声明个数
   * 约束（仅对末位参数有意义，如 watch <threadId> [threadId...]）。
   * 可变部分的每个值仍按末位声明的约束逐个校验。
   */
  variadic?: boolean;
  /**
   * kind=literal 的字面量白名单（枚举参数用）。
   * 未提供则只校验「是字面量」（由前道检查点保证）。
   */
  enum?: string[];
  /** kind=path 时：是否只读（< 方向）；写路径要求落在 workspace 内 */
  readOnly?: boolean;
}

/** 参数校验结果（第三道检查点产出，供分派层消费） */
export interface ValidatedSegment {
  verb: string;
  args: string[];
  decl: ShellVerbDecl;
}

/** 拒绝报文契约：稳定错误码 + 可用动词清单，模型可自我纠正。 */
export interface PipelineRejection {
  code: CapabilityShellErrorCode;
  /** 模型可读文案（含可用动词清单，可自我纠正） */
  message: string;
  /** 拒绝发生的检查点 */
  stage: 'syntax' | 'structure' | 'verb' | 'args';
  /** 命中拒绝特征的管道段序号（0-based；语法道无段号） */
  segmentIndex?: number;
}

/** 分派成功的结果 */
export interface ShellDispatchResult {
  output: string;
  /** 终止/截断等元数据（沿用 shell_metadata 契约时在 output 尾部） */
  terminated?: boolean;
}

/** 结构化审计事件（按未来 Web UI 可呈现设计；本票只落日志） */
export interface CapabilityShellAuditEvent {
  shell: string;
  /** 原始命令文本 */
  command: string;
  /** 分段结果（命中拒绝时为已解析出的段） */
  segments?: Array<{ verb: string; args: string[] }>;
  /** 逐段判定 */
  verdicts?: Array<{ segmentIndex: number; verb: string; ok: boolean; reason?: string }>;
  /** 分派去向：adapter key 或 process spawn */
  dispatch?: string;
  /** 结果摘要（截断后的输出长度 / 错误码） */
  outcome?: { ok: boolean; error?: CapabilityShellErrorCode; outputBytes?: number };
}
