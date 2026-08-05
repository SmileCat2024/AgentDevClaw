/**
 * UISurfaceStore — 服务端内存状态存储
 *
 * 按 agentId 隔离的 Surface 管理器。
 * 支持：revision 递增、contentHash 幂等、ETag、eventId LRU 去重。
 *
 * Store 只承担浏览器侧运行期投影；跨重启的逻辑状态由
 * GenerativeUISurfaceFeature 的 captureState/restoreState 持有并重放。
 */

import crypto from 'crypto';

/** Surface 记录的运行时结构 */
class SurfaceRecord {
  constructor({ agentId, surfaceId, spec, contentHash, presentation }) {
    this.agentId = agentId;
    this.surfaceId = surfaceId;
    this.revision = 1;
    this.status = 'active';
    this.spec = spec;
    this.contentHash = contentHash;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    this.presentation = presentation || { open: 'if-empty' };
  }

  toRecord() {
    return {
      agentId: this.agentId,
      surfaceId: this.surfaceId,
      revision: this.revision,
      status: this.status,
      spec: this.spec,
      contentHash: this.contentHash,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      presentation: this.presentation,
    };
  }

  toSummary() {
    return {
      surfaceId: this.surfaceId,
      title: this.spec?.title || this.surfaceId,
      revision: this.revision,
      updatedAt: this.updatedAt,
      status: this.status,
    };
  }
}

/**
 * 计算内容的哈希值，用于幂等检查。
 * 只有 spec + presentation 参与，surfaceId 和 revision 不参与。
 */
function computeContentHash(spec, presentation) {
  const data = JSON.stringify({ spec, presentation });
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}

/** 默认每个 Agent 最多活跃 Surface 数 */
const DEFAULT_MAX_SURFACES = 8;

/** eventId LRU 最大容量 */
const EVENT_LRU_MAX = 200;

/** V1 input components whose `props.name` may be submitted by an action. */
const INPUT_COMPONENT_TYPES = new Set([
  'TextInput',
  'NumberInput',
  'Textarea',
  'Select',
  'Checkbox',
  'RadioGroup',
  'DateInput',
  'Slider',
  'Switch',
  'SegmentedControl',
]);

/**
 * Returns the declared form fields in a surface spec.
 *
 * `includeFields` is an optional narrower whitelist. When it is absent, this
 * set is the server-authoritative boundary for a whole-form submission.
 */
export function getSurfaceInputFieldNames(spec) {
  const fieldNames = [];
  const seen = new Set();
  const elements = spec?.elements;
  if (!elements || typeof elements !== 'object') return fieldNames;

  for (const element of Object.values(elements)) {
    if (!element || !INPUT_COMPONENT_TYPES.has(element.type)) continue;
    const name = element.props?.name;
    if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
      seen.add(name);
      fieldNames.push(name);
    }
  }
  return fieldNames;
}

class UISurfaceStore {
  constructor(options = {}) {
    /** @type {Map<string, Map<string, SurfaceRecord>>} agentId → surfaceId → record */
    this._store = new Map();
    /** @type {Map<string, number>} agentId → registryRevision */
    this._registryRevisions = new Map();
    /** @type {Map<string, {timestamp: number, status: 'processing'|'completed', result?: object}>} */
    this._seenEvents = new Map();
    this._maxSurfaces = options.maxSurfaces || DEFAULT_MAX_SURFACES;
  }

  // ═══════════════════════════════════════════════════════════════
  // Upsert
  // ═══════════════════════════════════════════════════════════════

  /**
   * 创建或更新一个 Surface。
   * @returns {{ record: SurfaceRecord, changed: boolean, conflict: string|null }}
   */
  upsert(agentId, surfaceId, spec, options = {}) {
    const agentSurfaces = this._getOrCreateAgent(agentId);
    const presentation = options.presentation || { open: 'if-empty' };
    const contentHash = computeContentHash(spec, presentation);

    const existing = agentSurfaces.get(surfaceId);

    // 乐观并发检查
    if (existing && options.expectedRevision !== undefined) {
      if (existing.revision !== options.expectedRevision) {
        return {
          record: existing,
          changed: false,
          conflict: 'revision_conflict',
        };
      }
    }

    // 幂等检查：相同内容不递增 revision
    if (existing && existing.contentHash === contentHash && existing.status === 'active') {
      return { record: existing, changed: false, conflict: null };
    }

    // 新建 vs 更新
    if (existing) {
      existing.spec = spec;
      existing.contentHash = contentHash;
      existing.revision += 1;
      existing.updatedAt = Date.now();
      existing.status = 'active';
      existing.presentation = presentation;
    } else {
      // 检查活跃 Surface 上限
      const activeCount = this._countActive(agentSurfaces);
      if (activeCount >= this._maxSurfaces) {
        return { record: null, changed: false, conflict: 'surface_limit' };
      }
      const record = new SurfaceRecord({ agentId, surfaceId, spec, contentHash, presentation });
      agentSurfaces.set(surfaceId, record);
    }

    this._bumpRegistryRevision(agentId);
    const updated = agentSurfaces.get(surfaceId);
    return { record: updated, changed: true, conflict: null };
  }

  // ═══════════════════════════════════════════════════════════════
  // Get
  // ═══════════════════════════════════════════════════════════════

  get(agentId, surfaceId) {
    const agentSurfaces = this._store.get(agentId);
    if (!agentSurfaces) return null;
    const record = agentSurfaces.get(surfaceId);
    return record ? record.toRecord() : null;
  }

  // ═══════════════════════════════════════════════════════════════
  // List (summaries only)
  // ═══════════════════════════════════════════════════════════════

  list(agentId, options = {}) {
    const agentSurfaces = this._store.get(agentId);
    if (!agentSurfaces) return { surfaces: [], registryRevision: 0 };

    const includeClosed = options.includeClosed === true;
    const summaries = [];
    for (const record of agentSurfaces.values()) {
      if (!includeClosed && record.status === 'closed') continue;
      summaries.push(record.toSummary());
    }
    return {
      surfaces: summaries,
      registryRevision: this._registryRevisions.get(agentId) || 0,
    };
  }

  /**
   * 获取完整 registry 快照（含 Spec，用于前端渲染）。
   */
  getRegistry(agentId, options = {}) {
    const agentSurfaces = this._store.get(agentId);
    if (!agentSurfaces) {
      return { agentId, registryRevision: 0, surfaces: [] };
    }
    const includeClosed = options.includeClosed === true;
    const surfaces = [];
    for (const record of agentSurfaces.values()) {
      if (!includeClosed && record.status === 'closed') continue;
      surfaces.push(record.toRecord());
    }
    return {
      agentId,
      registryRevision: this._registryRevisions.get(agentId) || 0,
      surfaces,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // Close (幂等)
  // ═══════════════════════════════════════════════════════════════

  close(agentId, surfaceId, options = {}) {
    const agentSurfaces = this._store.get(agentId);
    if (!agentSurfaces) {
      return { ok: true, alreadyClosed: true };
    }
    const record = agentSurfaces.get(surfaceId);
    if (!record || record.status === 'closed') {
      return { ok: true, alreadyClosed: true };
    }

    // 乐观并发检查
    if (options.expectedRevision !== undefined && record.revision !== options.expectedRevision) {
      return { ok: false, conflict: 'revision_conflict' };
    }

    record.status = 'closed';
    record.updatedAt = Date.now();
    this._bumpRegistryRevision(agentId);
    return { ok: true, alreadyClosed: false };
  }

  // ═══════════════════════════════════════════════════════════════
  // Action 校验（提交时服务端二次校验）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 校验 action 请求是否合法。
   * @returns {{ valid: boolean, error?: string, action?: object, record?: object, allowedFields?: string[] }}
   */
  validateAction(agentId, surfaceId, actionId, surfaceRevision, values) {
    const record = this.get(agentId, surfaceId);
    if (!record) {
      return { valid: false, error: 'not_found' };
    }
    if (record.status === 'closed') {
      return { valid: false, error: 'surface_closed' };
    }
    if (surfaceRevision !== record.revision) {
      return { valid: false, error: 'stale_surface', message: `Expected revision ${record.revision}, got ${surfaceRevision}` };
    }

    const action = record.spec?.actions?.[actionId];
    if (!action) {
      return { valid: false, error: 'action_not_found' };
    }

    // includeFields 是可选的收窄白名单；未声明时允许该 Surface 中已定义
    // 的全部表单字段，仍然不会接受客户端伪造的任意 key。
    const allowedFields = Array.isArray(action.includeFields)
      ? action.includeFields
      : getSurfaceInputFieldNames(record.spec);
    const allowed = new Set(allowedFields);
    if (values) {
      for (const key of Object.keys(values)) {
        if (!allowed.has(key)) {
          return { valid: false, error: 'field_not_allowed', message: `Field "${key}" is not declared for this action` };
        }
      }
    }

    return { valid: true, action, record, allowedFields };
  }

  // ═══════════════════════════════════════════════════════════════
  // eventId 去重
  // ═══════════════════════════════════════════════════════════════

  /**
   * 原子预占业务事件。完成的事件可回放结果，处理中的事件拒绝并发重复提交。
   * @returns {{ accepted: true } | { accepted: false, status: 'processing'|'completed', result?: object }}
   */
  beginEvent(eventId) {
    const existing = this._seenEvents.get(eventId);
    if (existing) {
      // 命中时刷新 LRU 顺序。
      this._seenEvents.delete(eventId);
      this._seenEvents.set(eventId, existing);
      return {
        accepted: false,
        status: existing.status,
        ...(existing.result ? { result: existing.result } : {}),
      };
    }
    this._seenEvents.set(eventId, { timestamp: Date.now(), status: 'processing' });
    this._evictOldEvents();
    return { accepted: true };
  }

  completeEvent(eventId, result) {
    this._seenEvents.set(eventId, {
      timestamp: Date.now(),
      status: 'completed',
      result,
    });
    this._evictOldEvents();
  }

  /** 仅释放尚未完成的预占，使瞬时投递失败可以使用同一 eventId 安全重试。 */
  releaseEvent(eventId) {
    if (this._seenEvents.get(eventId)?.status === 'processing') {
      this._seenEvents.delete(eventId);
    }
  }

  /**
   * 检查 eventId 是否已见过。如果没见过，记录它。
   * @deprecated 新调用方应使用 beginEvent/completeEvent/releaseEvent。
   * @returns {boolean} true = 新事件，false = 重复
   */
  checkAndRecordEvent(eventId) {
    const reservation = this.beginEvent(eventId);
    if (!reservation.accepted) return false;
    this.completeEvent(eventId, {});
    return true;
  }

  _evictOldEvents() {
    if (this._seenEvents.size > EVENT_LRU_MAX) {
      // 处理中的事件是并发锁，不能为了容量上限提前逐出。
      const completed = Array.from(this._seenEvents.entries())
        .find(([, event]) => event.status === 'completed');
      if (completed) this._seenEvents.delete(completed[0]);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 会话清理
  // ═══════════════════════════════════════════════════════════════

  /**
   * 删除某 Agent 的全部 Surface。
   * 在 Agent 会话删除时调用。
   */
  clearAgent(agentId) {
    this._store.delete(agentId);
    this._registryRevisions.delete(agentId);
    const eventPrefix = `${agentId}\u0000`;
    for (const eventKey of this._seenEvents.keys()) {
      if (eventKey.startsWith(eventPrefix)) this._seenEvents.delete(eventKey);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // 内部方法
  // ═══════════════════════════════════════════════════════════════

  _getOrCreateAgent(agentId) {
    if (!this._store.has(agentId)) {
      this._store.set(agentId, new Map());
      this._registryRevisions.set(agentId, 1);
    }
    return this._store.get(agentId);
  }

  _countActive(agentSurfaces) {
    let count = 0;
    for (const r of agentSurfaces.values()) {
      if (r.status === 'active') count++;
    }
    return count;
  }

  _bumpRegistryRevision(agentId) {
    const current = this._registryRevisions.get(agentId) || 0;
    this._registryRevisions.set(agentId, current + 1);
  }

}

export { UISurfaceStore, computeContentHash };
