// template-engine.js
// Phase 2d-2: 模板引擎 / 工具渲染（Domain O-b）
// 从 app-ui.js 提取的模板加载、解析与渲染函数

// 默认 fallback 模板（当动态加载失败时使用）
const RENDER_TEMPLATES = {
  'math': {
    call: (args) => {
      const expression = args?.expression ?? args?.input ?? JSON.stringify(args ?? {});
      return `<div class="bash-command">${escapeHtml(String(expression))}</div>`;
    },
    result: (data, success) => {
      if (!success) return formatError(data);
      const value = typeof data === 'object' && data !== null && 'result' in data ? data.result : data;
      if (typeof value === 'string') return `<pre class="bash-output">${escapeHtml(value)}</pre>`;
      return renderJsonHighlight(value);
    }
  },
  'user-input': {
    call: (args) => renderJsonHighlight(args),
    result: (data, success) => {
      if (!success) return formatError(data);
      if (typeof data === 'string') return `<pre class="bash-output">${escapeHtml(data)}</pre>`;
      return renderJsonHighlight(data);
    }
  },
  'json': {
    call: (args) => renderJsonHighlight(args),
    result: (data, success) => {
      if (!success) return formatError(data);
      return renderJsonHighlight(data);
    }
  }
};

// 模板缓存
const templateCache = new Map();

// 焦点 runtime 切换时清空模板缓存（agent-data-loader.js 调用）：
// FEATURE_TEMPLATE_MAP 按焦点 agent 重新拉取，同名模板可能指向不同 mount。
// /tpl/ URL 本身按注册事实寻址（跨 agent 同 mount 的 URL 相同），此清空属防御性，
// 避免任何残留映射错误。内置模板（RENDER_TEMPLATES）随后按需重建，无副作用。
function clearFeatureTemplateCache() {
  templateCache.clear();
}

// DOM node budget: each line generates 3 nodes (div + 2 spans). For 500-line tool
// results that's 1500 nodes, most invisible (collapsed to 160px). Cap at 200 lines
// and offer "click to expand" to keep the DOM lean while preserving data access.
const MAX_HIGHLIGHT_LINES = 200;
const _fullHighlightData = new Map();
let _highlightIdCounter = 0;

function clearTruncatedHighlightData() {
  _fullHighlightData.clear();
}

function renderJsonHighlight(data) {
  const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  const lines = displayData.split('\n');
  const isTruncated = lines.length > MAX_HIGHLIGHT_LINES;
  const effectiveLines = isTruncated ? lines.slice(0, MAX_HIGHLIGHT_LINES) : lines;

  let html = '<div class="code-read-container">' + effectiveLines.map((line, i) => {
    let highlighted;
    try { highlighted = hljs.highlight(line, { language: 'json' }).value; }
    catch (e) { highlighted = escapeHtml(line); }
    return '<div class="code-read-line"><span class="code-read-line-num">' + (i + 1) + '</span><span class="code-read-content">' + highlighted + '</span></div>';
  }).join('');

  if (isTruncated) {
    const id = 'trunc-' + (++_highlightIdCounter);
    _fullHighlightData.set(id, data);
    const remaining = lines.length - MAX_HIGHLIGHT_LINES;
    html += '<div class="code-read-truncated" data-expand-id="' + id + '" onclick="expandTruncatedResult(this)">'
      + '&hellip; ' + remaining + ' more lines (click to expand)</div>';
  }

  html += '</div>';
  return html;
}

function expandTruncatedResult(el) {
  const id = el.getAttribute('data-expand-id');
  const data = _fullHighlightData.get(id);
  if (!data) return;

  const container = el.closest('.code-read-container');
  if (!container) return;

  const displayData = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
  const lines = displayData.split('\n');
  container.innerHTML = lines.map((line, i) => {
    let highlighted;
    try { highlighted = hljs.highlight(line, { language: 'json' }).value; }
    catch (e) { highlighted = escapeHtml(line); }
    return '<div class="code-read-line"><span class="code-read-line-num">' + (i + 1) + '</span><span class="code-read-content">' + highlighted + '</span></div>';
  }).join('');

  _fullHighlightData.delete(id);
}

function getTemplateFallback(templateName) {
  return RENDER_TEMPLATES[templateName] || RENDER_TEMPLATES['json'] || null;
}

function formatError(data) {
   const text = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
   return `<div class="tool-error">
     <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
     <span>${escapeHtml(text)}</span>
   </div>`;
}

function interpolateTemplate(template, data) {
  return template.replace(/{{(\w+)}}/g, (_, key) => {
    const value = data[key];
    return value !== undefined ? String(value) : `{{${key}}}`;
  });
}

function applyTemplate(template, data, success = true, args = {}) {
  if (typeof template === 'function') {
    return template(data, success, args);
  }
  // 处理内联模板对象 { call: ..., result: ... }
  if (typeof template === 'object' && template !== null) {
    const fn = template.result || template.call;
    if (typeof fn === 'function') {
      return fn(data, success, args);
    }
    if (typeof fn === 'string') {
      return interpolateTemplate(fn, data);
    }
  }
  return interpolateTemplate(template, data);
}

function parseToolResult(content, display) {
  let result;
  try {
    const json = JSON.parse(content);
    if (json && typeof json === 'object' && 'success' in json && 'result' in json) {
      let data = json.result;
      // Try to unwrap double-encoded JSON strings
      if (typeof data === 'string') {
         try {
            if (data.trim().startsWith('"') || data.trim().startsWith('{') || data.trim().startsWith('[')) {
                const parsed = JSON.parse(data);
                data = parsed;
            }
         } catch (e) {
            // Not a JSON string, keep as is
         }
      }
      result = { success: json.success, data: data };
    } else {
      result = { success: true, data: content };
    }
  } catch (e) {
    result = { success: true, data: content };
  }
  // Merge display-only data (e.g. write tool's diff) that bypassed LLM injection
  if (display && typeof display === 'object') {
    result.data = typeof result.data === 'object' && result.data !== null
      ? { ...result.data, ...display }
      : { ...display };
  }
  return result;
}

/**
 * 根据模板名解析文件路径
 * 模板 URL 由 ViewerWorker 从注册事实生成（/tpl/{mountId}/{rel}），不透明、不含布局知识。
 * 未注册的模板名一律等待 FEATURE_TEMPLATE_MAP 加载，不做任何本地路径推断。
 */
const self = this;

function resolveTemplatePath(templateName) {
  // 1. 查找 Feature 模板（从后端注入的动态数据）
  if (FEATURE_TEMPLATE_MAP[templateName]) {
    return FEATURE_TEMPLATE_MAP[templateName];
  }

  // 2. 兜底：返回 null，让调用者等待或使用默认模板
  // 模板缺失本质是装配缺陷，应被看见而不是被本地猜测掩盖
  console.warn('[Viewer] Template "' + templateName + '" not found in FEATURE_TEMPLATE_MAP, waiting...');
  return null;
}

/**
 * 异步加载模板
 * 支持从 Feature 目录或系统目录加载
 * 如果加载失败，回退到内置模板
 */
async function loadTemplate(templateName, retryCount = 0) {
  if (templateCache.has(templateName)) {
    return templateCache.get(templateName);
  }

  // 优先检查内置模板（json 是内置的）
  if (RENDER_TEMPLATES[templateName]) {
    templateCache.set(templateName, RENDER_TEMPLATES[templateName]);
    return RENDER_TEMPLATES[templateName];
  }

  try {
    const path = resolveTemplatePath(templateName);

    // 如果 path 为 null，说明 FEATURE_TEMPLATE_MAP 还未加载完成
    if (!path) {
      // 最多重试 3 次，每次等待 500ms
      if (retryCount < 3) {
        console.log('[Viewer] Waiting for FEATURE_TEMPLATE_MAP to load... (attempt ' + (retryCount + 1) + ')');
        await new Promise(resolve => setTimeout(resolve, 500));
        // 重新加载模板映射
        await loadFeatureTemplateMap();
        return loadTemplate(templateName, retryCount + 1);
      }
      console.warn('[Viewer] Template "' + templateName + '" not found after retries');
      // 回退到内置模板但不写入缓存，下次渲染重试真实模板
      return getTemplateFallback(templateName);
    }

    // 统一使用 URL 方式加载模板（URL 由服务端注册事实生成，不透明）
    const module = await import(window.__PROTOCLAW_APP_URL__?.(path) || path);

    // 1. 优先使用 default export（Feature 模板）
    let template = module.default;
    if (template) {
      templateCache.set(templateName, template);
      return template;
    }

    // 2. 尝试从 TEMPLATES 对象获取（系统模板）
    if (module.TEMPLATES && module.TEMPLATES[templateName]) {
      template = module.TEMPLATES[templateName];
      templateCache.set(templateName, template);
      return template;
    }

    console.warn('[Viewer Worker] 模板 "' + templateName + '" 在文件中未找到');
    return null;
  } catch (e) {
    console.warn('[Viewer Worker] 加载模板失败: ' + templateName, e);
    // 回退到内置模板但不写入缓存，下次渲染重试真实模板
    return getTemplateFallback(templateName);
  }
}

function collectTemplateNames(tools) {
  const templatesToLoad = new Set();

  for (const tool of tools) {
    const renderConfig = tool.render;
    if (!renderConfig) continue;

    if (typeof renderConfig === 'string') {
      templatesToLoad.add(renderConfig);
      continue;
    }

    if (typeof renderConfig === 'object') {
      if (renderConfig.call && renderConfig.call !== '__inline__') {
        templatesToLoad.add(renderConfig.call);
      }
      if (renderConfig.result && renderConfig.result !== '__inline__') {
        templatesToLoad.add(renderConfig.result);
      }
    }
  }

  return Array.from(templatesToLoad);
}

function warmTemplatesInBackground(templateNames, agentId) {
  if (!Array.isArray(templateNames) || templateNames.length === 0) {
    return;
  }

  const warmupToken = ++templateWarmupToken;
  Promise.all(templateNames.map(name => loadTemplate(name)))
    .then(() => {
      if (warmupToken !== templateWarmupToken || currentRuntimeAgentId !== agentId) {
        return;
      }
      // Force a full re-render: messages rendered before templates were
      // loaded may have fallen back to JSON. Clearing the dedup signature
      // ensures render() rebuilds all rows with the correct templates.
      if (typeof _lastRenderedChatSig !== 'undefined') {
        _lastRenderedChatSig = '';
      }
      renderCurrentMainView();
    })
    .catch((error) => {
      console.warn('[Viewer] Background template warmup failed:', error);
    });
}

function getToolRenderTemplate(toolName) {
  const config = toolRenderConfigs[toolName];
  const callTemplateName = (config?.render?.call) || 'json';
  const resultTemplateName = (config?.render?.result) || 'json';

  const callIsInline = callTemplateName === '__inline__';
  const resultIsInline = resultTemplateName === '__inline__';

  let callTemplate, resultTemplate;

  if (callIsInline) {
    callTemplate = config?.render?.inlineCall;
  } else {
    // 优先从缓存读取
    const cached = templateCache.get(callTemplateName);
    callTemplate = cached?.call || RENDER_TEMPLATES['json'].call;
  }

  if (resultIsInline) {
    resultTemplate = config?.render?.inlineResult;
  } else {
    const cached = templateCache.get(resultTemplateName);
    resultTemplate = cached?.result || RENDER_TEMPLATES['json'].result;
  }

  return {
    call: callTemplate,
    result: resultTemplate,
    isInlineCall: callIsInline,
    isInlineResult: resultIsInline,
  };
}

function getToolDisplayName(toolName) {
  if (!toolName) return 'Tool';
  return TOOL_NAMES[toolName] || toolName;
}

function getAgentRuntimeId(agent) {
  return agent.runtime_session_id || agent.runtimeSessionId || agent.id;
}

function getAgentDisplayId(agent) {
  if (isWorkspaceSurfaceUnit(agent)) {
    return '工作空间';
  }
  if (agent.source === 'prebuilt') {
    return agent.runtime_session_id ? '已启动' : '未启动';
  }
  return getAgentRuntimeId(agent);
}
