/**
 * StepRotatingModel Feature - step 级模型轮转（实验性）
 *
 * 邪修省 token 实验：强模型连续跑 N 步 -> 切性价比模型跑 M 步，循环。
 * 相位以框架的 call 内 step 序号为唯一输入（每 call 天然从 0 重置，
 * 首步 = 强模型）。切换统一走 ADR-0009 官方链路：
 *
 *   ctx.agent.setModel(presetName, { thinkingEffort?, source: 'feature:step-rotating-model' })
 *
 * 纯内部管理 Feature：零工具（模型不可见不可调），控制面 =
 * getCapabilities 的 configure（slash / 进程内 Feature 调用）+ 右侧
 * 会话面板的专属 status/control 路由（宿主投影）。配置会话级，
 * 不进全局 Feature 配置。让位策略与降级重试本期均不做：setModel
 * 失败仅记 lastError，相位照常推进（ADR-0009：失败是资产层问题）。
 */

import { fileURLToPath } from 'url';
import {
  getPackageInfoFromSource,
  type AgentFeature,
  type CallStartContext,
  type CapabilityDefinition,
  type FeatureInitContext,
  type PackageInfo,
  type StepStartContext,
  type Tool,
} from '@agentdevjs/core';

const SOURCE_TAG = 'feature:step-rotating-model';

/** 跨协议思考档位词并集（面板侧按模型协议动态渲染子集；此处为 slash 表单的静态兜底） */
const EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const DEFAULTS = {
  // 默认关闭：轮转是省 token 实验，装配后需用户显式打开才生效。
  enabled: false,
  strongPreset: 'DeepSeek-V4-Pro',
  strongEffort: null as string | null,
  cheapPreset: 'DeepSeek-V4-flash',
  cheapEffort: null as string | null,
  strongSteps: 2,
  cheapSteps: 1,
};

export interface StepRotatingModelConfig {
  enabled?: boolean;
  strongPreset?: string;
  /** null = 不覆盖，跟随 preset 默认档位 */
  strongEffort?: string | null;
  cheapPreset?: string;
  cheapEffort?: string | null;
  strongSteps?: number;
  cheapSteps?: number;
}

export interface RotationSwapRecord {
  callIndex: number;
  step: number;
  slot: 'strong' | 'cheap';
  presetName: string;
  thinkingEffort: string | null;
  ok: boolean;
  error?: string;
  at: string;
}

export interface StepRotatingModelStatus {
  enabled: boolean;
  strongPreset: string;
  strongEffort: string | null;
  cheapPreset: string;
  cheapEffort: string | null;
  strongSteps: number;
  cheapSteps: number;
  /** getLLMMeta() 权威值（首次钩子触发前为 null） */
  currentPreset: string | null;
  currentThinkingEffort: string | null;
  currentProvider: string | null;
  lastCallIndex: number | null;
  lastStep: number | null;
  slotAtLastStep: 'strong' | 'cheap' | null;
  lastError: string | null;
  lastExternalSwap: { source: string; at: string } | null;
  recentSwaps: RotationSwapRecord[];
}

function clampSteps(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.max(1, Math.min(10, n));
}

function normalizeEffort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizePreset(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

export class StepRotatingModel implements AgentFeature {
  readonly name = 'step-rotating-model';
  readonly dependencies: string[] = [];
  readonly source = fileURLToPath(import.meta.url).replace(/\\/g, '/');
  readonly description =
    'Step 级模型轮转：强模型连续 N 步后切性价比模型 M 步，经 ADR-0009 官方 setModel 链路热切换，供省 token 实验。';

  static hooks = {
    onCallStart: { lifecycle: 'CallStart', kind: 'observe' as const },
    onStepStart: { lifecycle: 'StepStart', kind: 'observe' as const },
  };

  private cfg: Required<StepRotatingModelConfig>;
  private _packageInfo: PackageInfo | null = null;
  private agent: any = null;
  private logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } | null = null;
  private swapLog: RotationSwapRecord[] = [];
  private lastError: string | null = null;
  private lastExternalSwap: { source: string; at: string } | null = null;
  private lastCallIndex: number | null = null;
  private lastStep: number | null = null;

  constructor(config: StepRotatingModelConfig = {}) {
    this.cfg = {
      enabled: config.enabled ?? DEFAULTS.enabled,
      strongPreset: normalizePreset(config.strongPreset, DEFAULTS.strongPreset),
      strongEffort: normalizeEffort(config.strongEffort),
      cheapPreset: normalizePreset(config.cheapPreset, DEFAULTS.cheapPreset),
      cheapEffort: normalizeEffort(config.cheapEffort),
      strongSteps: clampSteps(config.strongSteps, DEFAULTS.strongSteps),
      cheapSteps: clampSteps(config.cheapSteps, DEFAULTS.cheapSteps),
    };
  }

  getPackageInfo(): PackageInfo | null {
    if (!this._packageInfo) {
      this._packageInfo = getPackageInfoFromSource(this.source);
    }
    return this._packageInfo;
  }

  getTemplateNames(): string[] {
    return [];
  }

  getTools(): Tool[] {
    // 纯内部管理 Feature：零工具。模型不可感知、不可干预轮转。
    return [];
  }

  async getAsyncTools(_ctx: FeatureInitContext): Promise<Tool[]> {
    return [];
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.logger = ctx.logger as unknown as StepRotatingModel['logger'];
  }

  async onDestroy(): Promise<void> {
    this.agent = null;
  }

  /** 相位槽：step0 在 [0, strongSteps) -> strong；否则 cheap。首步强。 */
  private slotForStep(step0: number): 'strong' | 'cheap' {
    const period = this.cfg.strongSteps + this.cfg.cheapSteps;
    return step0 % period < this.cfg.strongSteps ? 'strong' : 'cheap';
  }

  private getMeta(): Record<string, unknown> {
    try {
      const meta = this.agent && typeof this.agent.getLLMMeta === 'function' ? this.agent.getLLMMeta() : null;
      return (meta && typeof meta === 'object' ? meta : {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  onCallStart(_ctx: CallStartContext): void {
    // 相位重置由框架 call 内 step 序号天然完成；新 call 清理上一次的
    // 诊断错误，让面板读到干净的会话内状态。
    this.lastError = null;
  }

  onStepStart(ctx: StepStartContext): void {
    if (ctx && ctx.agent) this.agent = ctx.agent;
    this.lastCallIndex = typeof ctx?.callIndex === 'number' ? ctx.callIndex : this.lastCallIndex;
    this.lastStep = typeof ctx?.step === 'number' ? ctx.step : this.lastStep;

    if (!this.cfg.enabled) return;
    const agent = ctx && ctx.agent;
    if (!agent || typeof agent.setModel !== 'function') {
      // 自诊断：guard 命中时把 ctx.agent 的真实形状记下来，避免"resolver 未注入"
      // 与"agent 引用缺失/异构对象"两种成因混淆（面板红字 + 调试日志各留一份）。
      const diag = !agent
        ? 'ctx.agent missing'
        : 'agent=' + ((agent as any).constructor?.name || typeof agent)
          + ' setModel=' + typeof agent.setModel
          + ' setLLM=' + typeof agent.setLLM
          + ' getLLMMeta=' + typeof agent.getLLMMeta;
      this.lastError = 'agent.setModel unavailable — ' + diag;
      if (this.logger && this.logger.warn) this.logger.warn('[step-rotating-model] ' + this.lastError);
      return;
    }

    const slot = this.slotForStep(this.lastStep ?? 0);
    const presetName = slot === 'strong' ? this.cfg.strongPreset : this.cfg.cheapPreset;
    const effort = slot === 'strong' ? this.cfg.strongEffort : this.cfg.cheapEffort;

    // 幂等：已在目标态（preset 与档位均匹配权威 meta）则不重建客户端。
    const meta = this.getMeta();
    if (meta.presetName === presetName && (effort == null || meta.thinkingEffort === effort)) {
      return;
    }

    const record: RotationSwapRecord = {
      callIndex: this.lastCallIndex ?? -1,
      step: this.lastStep ?? -1,
      slot,
      presetName,
      thinkingEffort: effort,
      ok: false,
      at: new Date().toISOString(),
    };
    let ok = false;
    try {
      ok = agent.setModel(presetName, {
        ...(effort != null ? { thinkingEffort: effort } : {}),
        source: SOURCE_TAG,
      });
    } catch (error) {
      record.error = String((error as Error)?.message || error);
    }
    record.ok = ok;
    if (!ok) {
      this.lastError = record.error
        ? 'setModel threw for "' + presetName + '": ' + record.error
        : 'resolve failed for "' + presetName + '" (preset missing / credentials unavailable); rotation phase continues';
      if (this.logger && this.logger.warn) this.logger.warn('[step-rotating-model] ' + this.lastError);
    } else {
      this.lastError = null;
      if (this.logger && this.logger.info) {
        this.logger.info('[step-rotating-model] step ' + record.step + ' -> ' + slot + ' "' + presetName + '"' + (effort ? ' (effort: ' + effort + ')' : ''));
      }
    }
    this.swapLog.push(record);
    if (this.swapLog.length > 200) this.swapLog.splice(0, this.swapLog.length - 200);
  }

  /**
   * 切换观察（不做让位，本期裁决）。外部发起的切换（source 非 feature:step-rotating-model）
   * 记录为诊断事实供面板展示；轮转会在下一个 StepStart 把模型切回相位目标。
   */
  onLLMSwap(_newLLM: unknown, _oldLLM: unknown): void {
    const meta = this.getMeta();
    const source = typeof meta.source === 'string' ? meta.source : 'unknown';
    if (source !== SOURCE_TAG) {
      this.lastExternalSwap = { source, at: new Date().toISOString() };
    }
  }

  /** 部分更新配置（capability execute 与面板 control 路由共用入口）。 */
  setConfig(partial: StepRotatingModelConfig): StepRotatingModelStatus {
    const input = partial && typeof partial === 'object' ? partial : ({} as StepRotatingModelConfig);
    if (typeof input.enabled === 'boolean') this.cfg.enabled = input.enabled;
    if (input.strongPreset !== undefined) this.cfg.strongPreset = normalizePreset(input.strongPreset, this.cfg.strongPreset);
    if (input.cheapPreset !== undefined) this.cfg.cheapPreset = normalizePreset(input.cheapPreset, this.cfg.cheapPreset);
    if (input.strongEffort !== undefined) this.cfg.strongEffort = normalizeEffort(input.strongEffort);
    if (input.cheapEffort !== undefined) this.cfg.cheapEffort = normalizeEffort(input.cheapEffort);
    if (input.strongSteps !== undefined) this.cfg.strongSteps = clampSteps(input.strongSteps, this.cfg.strongSteps);
    if (input.cheapSteps !== undefined) this.cfg.cheapSteps = clampSteps(input.cheapSteps, this.cfg.cheapSteps);
    return this.getStatus();
  }

  /** 会话级实时全量状态：面板 3s 轮询消费同一份。 */
  getStatus(): StepRotatingModelStatus {
    const meta = this.getMeta();
    return {
      enabled: this.cfg.enabled,
      strongPreset: this.cfg.strongPreset,
      strongEffort: this.cfg.strongEffort,
      cheapPreset: this.cfg.cheapPreset,
      cheapEffort: this.cfg.cheapEffort,
      strongSteps: this.cfg.strongSteps,
      cheapSteps: this.cfg.cheapSteps,
      currentPreset: typeof meta.presetName === 'string' && meta.presetName ? meta.presetName : null,
      currentThinkingEffort: typeof meta.thinkingEffort === 'string' ? meta.thinkingEffort : null,
      currentProvider: typeof meta.provider === 'string' ? meta.provider : null,
      lastCallIndex: this.lastCallIndex,
      lastStep: this.lastStep,
      slotAtLastStep: this.lastStep == null ? null : this.slotForStep(this.lastStep),
      lastError: this.lastError,
      lastExternalSwap: this.lastExternalSwap,
      recentSwaps: this.swapLog.slice(-20),
    };
  }

  /**
   * Capability 控制面：同一份 configure 声明服务 slash 表单、进程内 Feature
   * 调用与右侧面板（面板走专属路由，经 claw:capability-invoked 事件同步）。
   * preset 名为 string 而非静态 select——presets 清单是活数据，面板侧对
   * strong/cheap 字段做专用动态下拉（自拉 /protoclaw/model_config），
   * 有效性由 execute 内 setModel 的运行时解析兜底。
   */
  getCapabilities(): CapabilityDefinition[] {
    const effortOptions = [
      { label: '默认（跟随 preset）', value: '' },
      ...EFFORT_VALUES.map((v) => ({ label: v, value: v })),
    ];
    return [
      {
        name: 'configure',
        title: '配置模型轮转',
        description: '调整 step 级模型轮转的开关、强/省模型 preset、思考档位与连续步数，返回调整后的完整状态。',
        parameters: {
          enabled: {
            type: 'boolean',
            title: '启用轮转',
            description: '总开关。关闭后不执行任何切换，钩子仍观察 step。',
          },
          strongPreset: {
            type: 'string',
            title: '强模型 preset',
            placeholder: 'DeepSeek-V4-Pro',
            description: '预设清单由宿主持有；右侧面板提供动态下拉。',
          },
          cheapPreset: {
            type: 'string',
            title: '性价比模型 preset',
            placeholder: 'DeepSeek-V4-flash',
            description: '承接轮转中低价值 step 的模型。',
          },
          strongEffort: {
            type: 'select',
            title: '强模型思考档位',
            description: '空 = 跟随 preset 默认。面板按模型协议动态渲染词表。',
            options: effortOptions,
          },
          cheapEffort: {
            type: 'select',
            title: '性价比模型思考档位',
            description: '空 = 跟随 preset 默认。通常选 none/minimal 压缩开销。',
            options: effortOptions,
          },
          strongSteps: {
            type: 'number',
            title: '强模型连续步数',
            min: 1,
            max: 10,
            step: 1,
            description: '一个轮转周期内强模型连续执行的 step 数。',
          },
          cheapSteps: {
            type: 'number',
            title: '性价比模型连续步数',
            min: 1,
            max: 10,
            step: 1,
            description: '一个轮转周期内性价比模型连续执行的 step 数。',
          },
        },
        entryPoints: ['slash', 'feature'],
        readCurrentValues: () => {
          const s = this.getStatus();
          return {
            enabled: s.enabled,
            strongPreset: s.strongPreset,
            cheapPreset: s.cheapPreset,
            strongEffort: s.strongEffort ?? '',
            cheapEffort: s.cheapEffort ?? '',
            strongSteps: s.strongSteps,
            cheapSteps: s.cheapSteps,
          };
        },
        execute: (args: unknown) => {
          const input = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
          return Promise.resolve(
            this.setConfig({
              ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
              ...(typeof input.strongPreset === 'string' ? { strongPreset: input.strongPreset } : {}),
              ...(typeof input.cheapPreset === 'string' ? { cheapPreset: input.cheapPreset } : {}),
              ...(input.strongEffort !== undefined ? { strongEffort: input.strongEffort as string | null } : {}),
              ...(input.cheapEffort !== undefined ? { cheapEffort: input.cheapEffort as string | null } : {}),
              ...(input.strongSteps !== undefined ? { strongSteps: input.strongSteps as number } : {}),
              ...(input.cheapSteps !== undefined ? { cheapSteps: input.cheapSteps as number } : {}),
            }),
          );
        },
      },
    ];
  }
}

export default StepRotatingModel;
