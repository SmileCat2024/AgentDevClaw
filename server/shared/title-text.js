/**
 * 标题文本的规范化与校验（ADR-0041）。
 *
 * 单一真源：服务端能力层（写入前校验）与镜像子进程（模型输出清洗）共用
 * 同一套规则，避免两处各自演进后出现"能生成但写不进去"或反过来的漂移。
 *
 * 本模块必须保持无依赖纯函数：mirror 子进程会导入它，不应因此牵入
 * session-access / sqlite 等 server 侧资源。
 */

export const MAX_TITLE_LENGTH = 60;

/**
 * 规范化一个候选标题。
 *
 * 规则与改造前 sanitizeGeneratedTitle 逐项一致（去包裹引号、去句末标点、
 * 压空白、取首段、截断 60 字符），既有的模型输出清洗行为不变。
 * 标题是跨应用共享的导航信息，格式边界由 OS 统一，应用追求的特殊格式
 * 由展示层承担，不放宽这里。
 *
 * @returns {{ ok: true, title: string } | { ok: false, reason: string }}
 */
export function validateTitleText(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'title must be a string' };
  }
  // 编码损坏的标题入库即脏数据，在入口拒绝而不是存下来再想办法修。
  if (raw.includes('\uFFFD')) {
    return {
      ok: false,
      reason: 'title 含无效编码字符（U+FFFD），通常由控制台代码页转码造成',
    };
  }
  const line = raw
    .trim()
    .replace(/^["“”'‘’«»]+|["“”'‘’«»]+$/g, '')
    .replace(/[。！？!?,，、:：;；]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) {
    return { ok: false, reason: 'title must be non-empty' };
  }
  return { ok: true, title: line.slice(0, MAX_TITLE_LENGTH) };
}

/**
 * 兼容旧调用点的形态：只取标题文本，无效返回空串。
 * 新代码用 validateTitleText 以拿到失败原因。
 */
export function sanitizeTitleText(raw) {
  const result = validateTitleText(raw);
  return result.ok ? result.title : '';
}
