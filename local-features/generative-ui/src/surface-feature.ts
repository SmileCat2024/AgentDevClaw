/**
 * GenerativeUISurfaceFeature — Agent 侧持久 Surface 工具集
 *
 * 提供四个工具：
 * - ui_surface_upsert: 创建或更新 Surface（不阻塞）
 * - ui_surface_get: 获取单个 Surface 完整 Spec
 * - ui_surface_list: 列出当前 Agent 的全部活跃 Surface
 * - ui_surface_close: 关闭 Surface（幂等）
 *
 * 不注册 call/step hooks，不修改输入循环。
 * 工具通过 HttpSurfaceTransport 与 Claw Server SurfaceStore 通信。
 */

import type { AgentFeature, FeatureInitContext, FeatureStateSnapshot } from 'agentdev';
import { createTool, DebugHub } from 'agentdev';
import type {
  GenerativeUISpecV1,
  GenerativeUISurfaceFeatureConfig,
  UISurfaceUpsertResponse,
  UISurfaceGetResponse,
  UISurfaceListResponse,
  UISurfaceCloseResponse,
  UIToolError,
} from './types.js';
import { UI_LIMITS } from './types.js';
import { validateGenerativeUISpec } from './validator.js';
import { generateCatalogDescription } from './catalog.js';
import { HttpSurfaceTransport } from './transport.js';
import type { SurfaceStatus, SurfaceTransport } from './types.js';
import { declareContinuity } from '../../continuity-participant/src/index.js';

// ═══════════════════════════════════════════════════════════════
// 工具参数描述（给 Agent 看的 JSON Schema）
// ═══════════════════════════════════════════════════════════════

const SPEC_SCHEMA_DESCRIPTION = [
  'A declarative UI specification. Structure:',
  '{ schemaVersion: 1, catalogVersion: "v1", title: string, root: elementId,',
  '  elements: { id: { type: componentName, props: {...}, children: [childId, ...] } },',
  '  initialValues?: { fieldName: value },',
  '  actions?: { actionId: { intent: "submit"|"reset", label: string, includeFields?: [fieldName],',
  '    confirm?: { title: string, description?: string, confirmLabel?: string } } } }',
  'A submit action sends the current values shown by its fields, including untouched initialValues.',
  'Omit includeFields to submit every declared input field; provide it only to submit a narrower whitelist.',
  'Use confirm for destructive or consequential actions; it opens a local confirmation dialog before dispatch.',
].join('\n');

const BROWSER_SURFACE_LOCATION = 'the right-side “交互页面” (Interaction Pages) panel in the AgentDevClaw browser client';

// ═══════════════════════════════════════════════════════════════
// Feature 实现
// ═══════════════════════════════════════════════════════════════

interface PersistedSurfaceState {
  surfaceId: string;
  spec: GenerativeUISpecV1;
  presentation: { open: 'never' | 'if-empty' | 'request' };
  status: SurfaceStatus;
}

interface GenerativeUISurfaceStateV1 {
  schemaVersion: 1;
  surfaces: PersistedSurfaceState[];
}

const GENERATIVE_UI_CONTINUITY_PROTOCOL = 'claw.generative-ui-surface.v1';

/**
 * Canonical surface state belongs to this Feature, so it participates in the
 * same AgentDev session snapshots and Claw continuity handoffs as Todo.
 *
 * The HTTP SurfaceStore is deliberately only a runtime projection for the
 * browser client. It is rebuilt from this state after a runtime restart.
 */
export class GenerativeUISurfaceFeatureInner implements AgentFeature {
  readonly name = 'generative-ui-surface';
  readonly description = 'Create and manage persistent interactive UI surfaces in the AgentDevClaw browser client’s right-side “交互页面” (Interaction Pages) panel, independently from the chat.';

  private _transport: SurfaceTransport | null = null;
  private _config: Required<GenerativeUISurfaceFeatureConfig>;
  private _catalogDescription: string;
  private _debugAgentId: string | null = null;
  private _logger?: FeatureInitContext['logger'];
  private _surfaces = new Map<string, PersistedSurfaceState>();
  private _needsRestoreProjection = false;
  private _restoreProjection: Promise<void> | null = null;

  constructor(config?: GenerativeUISurfaceFeatureConfig) {
    this._config = {
      enabled: config?.enabled ?? true,
      maxSurfaces: config?.maxSurfaces ?? UI_LIMITS.maxSurfacesPerAgent,
      allowAgentSubmit: config?.allowAgentSubmit ?? true,
      autoOpenPolicy: config?.autoOpenPolicy ?? 'first',
      // Keep this empty until onInitiate resolves the documented precedence.
      // A default here would incorrectly shadow ctx.featureConfig and env.
      serverOrigin: config?.serverOrigin ?? '',
    };
    this._catalogDescription = generateCatalogDescription();
  }

  async onInitiate(ctx?: any): Promise<void> {
    // 优先级：构造参数 > ctx.featureConfig > env > 默认
    const featureConfig = ctx?.featureConfig || {};
    const serverOrigin =
      this._config.serverOrigin ||
      featureConfig.serverOrigin ||
      process.env.PROTOCLAW_SERVER_ORIGIN ||
      `http://127.0.0.1:${process.env.PORT || 1420}`;

    this._config.serverOrigin = serverOrigin;
    this._transport = new HttpSurfaceTransport(serverOrigin);
    this._logger = ctx?.logger;
    await this._synchronizeRestoredSurfaces();
  }

  async onDestroy(): Promise<void> {
    this._transport = null;
  }

  /**
   * 框架在 ensureFeatureTools 后自动调用，传入正确的 agentId。
   * 与 TodoFeature.pushDebugSnapshot 同一模式。
   */
  pushDebugSnapshot(agentId?: string): void {
    if (agentId) {
      this._debugAgentId = agentId;
    }
    void this._synchronizeRestoredSurfaces();
  }

  private _getAgentId(): string | null {
    // 优先使用框架传入的 agentId
    if (this._debugAgentId) return this._debugAgentId;
    const configuredAgentId = process.env.PROTOCLAW_PREBUILT_AGENT_ID?.trim();
    if (configuredAgentId) return configuredAgentId;
    // 回退：通过 DebugHub 获取
    try {
      const hub = DebugHub?.getInstance?.();
      const id = hub?.getCurrentAgentId?.();
      return typeof id === 'string' && id.length > 0 ? id : null;
    } catch {
      return null;
    }
  }

  private _makeError(code: string, message: string): UIToolError {
    return { ok: false, code: code as any, message };
  }

  /** Capture only agent-published declarative surfaces, never browser drafts. */
  captureState(): GenerativeUISurfaceStateV1 {
    return {
      schemaVersion: 1,
      surfaces: Array.from(this._surfaces.values(), (surface) => _cloneSurfaceState(surface)),
    };
  }

  /**
   * Restore Feature-owned state first, then replay it to the in-memory server
   * projection. The framework awaits this method during session restore.
   */
  async restoreState(raw: FeatureStateSnapshot): Promise<void> {
    this._surfaces = _parseSurfaceState(raw, this._config.maxSurfaces);
    this._needsRestoreProjection = true;
    await this._synchronizeRestoredSurfaces();
  }

  private async _synchronizeRestoredSurfaces(): Promise<void> {
    if (!this._needsRestoreProjection) return;
    if (this._restoreProjection) return this._restoreProjection;
    if (!this._transport) return;

    const agentId = this._getAgentId();
    if (!agentId) return;

    const projection = this._projectRestoredSurfaces(agentId);
    this._restoreProjection = projection;
    try {
      await projection;
    } finally {
      if (this._restoreProjection === projection) this._restoreProjection = null;
    }
  }

  private async _projectRestoredSurfaces(agentId: string): Promise<void> {
    if (!this._transport) return;

    try {
      for (const surface of this._surfaces.values()) {
        const record = await this._transport.upsert(agentId, {
          surfaceId: surface.surfaceId,
          spec: surface.spec,
          presentation: surface.presentation,
        });
        if (surface.status === 'closed') {
          await this._transport.close(agentId, surface.surfaceId, record.revision);
        }
      }
      this._needsRestoreProjection = false;
    } catch (error) {
      // Feature state remains restored even when the local server is briefly
      // unavailable. A later lifecycle/tool entry retries the projection.
      this._logger?.warn?.('Generative UI surface projection restore failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Tools
  // ═══════════════════════════════════════════════════════════════

  getTools() {
    return [
      // ── ui_surface_upsert ──
      createTool({
        name: 'ui_surface_upsert',
        description: [
          `Create or update a persistent interactive UI surface in ${BROWSER_SURFACE_LOCATION}.`,
          'This is browser UI beside the conversation — not a chat message, a new browser tab, or an external webpage.',
          'The surface lives independently from the chat — it survives context compaction,',
          'message trimming, and session switching. Users can interact with it locally',
          '(filling forms, selecting options) without triggering any Agent calls.',
          '',
          'Only when a user clicks a button with intent "submit" does a visible user message',
          'appear in the chat, just like a normal user turn.',
          '',
          'Use the SAME surfaceId to update an existing surface (replaces the full Spec).',
          'The tool returns immediately without waiting for user interaction.',
          '',
          SPEC_SCHEMA_DESCRIPTION,
          '',
          this._catalogDescription,
        ].join('\n'),
        parameters: {
          type: 'object',
          required: ['surfaceId', 'spec'],
          properties: {
            surfaceId: {
              type: 'string',
              pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$',
              maxLength: 64,
              description: 'Unique identifier for this surface. Use the same ID to update.',
            },
            spec: {
              type: 'object',
              description: SPEC_SCHEMA_DESCRIPTION,
            },
            expectedRevision: {
              type: 'number',
              description: 'Optional: for optimistic concurrency. If set, the upsert only succeeds if the current revision matches.',
            },
          },
        },
        execute: async (args: any, context?: any): Promise<UISurfaceUpsertResponse> => {
          if (!this._config.enabled) {
            return this._makeError('surface_host_unavailable', 'Surface feature is disabled');
          }

          const agentId = this._getAgentId();
          if (!agentId) {
            return this._makeError('surface_host_unavailable', 'Cannot determine current agent ID');
          }

          if (!this._transport) {
            return this._makeError('surface_host_unavailable', 'Transport not initialized');
          }

          const { surfaceId, spec, expectedRevision } = args;

          // 工具侧预校验（快速失败）
          const validation = validateGenerativeUISpec(spec);
          if (!validation.valid) {
            return this._makeError('invalid_spec', `Spec validation failed: ${validation.errors.join('; ')}`);
          }

          try {
            const record = await this._transport.upsert(
              agentId,
              {
                surfaceId,
                spec: spec as GenerativeUISpecV1,
                expectedRevision: typeof expectedRevision === 'number' ? expectedRevision : undefined,
              },
              context?.signal,
            );

            this._surfaces.set(surfaceId, {
              surfaceId,
              spec: _cloneSpec(spec as GenerativeUISpecV1),
              presentation: record.presentation,
              status: 'active',
            });

            return {
              ok: true,
              surface: {
                surfaceId: record.surfaceId,
                revision: record.revision,
                status: record.status,
                placement: 'right-panel',
                changed: true,
              },
            };
          } catch (err: any) {
            return this._transportError(err, 'upsert');
          }
        },
        render: {
          call: 'ui-surface-upsert',
          result: 'ui-surface-result',
        },
      }),

      // ── ui_surface_get ──
      createTool({
        name: 'ui_surface_get',
        parallelizable: true,
        description: [
          'Get the full current Spec of an existing surface.',
          'Useful after context compaction or when resuming a session to recover',
          'knowledge of what surfaces exist and their current state.',
        ].join('\n'),
        parameters: {
          type: 'object',
          required: ['surfaceId'],
          properties: {
            surfaceId: { type: 'string', description: 'The surface ID to retrieve.' },
          },
        },
        execute: async (args: any, context?: any): Promise<UISurfaceGetResponse> => {
          if (!this._transport) {
            return this._makeError('surface_host_unavailable', 'Transport not initialized');
          }

          const agentId = this._getAgentId();
          if (!agentId) {
            return this._makeError('surface_host_unavailable', 'Cannot determine current agent ID');
          }

          try {
            const record = await this._transport.get(agentId, args.surfaceId, context?.signal);
            if (!record) {
              return this._makeError('not_found', `Surface "${args.surfaceId}" not found`);
            }

            const existing = this._surfaces.get(record.surfaceId);
            this._surfaces.set(record.surfaceId, {
              surfaceId: record.surfaceId,
              spec: _cloneSpec(record.spec),
              presentation: existing?.presentation || record.presentation,
              status: record.status,
            });

            return {
              ok: true,
              surface: {
                surfaceId: record.surfaceId,
                revision: record.revision,
                status: record.status,
                spec: record.spec,
                updatedAt: record.updatedAt,
              },
            };
          } catch (err: any) {
            return this._transportError(err, 'get');
          }
        },
        render: { call: 'ui-surface-get', result: 'ui-surface-result' },
      }),

      // ── ui_surface_list ──
      createTool({
        name: 'ui_surface_list',
        parallelizable: true,
        description: [
          `List all active surfaces for the current agent that are published to ${BROWSER_SURFACE_LOCATION}.`,
          'Returns summaries (surfaceId, title, revision, status) without full Specs.',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            includeClosed: { type: 'boolean', description: 'Include closed surfaces in the list.' },
          },
        },
        execute: async (_args: any, context?: any): Promise<UISurfaceListResponse> => {
          if (!this._transport) {
            return this._makeError('surface_host_unavailable', 'Transport not initialized');
          }

          const agentId = this._getAgentId();
          if (!agentId) {
            return this._makeError('surface_host_unavailable', 'Cannot determine current agent ID');
          }

          try {
            const surfaces = await this._transport.list(agentId, context?.signal);
            return { ok: true, surfaces };
          } catch (err: any) {
            return this._transportError(err, 'list');
          }
        },
        render: { call: 'ui-surface-list', result: 'ui-surface-result' },
      }),

      // ── ui_surface_close ──
      createTool({
        name: 'ui_surface_close',
        description: [
          `Close a persistent surface. The surface becomes inactive and is removed from ${BROWSER_SURFACE_LOCATION}.`,
          'This is idempotent: closing an already-closed surface returns ok.',
          'Tool audit records in chat history are not deleted.',
        ].join('\n'),
        parameters: {
          type: 'object',
          required: ['surfaceId'],
          properties: {
            surfaceId: { type: 'string', description: 'The surface ID to close.' },
            expectedRevision: { type: 'number', description: 'Optional: for optimistic concurrency check.' },
          },
        },
        execute: async (args: any, context?: any): Promise<UISurfaceCloseResponse> => {
          if (!this._transport) {
            return this._makeError('surface_host_unavailable', 'Transport not initialized');
          }

          const agentId = this._getAgentId();
          if (!agentId) {
            return this._makeError('surface_host_unavailable', 'Cannot determine current agent ID');
          }

          try {
            const result = await this._transport.close(
              agentId,
              args.surfaceId,
              args.expectedRevision,
              context?.signal,
            );

            const existing = this._surfaces.get(args.surfaceId);
            if (existing) {
              this._surfaces.set(args.surfaceId, { ...existing, status: 'closed' });
            }

            return {
              ok: true,
              surfaceId: args.surfaceId,
              alreadyClosed: result.alreadyClosed || false,
            };
          } catch (err: any) {
            return this._transportError(err, 'close');
          }
        },
        render: { call: 'ui-surface-close', result: 'ui-surface-result' },
      }),
    ];
  }

  // ── Render templates ──

  getRenderTemplates(): Record<string, { call: (data: Record<string, any>) => string; result: (data: Record<string, any>, success?: boolean) => string }> {
    return {
      'ui-surface-upsert': {
        call: (data) => `<div class="tool-call ui-surface-call"><span class="ui-surface-icon">🖥</span> Create/Update UI Surface${data?.surfaceId ? `: ${escapeHtml(data.surfaceId)}` : ''}</div>`,
        result: (_data, success) => success
          ? `<div class="tool-result ui-surface-result">Surface updated successfully.</div>`
          : `<div class="tool-error">Surface operation failed.</div>`,
      },
      'ui-surface-get': {
        call: (data) => `<div class="tool-call ui-surface-call"><span class="ui-surface-icon">📖</span> Get Surface${data?.surfaceId ? `: ${escapeHtml(data.surfaceId)}` : ''}</div>`,
        result: (_data, success) => success ? `<div class="tool-result ui-surface-result">Surface retrieved.</div>` : `<div class="tool-error">Surface not found.</div>`,
      },
      'ui-surface-list': {
        call: () => `<div class="tool-call ui-surface-call"><span class="ui-surface-icon">📋</span> List Surfaces</div>`,
        result: (_data, success) => success ? `<div class="tool-result ui-surface-result">Surfaces listed.</div>` : `<div class="tool-error">List failed.</div>`,
      },
      'ui-surface-close': {
        call: (data) => `<div class="tool-call ui-surface-call"><span class="ui-surface-icon">✕</span> Close Surface${data?.surfaceId ? `: ${escapeHtml(data.surfaceId)}` : ''}</div>`,
        result: (_data, success) => success ? `<div class="tool-result ui-surface-result">Surface closed.</div>` : `<div class="tool-error">Close failed.</div>`,
      },
      'ui-surface-result': {
        call: () => '',
        result: (_data, success) => success ? '' : '<div class="tool-error">Surface operation failed.</div>',
      },
    };
  }

  // ── 错误归一化 ──

  private _transportError(err: any, operation: string): UIToolError {
    const code = err?.code || 'surface_host_unavailable';
    const message = err?.message || `${operation} failed`;

    // 网络错误 / abort 归一化为 host_unavailable
    if (err?.name === 'AbortError') {
      return this._makeError('surface_host_unavailable', `${operation} aborted`);
    }
    if (code === 'surface_limit' || code === 'revision_conflict' || code === 'invalid_spec' || code === 'not_found') {
      return this._makeError(code, message);
    }

    return this._makeError('surface_host_unavailable', message);
  }
}

/**
 * The wrapper adds the same explicit continuity descriptor used by Todo. It
 * enables handoff / compaction recovery in addition to AgentDev's normal
 * session snapshot restore.
 */
export const GenerativeUISurfaceFeature = declareContinuity(GenerativeUISurfaceFeatureInner, {
  protocol: GENERATIVE_UI_CONTINUITY_PROTOCOL,
  importMode: 'replace',
});

function _parseSurfaceState(raw: unknown, maxSurfaces: number): Map<string, PersistedSurfaceState> {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Partial<GenerativeUISurfaceStateV1>
    : null;
  const surfaces = new Map<string, PersistedSurfaceState>();
  if (state?.schemaVersion !== 1 || !Array.isArray(state.surfaces)) return surfaces;

  let activeCount = 0;
  for (const rawSurface of state.surfaces) {
    if (!rawSurface || typeof rawSurface !== 'object') continue;
    const candidate = rawSurface as Partial<PersistedSurfaceState>;
    if (typeof candidate.surfaceId !== 'string' || !UI_LIMITS.idPattern.test(candidate.surfaceId) || surfaces.has(candidate.surfaceId)) continue;
    if (!candidate.spec || !validateGenerativeUISpec(candidate.spec).valid) continue;

    const status: SurfaceStatus = candidate.status === 'closed' ? 'closed' : 'active';
    if (status === 'active' && activeCount >= maxSurfaces) continue;
    if (status === 'active') activeCount += 1;
    surfaces.set(candidate.surfaceId, {
      surfaceId: candidate.surfaceId,
      spec: _cloneSpec(candidate.spec),
      presentation: _normalizePresentation(candidate.presentation),
      status,
    });
  }
  return surfaces;
}

function _normalizePresentation(value: unknown): PersistedSurfaceState['presentation'] {
  const open = value && typeof value === 'object' && ['never', 'if-empty', 'request'].includes((value as { open?: unknown }).open as string)
    ? (value as { open: PersistedSurfaceState['presentation']['open'] }).open
    : 'if-empty';
  return { open };
}

function _cloneSpec(spec: GenerativeUISpecV1): GenerativeUISpecV1 {
  return JSON.parse(JSON.stringify(spec)) as GenerativeUISpecV1;
}

function _cloneSurfaceState(surface: PersistedSurfaceState): PersistedSurfaceState {
  return {
    surfaceId: surface.surfaceId,
    spec: _cloneSpec(surface.spec),
    presentation: { ...surface.presentation },
    status: surface.status,
  };
}

// ═══════════════════════════════════════════════════════════════
// 工具
// ═══════════════════════════════════════════════════════════════

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
