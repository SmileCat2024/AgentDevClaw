// ── 通用输入清洗 ────────────────────────────────────────────────
//
// 从 project-store.ts 下沉：assertions 与 project-store 都需要它，原先
// assertions ← project-store（cleanValue）与 project-store ← assertions
// （normalizeTestCase）互为值导入，构成循环依赖。下沉后依赖单向：
// project-store → assertions → clean-value。

/** 字符串 trim 清洗；非字符串一律归空串。 */
export function cleanValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
