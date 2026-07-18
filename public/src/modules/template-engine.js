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

function parseToolResult(content) {
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
      return { success: json.success, data: data };
    }
    return { success: true, data: content };
  } catch (e) {
    return { success: true, data: content };
  }
}

/**
 * 根据模板名解析文件路径
 * 优先级：Feature 模板 > 系统模板 > 兜底
 */
const self = this;

// 系统默认模板映射（兜底）
// 格式：featureName/templateName
// 注意：这些映射仅在 FEATURE_TEMPLATE_MAP 中没有找到时使用
// 新增 feature 时应确保 feature 正确实现了 getPackageInfo() 和 getTemplateNames()
const SYSTEM_TEMPLATE_MAP = {
  // SubAgent Feature
  'agent-spawn': 'subagent/agent-spawn',
  'agent-list': 'subagent/agent-list',
  'agent-send': 'subagent/agent-send',
  'agent-close': 'subagent/agent-close',
  'wait': 'subagent/wait',
  // Skill Feature
  'skill': 'skill/skill',
  'invoke_skill': 'skill/skill',
  // OpencodeBasic Feature
  'read': 'opencode-basic/read',
  'write': 'opencode-basic/write',
  'edit': 'opencode-basic/edit',
  'ls': 'opencode-basic/ls',
  'glob': 'opencode-basic/glob',
  'grep': 'opencode-basic/grep',
  // Todo Feature
  'task-create': 'todo/task-create',
  'task-list': 'todo/task-list',
  'task-get': 'todo/task-get',
  'task-update': 'todo/task-update',
  'task-clear': 'todo/task-clear',
  // MCP Feature
  'mcp-tool': 'mcp/mcp-tool',
  'mcp-result': 'mcp/mcp-tool',
  // UserInput Feature
  'user-input': 'user-input/user-input',
};

function resolveTemplatePath(templateName) {
  // 1. 优先查找 Feature 模板（从后端注入的动态数据）
  if (FEATURE_TEMPLATE_MAP[templateName]) {
    return FEATURE_TEMPLATE_MAP[templateName];
  }

  // 2. 使用系统默认映射（统一 URL 格式）
  if (SYSTEM_TEMPLATE_MAP[templateName]) {
    const mapped = SYSTEM_TEMPLATE_MAP[templateName];
    // 系统内置模板使用 /template/agentdev/{feature}/{template}.render.js
    return '/template/agentdev/' + mapped + '.render.js';
  }

  // 3. 兜底：返回 null，让调用者等待或使用默认模板
  // 不再盲目生成错误的URL，而是等待 FEATURE_TEMPLATE_MAP 加载完成
  console.warn('[Viewer] Template "' + templateName + '" not found in FEATURE_TEMPLATE_MAP or SYSTEM_TEMPLATE_MAP, waiting...');
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
      const fallback = getTemplateFallback(templateName);
      if (fallback) {
        templateCache.set(templateName, fallback);
      }
      return fallback;
    }

    // 统一使用 URL 方式加载模板
    // Feature 模板: /template/agentdev/shell/bash.render.js
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
    const fallback = getTemplateFallback(templateName);
    if (fallback) {
      templateCache.set(templateName, fallback);
    }
    return fallback;
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
