/**
 * Generative UI — 类型契约
 *
 * 本文件是整个 Generative UI 系统的类型单一来源。
 * Spec 结构、Catalog 组件名、Surface 记录、Transport 接口、错误码
 * 全部在此定义，被 catalog.ts / validator.ts / transport.ts /
 * surface-feature.ts / 服务端路由共同引用。
 */

// ═══════════════════════════════════════════════════════════════
// 基础类型
// ═══════════════════════════════════════════════════════════════

/** Spec 中可用的原始值类型 */
export type PrimitiveValue = string | number | boolean | null;

// ═══════════════════════════════════════════════════════════════
// UI Spec
// ═══════════════════════════════════════════════════════════════

/** Spec 顶层结构 */
export interface GenerativeUISpecV1 {
  schemaVersion: 1;
  catalogVersion: 'v1';
  title: string;
  description?: string;
  /** elements 中作为根节点的 key */
  root: string;
  /** id → element 映射 */
  elements: Record<string, GenerativeUIElement>;
  /** 字段初始值，key 是字段 name */
  initialValues?: Record<string, PrimitiveValue>;
  /** actionId → action 定义 */
  actions?: Record<string, GenerativeUIAction>;
}

/** 单个 UI 元素 */
export interface GenerativeUIElement {
  /** Catalog 中声明的组件类型 */
  type: string;
  /** 组件属性，必须符合 Catalog 中对应组件的 props schema */
  props: Record<string, unknown>;
  /** 子元素 ID 列表 */
  children: string[];
}

/** 用户可触发的动作 */
export interface GenerativeUIAction {
  /** submit = 交给宿主处理；reset = 本地重置 */
  intent: 'submit' | 'reset';
  label: string;
  /** 提交时包含的字段名列表；省略时提交当前页面全部已声明字段 */
  includeFields?: string[];
  /** 提交前的确认对话框配置 */
  confirm?: {
    title: string;
    description?: string;
    confirmLabel?: string;
  };
}

// ═══════════════════════════════════════════════════════════════
// Catalog 限制常量
// ═══════════════════════════════════════════════════════════════

export const UI_LIMITS = {
  maxSurfacesPerAgent: 8,
  maxElementsPerSurface: 200,
  maxTreeDepth: 20,
  maxSpecBytes: 256 * 1024,       // 256 KiB
  maxTextPropChars: 10_000,
  maxTableColumns: 20,
  maxTableRows: 100,
  maxSelectOptions: 100,
  maxSubmitValueBytes: 64 * 1024,  // 64 KiB
  maxIdLength: 64,
  idPattern: /^[a-zA-Z][a-zA-Z0-9_-]*$/,
} as const;

// ═══════════════════════════════════════════════════════════════
// 错误码
// ═══════════════════════════════════════════════════════════════

/** 工具 / 路由返回的业务错误码 */
export type UISurfaceErrorCode =
  | 'invalid_spec'
  | 'revision_conflict'
  | 'surface_limit'
  | 'payload_too_large'
  | 'surface_host_unavailable'
  | 'not_found'
  | 'stale_surface'
  | 'duplicate_event'
  | 'action_not_found'
  | 'field_not_allowed'
  | 'surface_closed';

// ═══════════════════════════════════════════════════════════════
// Surface 记录（运行期投影）
// ═══════════════════════════════════════════════════════════════

export type SurfaceStatus = 'active' | 'closed';

/** 单个 Surface 的完整记录，由服务端运行期 SurfaceStore 持有。
 * 跨会话恢复由 GenerativeUISurfaceFeature 的 Feature state 负责。 */
export interface UISurfaceRecord {
  agentId: string;
  surfaceId: string;
  revision: number;
  status: SurfaceStatus;
  spec: GenerativeUISpecV1;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  presentation: { open: 'never' | 'if-empty' | 'request' };
}

/** 某 Agent 的全部 Surface 快照 */
export interface UIRegistrySnapshot {
  agentId: string;
  /** 整个 registry 的修订号，任何 Surface 变化都递增 */
  registryRevision: number;
  surfaces: UISurfaceRecord[];
}

/** Surface 摘要（list 返回，不含完整 Spec） */
export interface UISurfaceSummary {
  surfaceId: string;
  title: string;
  revision: number;
  updatedAt: number;
  status: SurfaceStatus;
}

// ═══════════════════════════════════════════════════════════════
// Transport 接口
// ═══════════════════════════════════════════════════════════════

/** upsert 输入 */
export interface UISurfaceUpsertInput {
  surfaceId: string;
  spec: GenerativeUISpecV1;
  expectedRevision?: number;
  presentation?: { open?: 'never' | 'if-empty' | 'request' };
}

/** close 结果 */
export interface CloseResult {
  ok: boolean;
  alreadyClosed?: boolean;
  surfaceId: string;
}

/** transport 层的 Agent → Server 通信契约 */
export interface SurfaceTransport {
  upsert(agentId: string, input: UISurfaceUpsertInput, signal?: AbortSignal): Promise<UISurfaceRecord>;
  get(agentId: string, surfaceId: string, signal?: AbortSignal): Promise<UISurfaceRecord | null>;
  list(agentId: string, signal?: AbortSignal): Promise<UISurfaceSummary[]>;
  close(agentId: string, surfaceId: string, expectedRevision?: number, signal?: AbortSignal): Promise<CloseResult>;
}

// ═══════════════════════════════════════════════════════════════
// 工具结果形状
// ═══════════════════════════════════════════════════════════════

/** upsert 成功结果（摘要，不含完整 Spec） */
export interface UISurfaceUpsertResult {
  ok: true;
  surface: {
    surfaceId: string;
    revision: number;
    status: SurfaceStatus;
    placement: 'right-panel';
    changed: boolean;
  };
}

/** 工具业务失败 */
export interface UIToolError {
  ok: false;
  code: UISurfaceErrorCode;
  message: string;
}

export type UISurfaceUpsertResponse = UISurfaceUpsertResult | UIToolError;

/** get 成功结果 */
export interface UISurfaceGetResult {
  ok: true;
  surface: {
    surfaceId: string;
    revision: number;
    status: SurfaceStatus;
    spec: GenerativeUISpecV1;
    updatedAt: number;
  };
}

export type UISurfaceGetResponse = UISurfaceGetResult | UIToolError;

/** list 成功结果 */
export interface UISurfaceListResult {
  ok: true;
  surfaces: UISurfaceSummary[];
}

export type UISurfaceListResponse = UISurfaceListResult | UIToolError;

/** close 成功结果 */
export interface UISurfaceCloseResult {
  ok: true;
  surfaceId: string;
  alreadyClosed: boolean;
}

export type UISurfaceCloseResponse = UISurfaceCloseResult | UIToolError;

// ═══════════════════════════════════════════════════════════════
// Validator 结果
// ═══════════════════════════════════════════════════════════════

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** 便于日志的统计信息 */
  stats?: {
    elementCount: number;
    maxDepth: number;
    specBytes: number;
  };
}

// ═══════════════════════════════════════════════════════════════
// Feature 配置
// ═══════════════════════════════════════════════════════════════

export interface GenerativeUISurfaceFeatureConfig {
  enabled?: boolean;
  maxSurfaces?: number;
  allowAgentSubmit?: boolean;
  autoOpenPolicy?: 'never' | 'first';
  serverOrigin?: string;
}
