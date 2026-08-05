/**
 * Generative UI — 包根导出
 */

// 类型
export type {
  GenerativeUISpecV1,
  GenerativeUIElement,
  GenerativeUIAction,
  PrimitiveValue,
  UISurfaceRecord,
  UIRegistrySnapshot,
  UISurfaceSummary,
  SurfaceStatus,
  SurfaceTransport,
  UISurfaceUpsertInput,
  CloseResult,
  ValidationResult,
  GenerativeUISurfaceFeatureConfig,
  UISurfaceUpsertResponse,
  UISurfaceGetResponse,
  UISurfaceListResponse,
  UISurfaceCloseResponse,
  UIToolError,
  UISurfaceErrorCode,
} from './types.js';

export { UI_LIMITS } from './types.js';

// Catalog
export {
  CATALOG,
  getComponentTypes,
  isKnownComponent,
  getComponentSchema,
  acceptsChildren,
  generateCatalogDescription,
} from './catalog.js';
export type { ComponentSchema, PropSchema, PropType, ComponentCategory } from './catalog.js';

// Validator
export { validateGenerativeUISpec } from './validator.js';

// Transport
export { HttpSurfaceTransport } from './transport.js';

// Feature
export { GenerativeUISurfaceFeature } from './surface-feature.js';
