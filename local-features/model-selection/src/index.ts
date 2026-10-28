/**
 * ModelSelectionFeature — 会话模型选择（ADR-0034）
 *
 * 持有"用户明确的模型选择意图"与会话级恢复策略：
 * - 状态即选择：presetName（null = 无覆盖，遵循启动配置）+ thinkingEffort
 *   （键缺席 = 未覆盖，跟随 preset 配置档；不引入"显式 null"会话态——
 *   厂商默认档经编辑 preset 配置表达，见实施方案 §7）；
 * - 持久化完全交给框架会话快照（captureState / restoreState），
 *   不自建文件存储；trim / summary / rotate 接续经 declareContinuity
 *   随 SuccessorSeed 流转（源为接续前最新选择）；
 * - 恢复行为按 RestoreOrigin 区分（ADR-0034 决策 2 链级当前状态原则）：
 *   rollback 忽略快照中的选择（保留当前值），session-revive /
 *   continuity-import / branch-import / hot-reload 应用快照选择；
 * - 恢复失败（preset 解析失败）回退全局默认（'__default__'），原选择保留
 *   在状态里、下次实例恢复时再次尝试；双败抛错（宿主 READY 门禁据此不
 *   放行）；
 * - 应用流程幂等（onInitiate / restoreState 双钩子都触发 applyPendingChoice），
 *   覆盖两类时序：常规恢复（onInitiate 先于 restoreState）与热重载
 *   （restoreState 先于 onInitiate，此时选择暂存为 pendingChoice）。
 *
 * 通信走 ADR-0018 feature-comms 通道（前端输入框模型切换控件的唯一链路）：
 * - onHostRequest 请求面：getStatus / selectModel / clearThinkingOverride /
 *   refresh-credentials（凭证刷新，ADR-0028 修订一编排收编：同 preset 重
 *   resolve 换新实例，选择状态不动——凭证轮换是实例轮换，不是用户改选）；
 * - 事件面：选择变化与恢复失败事实尽力广播（呈现以 Agent 实际模型
 *   getLLMMeta 为准，本 feature 不自算"当前模型"）。
 *
 * 模型控制面来自 FeatureInitContext.modelControl（框架 ADR-0034 契约）；
 * 不持有凭证、LLM 客户端、整份 preset 表——资产留在宿主注入的 resolver。
 */

import type { AgentFeature, FeatureInitContext, PackageInfo, RestoreContext, FeatureModelControl, LLMMeta } from '@agentdevjs/core';
import { getPackageInfoFromSource } from '@agentdevjs/core';
import { fileURLToPath } from 'url';
import { FeatureCommunicationClient } from '../../shared/src/feature-communication.js';
import { declareContinuity } from '../../continuity-participant/src/index.js';

/** 用户选择：presetName 两态 + thinkingEffort 键缺席/显式值两态。 */
export interface ModelChoice {
  /** null = 无覆盖（遵循启动配置） */
  presetName: string | null;
  /** 键缺席 = 未覆盖（跟随 preset 配置档）；string = 显式覆盖。不使用 null 态。 */
  thinkingEffort?: string;
}

/** captureState / restoreState 流转的状态形状。 */
export interface ModelSelectionState {
  schemaVersion: 1;
  presetName: string | null;
  thinkingEffort?: string;
  /** 恢复失败事实（呈现用；不影响再次尝试）。 */
  lastRestoreFailure?: { reason: string; at: number };
}

export interface ModelSelectionConfig {
  agentId: string;
  sessionId: string;
  serverOrigin: string;
  /** 通道标题/描述（默认中文，宿主可覆盖）。 */
  title?: string;
  description?: string;
  /** 测试注入：替换内置通道 client。 */
  client?: SelectionChannelClient;
}

/** 通道 client 最小面（FeatureCommunicationClient 的结构性子集，测试可注入）。 */
export interface SelectionChannelClient {
  declareChannel(meta: { title?: string; description?: string }): Promise<unknown>;
  publishEvent(eventType: string, data: unknown): Promise<unknown>;
}

/** 全局默认 preset 名（Claw 宿主 resolver 的保留名）。 */
const DEFAULT_PRESET_NAME = '__default__';
/** 恢复来源标记（写入 setModel source，供 meta 让位策略区分）。 */
const RESTORE_SOURCE = 'model-selection:restore';
const FALLBACK_SOURCE = 'model-selection:fallback';

/** 从任意快照 JSON 防御性提取状态；完全不合法返回 null（restoreState 无操作）。 */
function normalizeState(snapshot: unknown): ModelSelectionState | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const raw = snapshot as Record<string, unknown>;
  const rawPreset = raw.presetName;
  // 非严格模式（local-features tsconfig 约定）下守卫收窄不可靠，以显式断言落地。
  if (rawPreset !== null && typeof rawPreset !== 'string') return null;
  const state: ModelSelectionState = {
    schemaVersion: 1,
    presetName: rawPreset as string | null,
  };
  if (typeof raw.thinkingEffort === 'string') state.thinkingEffort = raw.thinkingEffort;
  if (raw.lastRestoreFailure && typeof raw.lastRestoreFailure === 'object') {
    const failure = raw.lastRestoreFailure as { reason?: unknown; at?: unknown };
    if (typeof failure.reason === 'string' && typeof failure.at === 'number') {
      state.lastRestoreFailure = { reason: failure.reason, at: failure.at };
    }
  }
  return state;
}

export class ModelSelectionFeatureInner implements AgentFeature {
  readonly name = 'model-selection';
  readonly source = fileURLToPath(import.meta.url);

  private readonly client: SelectionChannelClient;
  private readonly channelTitle: string;
  private readonly channelDescription: string;
  private declared = false;

  /** 当前选择（内存真值；captureState 时落快照）。 */
  private choice: ModelChoice = { presetName: null };
  private lastRestoreFailure?: { reason: string; at: number };
  /** 恢复到的选择，等 modelControl 到位后应用（热重载顺序：restore 先于 onInitiate）。 */
  private pendingChoice: ModelChoice | null = null;
  private modelControl?: FeatureModelControl;

  constructor(config: ModelSelectionConfig) {
    this.channelTitle = config.title || '模型选择';
    this.channelDescription = config.description || '会话级模型选择与思考档位（输入框切换控件的后端）';
    this.client = config.client
      ?? new FeatureCommunicationClient(config.serverOrigin, {
        agentId: config.agentId,
        sessionId: config.sessionId,
        // featureId 必须等于 feature name：IPC 分发按 agent.features.get(featureId) 查实例。
        featureId: this.name,
        channelId: 'selection',
      });
  }

  getPackageInfo(): PackageInfo | null {
    return getPackageInfoFromSource(this.source);
  }

  async onInitiate(ctx: FeatureInitContext): Promise<void> {
    this.modelControl = ctx.modelControl;
    // 通道声明（前端控件可用性 = 声明事实；未装配/未起 runtime 时无声明即降级）。
    if (!this.declared) await this.declare();
    // 常规恢复时序：restoreState 可能先于本钩子触发过（loadSession 在
    // ensureFeatureTools 后执行，但热重载等路径顺序相反）——统一走幂等应用。
    this.applyPendingChoice();
  }

  /** LLM 实际变更时（不分来源）广播通道快照；呈现以 Agent 实际模型为准。 */
  onLLMSwap(): void {
    void this.publishSnapshot();
  }

  captureState(): ModelSelectionState {
    const state: ModelSelectionState = {
      schemaVersion: 1,
      presetName: this.choice.presetName,
    };
    if (this.choice.thinkingEffort !== undefined) state.thinkingEffort = this.choice.thinkingEffort;
    if (this.lastRestoreFailure) state.lastRestoreFailure = { ...this.lastRestoreFailure };
    return state;
  }

  /**
   * 按 origin 区分恢复行为（ADR-0034 决策 2 链级当前状态原则）：
   * - rollback：忽略快照中的选择（保留当前值），lastRestoreFailure 正常恢复；
   * - 其余（含旧调用方无 ctx）：快照选择入账，待 modelControl 应用。
   */
  async restoreState(snapshot: unknown, ctx?: RestoreContext): Promise<void> {
    const incoming = normalizeState(snapshot);
    if (!incoming) return;
    if (incoming.lastRestoreFailure) {
      this.lastRestoreFailure = { ...incoming.lastRestoreFailure };
    } else {
      this.lastRestoreFailure = undefined;
    }
    if (ctx?.origin.kind === 'rollback') return;
    this.choice = {
      presetName: incoming.presetName,
      ...(incoming.thinkingEffort !== undefined ? { thinkingEffort: incoming.thinkingEffort } : {}),
    };
    this.pendingChoice = { ...this.choice };
    this.applyPendingChoice();
  }

  /** 输入框控件请求面（server /protoclaw/feature-comms/request → runtime IPC → 此处）。 */
  async onHostRequest(requestType: string, payload: unknown): Promise<Record<string, unknown>> {
    const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    switch (requestType) {
      case 'getStatus':
        return { ok: true, choice: { ...this.choice }, ...(this.lastRestoreFailure ? { lastRestoreFailure: { ...this.lastRestoreFailure } } : {}) };
      case 'selectModel':
        return this.selectModel(body);
      case 'clearThinkingOverride':
        return this.clearThinkingOverride();
      case 'refresh-credentials':
        return this.refreshCredentials();
      default:
        return { ok: false, code: 'operation_unavailable', error: `Unknown requestType: ${requestType}` };
    }
  }

  // ========== 内部 ==========

  private selectModel(body: Record<string, unknown>): Record<string, unknown> {
    const presetName = body.presetName;
    if (typeof presetName !== 'string' || !presetName.trim()) {
      return { ok: false, code: 'invalid_payload', error: 'presetName must be a non-empty string' };
    }
    // 两态契约（实施方案 §7）：载荷不使用 null；键缺席 = 不动档位。
    let effort: string | undefined;
    if ('thinkingEffort' in body) {
      if (typeof body.thinkingEffort !== 'string' || !body.thinkingEffort.trim()) {
        return { ok: false, code: 'invalid_payload', error: 'thinkingEffort must be a non-empty string when present (use clearThinkingOverride to drop the override)' };
      }
      effort = body.thinkingEffort;
    }
    const mc = this.modelControl;
    if (!mc) {
      return { ok: false, code: 'model_control_unavailable', error: 'model control not initialized' };
    }
    const ok = mc.setModel(presetName, {
      ...(effort !== undefined ? { thinkingEffort: effort } : {}),
      source: 'user',
    });
    if (!ok) {
      // 解析失败：模型未变，choice 不变（ADR-0034 决策 3）。
      return { ok: false, code: 'preset_resolve_failed', error: `preset "${presetName}" could not be resolved` };
    }
    this.choice = { presetName, ...(effort !== undefined ? { thinkingEffort: effort } : this.choice.thinkingEffort !== undefined ? { thinkingEffort: this.choice.thinkingEffort } : {}) };
    void this.publishSnapshot();
    return { ok: true, meta: mc.getLLMMeta() };
  }

  private clearThinkingOverride(): Record<string, unknown> {
    const mc = this.modelControl;
    if (!mc) {
      return { ok: false, code: 'model_control_unavailable', error: 'model control not initialized' };
    }
    const { thinkingEffort, ...rest } = this.choice;
    if (thinkingEffort !== undefined) {
      // 回 preset 配置档：以当前 preset 重 resolve 且不携带覆盖。
      const presetName = this.choice.presetName ?? mc.getLLMMeta().presetName;
      if (!presetName) {
        return { ok: false, code: 'no_preset_anchor', error: 'no presetName to re-resolve without override' };
      }
      const ok = mc.setModel(presetName, { source: 'user' });
      if (!ok) {
        return { ok: false, code: 'preset_resolve_failed', error: `preset "${presetName}" could not be re-resolved` };
      }
      this.choice = rest;
    }
    void this.publishSnapshot();
    return { ok: true, meta: mc.getLLMMeta() };
  }

  /**
   * 幂等应用待恢复的选择（onInitiate / restoreState 双触发）。
   * 无覆盖时无操作；有覆盖时经 modelControl 应用；失败回退全局默认，
   * 双败抛错（宿主 READY 门禁据此不放行，ADR-0034 决策 5）。
   */
  private applyPendingChoice(): void {
    if (!this.modelControl) return; // 热重载顺序：restore 先到，等 onInitiate
    const choice = this.pendingChoice;
    if (!choice) return;
    this.pendingChoice = null;

    if (choice.presetName === null && choice.thinkingEffort === undefined) {
      // 无覆盖：启动配置即用户意图，无需动作。
      void this.publishSnapshot();
      return;
    }

    const mc = this.modelControl;
    // presetName 为 null 但带档位覆盖：以当前 preset 锚定重 resolve。
    const presetName = choice.presetName ?? mc.getLLMMeta().presetName;
    if (!presetName) {
      // 无 preset 锚点（如宿主以裸 setLLM 构造）：档位覆盖无处安放，
      // 记录事实不阻断 READY（启动模型可用，仅覆盖未恢复）。
      this.lastRestoreFailure = { reason: 'no_preset_anchor', at: Date.now() };
      void this.publishSnapshot();
      return;
    }
    const ok = mc.setModel(presetName, {
      ...(choice.thinkingEffort !== undefined ? { thinkingEffort: choice.thinkingEffort } : {}),
      source: RESTORE_SOURCE,
    });
    if (ok) {
      this.lastRestoreFailure = undefined;
      void this.publishSnapshot();
      return;
    }
    // 恢复失败（ADR-0034 决策 3）：回退全局默认，原选择保留在 choice（快照仍带原值，
    // 下次实例恢复再次尝试）；当前实例不后台自动切回。
    const fallbackOk = mc.setModel(DEFAULT_PRESET_NAME, { source: FALLBACK_SOURCE });
    this.lastRestoreFailure = { reason: 'preset_unavailable', at: Date.now() };
    void this.publishSnapshot();
    if (!fallbackOk) {
      // 双败：默认也不可用，宿主应不 READY。
      throw new Error(
        `model-selection restore failed: preset "${presetName}" unavailable and global default ("${DEFAULT_PRESET_NAME}") could not be resolved`,
      );
    }
  }

  /**
   * 凭证刷新（ADR-0028 修订一的编排收编，ADR-0034 决策 3）：
   * server 侧凭证变更（重登 / 换 key / OpenCode 换档）后对当前 preset
   * 重 resolve——LLM 实例 = 参数快照，凭证轮换 = 实例轮换，不是用户改选：
   * choice 与快照均不动。档位透传纪律与运行语义对齐：meta.thinkingEffort
   * 键存在（含显式 null = 厂商默认档）即原样透传，保持用户运行档位。
   * resolve 失败保留旧实例（旧凭证仍有效期间继续可用；401 → auth-recovery
   * 反应式路径仍是兜底）；进行中的调用持有旧实例引用不受影响。
   */
  private refreshCredentials(): Record<string, unknown> {
    const mc = this.modelControl;
    if (!mc) {
      return { ok: false, code: 'model_control_unavailable', error: 'model control not initialized' };
    }
    const meta = mc.getLLMMeta();
    const presetName = meta.presetName;
    if (!presetName) {
      // 非 preset 锚定的模型（裸 setLLM 构造）：无重 resolve 语义可言。
      return { ok: false, code: 'no_preset_anchor', error: 'current model is not preset-backed; nothing to re-resolve' };
    }
    const ok = mc.setModel(presetName, {
      ...(meta.thinkingEffort !== undefined ? { thinkingEffort: meta.thinkingEffort } : {}),
      source: 'credential-refresh',
    });
    if (!ok) {
      return { ok: false, code: 'preset_resolve_failed', error: `preset "${presetName}" could not be re-resolved; keeping previous instance` };
    }
    return { ok: true, meta: mc.getLLMMeta() };
  }

  private async declare(): Promise<void> {
    try {
      await this.client.declareChannel({ title: this.channelTitle, description: this.channelDescription });
      this.declared = true;
    } catch {
      // 声明失败不阻断初始化；请求面到达时宿主无授权记录会拒绝（可诊断）。
    }
  }

  private async publishSnapshot(): Promise<void> {
    try {
      if (!this.declared) await this.declare();
      await this.client.publishEvent('snapshot', {
        choice: { ...this.choice },
        ...(this.lastRestoreFailure ? { lastRestoreFailure: { ...this.lastRestoreFailure } } : {}),
        ready: true,
      });
    } catch {
      // 镜像面尽力而为：内存态与会话快照是真值。
    }
  }
}

/**
 * continuity 自声明包装：选择随 trim / rotate 接续与 branch 注入流转
 * （protocol 'claw.model-selection.v1'，importMode replace——restoreState
 * 自身已按 origin 区分合并语义）。协议在 server/context-continuity/
 * feature-continuity.js 的 PROTOCOL_ADAPTERS 不登记（通用透传）。
 */
export const ModelSelectionFeature = declareContinuity(ModelSelectionFeatureInner, {
  protocol: 'claw.model-selection.v1',
  importMode: 'replace',
});
