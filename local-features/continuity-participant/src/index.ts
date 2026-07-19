/**
 * Continuity Participant (Claw 自有协议层)
 *
 * 让一个 Feature 类获得 Claw continuity 协议的自声明能力。
 *
 * 设计理念：
 * - 框架自带的 Feature（如 OpencodeBasicFeature）不知道 Claw 的 continuity 协议，
 *   不应侵入框架本体。
 * - Claw 通过"包装类继承原 feature"模式添加协议字段，与 ControlledTodoFeature
 *   通过 extends TodoFeature 添加 interruptTargetId 完全是同一种模式。
 * - 包装类负责三件事：
 *     1. 提供 getContinuityDescriptor()，让 import 端可从 agent 实例查询声明
 *     2. override captureState()，把 descriptor 注入 snapshot（让无 agent 的 export 端也能读到）
 *     3. override restoreState()，把 descriptor 字段剥离后再交给原 feature 处理
 * - 第三方 feature 想参与 continuity 时，自己 declareContinuity 包装一下即可，
 *   无需回 Claw 中心登记。
 */

import type { AgentFeature, FeatureStateSnapshot } from 'agentdev';

/**
 * 快照中携带 continuity descriptor 的保留字段名。
 * 加 __ 前缀和 cl 后缀降低与业务字段碰撞的概率。
 */
export const CONTINUITY_FIELD_KEY = '__claw_continuity__';

/**
 * 通用 continuity 协议：无 schema 适配，state 原样进出。
 *
 * 大多数 feature 用这个协议就够了——只要它的 captureState 返回值是
 * 可序列化的纯数据，无需特化清理。
 */
export const GENERIC_CONTINUITY_PROTOCOL = 'claw.feature-continuity.v1';

/**
 * Claw continuity descriptor：feature 自声明参与 continuity 的合约。
 *
 * protocol    —— 协议标识符。Claw 协议层维护一张 protocol → adapter 的
 *                开放命名空间，未登记的 protocol 走透传（无 adapter）。
 *                只有需要特化清理（如 schema 规范化）的协议才在协议层登记 adapter。
 * importMode  —— 导入时的合并语义。当前仅 'replace'（直接覆盖 feature 内存状态）。
 */
export interface ClawContinuityDescriptor {
  protocol: string;
  importMode?: 'replace' | 'merge';
}

/**
 * 从 snapshot 读取 continuity descriptor。无声明返回 null。
 */
export function readContinuityDescriptor(snapshot: unknown): ClawContinuityDescriptor | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const descriptor = (snapshot as Record<string, unknown>)[CONTINUITY_FIELD_KEY];
  if (!descriptor || typeof descriptor !== 'object') return null;
  const protocol = (descriptor as { protocol?: unknown }).protocol;
  if (typeof protocol !== 'string' || !protocol.trim()) return null;
  return descriptor as ClawContinuityDescriptor;
}

/**
 * 从 snapshot 剥离 continuity 字段，返回纯 state。
 * 用于把 export 端的 raw checkpoint 还原成 feature 真正关心的状态数据。
 */
export function stripContinuityField(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const record = snapshot as Record<string, unknown>;
  if (!(CONTINUITY_FIELD_KEY in record)) return snapshot;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== CONTINUITY_FIELD_KEY) {
      rest[key] = record[key];
    }
  }
  return rest;
}

type AnyFeatureConstructor = new (...args: any[]) => AgentFeature;

/**
 * 高阶函数：让一个 Feature 类获得 continuity 自声明能力。
 *
 * @example
 * ```ts
 * import { OpencodeBasicFeature } from 'agentdev';
 * import { declareContinuity, GENERIC_CONTINUITY_PROTOCOL } from '../continuity-participant/src/index.js';
 *
 * export const ContinuityAwareOpencodeBasic = declareContinuity(OpencodeBasicFeature, {
 *   protocol: GENERIC_CONTINUITY_PROTOCOL,
 *   importMode: 'replace',
 * });
 * ```
 *
 * 包装后的类：
 * - 继承原 feature 的所有行为（工具、hooks、原 captureState/restoreState 语义）
 * - 多出 getContinuityDescriptor() 方法
 * - captureState 在原返回值上叠加 [CONTINUITY_FIELD_KEY] 字段
 * - restoreState 先剥离该字段再调用原 restoreState
 */
export function declareContinuity<T extends AnyFeatureConstructor>(
  Base: T,
  descriptor: ClawContinuityDescriptor,
): T {
  const normalizedDescriptor: ClawContinuityDescriptor = {
    protocol: descriptor.protocol,
    importMode: descriptor.importMode === 'merge' ? 'merge' : 'replace',
  };

  return class ContinuityAware extends Base {
    /**
     * 标志位：restoreState 是否被调用过。
     * - compacted resume / session load 场景：restoreState 被调用 → true
     * - 全新 session 首次启动：restoreState 未被调用 → false
     * onInitiate 根据此标志决定是否保护已恢复的状态。
     */
    private _continuityStateRestored = false;

    getContinuityDescriptor(): ClawContinuityDescriptor {
      return { ...normalizedDescriptor };
    }

    /**
     * Override onInitiate：防止基类的初始化逻辑清空 continuity/session 已恢复的状态。
     *
     * 背景：runtime 启动时 importFeatureContinuity 或 loadSession 会调用 restoreState
     * 恢复 feature 状态。但基类的 onInitiate（在 agent 首次 onCall 时触发）可能会清空
     * 状态（例如 OpencodeBasicFeature.onInitimate 会 this.readFiles.clear()）。这会导致
     * 已恢复的状态在首次 onCall 时被清空，使 readFiles 等保护机制失效。
     *
     * 策略：仅当 restoreState 被调用过（_continuityStateRestored=true）时，才在基类
     * onInitiate 执行后用 buffer 恢复状态。全新 session 首次启动时不干预，保留基类
     * onInitiate 的默认初始化行为。
     */
    async onInitiate(ctx: any): Promise<void> {
      const wasRestored = this._continuityStateRestored;
      // 在基类 onInitiate 之前捕获当前状态（已恢复的内容）
      const beforeBuffer = wasRestored ? stripContinuityField(super.captureState()) : null;

      // 调用基类 onInitiate（可能清空状态、初始化默认值等）
      if (typeof super.onInitiate === 'function') {
        await super.onInitiate(ctx);
      }

      // 仅在曾恢复过状态时，用 buffer 覆盖 onInitiate 的清空副作用
      if (wasRestored && beforeBuffer && typeof beforeBuffer === 'object') {
        super.restoreState(beforeBuffer as FeatureStateSnapshot);
      }
    }

    captureState(): FeatureStateSnapshot {
      const base = super.captureState();
      if (base && typeof base === 'object') {
        return { ...(base as Record<string, unknown>), [CONTINUITY_FIELD_KEY]: normalizedDescriptor };
      }
      // 基类 captureState 返回 null/undefined/原始值时，仍注入 descriptor 让 export 端能识别该 feature 参与协议
      return { [CONTINUITY_FIELD_KEY]: normalizedDescriptor } as FeatureStateSnapshot;
    }

    restoreState(snapshot: FeatureStateSnapshot): void {
      // 标记状态已恢复，供 onInitiate override 判断是否需要保护
      this._continuityStateRestored = true;
      if (snapshot && typeof snapshot === 'object' && CONTINUITY_FIELD_KEY in (snapshot as Record<string, unknown>)) {
        const stripped = stripContinuityField(snapshot);
        // 剥离后若为空对象，传空对象给基类（让基类按"空 state"语义处理，而非 undefined）
        super.restoreState(stripped);
        return;
      }
      super.restoreState(snapshot);
    }
  };
}
