/**
 * desktop-open.js — Windows 右键菜单唤起请求（desktop/installer-hooks.nsh 注册）
 *
 * 「在编程小助手中打开 / 创建会话」在文件夹空白处 / 桌面空白处右键触发，
 * 两条到达路径汇入同一消费入口 window.__clawConsumeOpenRequest：
 *   冷启动（应用未运行）：注册表命令启动 exe，壳把 --claw-open=<dir> /
 *     --claw-new-chat=<dir> 拼进窗口 URL query；boot 序列 loadAgents 后由
 *     ClawDesktopOpen.consumeBootOpenRequest() 消费并清理 URL
 *   已运行：single-instance 插件转发第二实例 argv，壳经 webview eval 调用
 *     本模块的消费入口（窗口可能处于托盘隐藏态，eval 仍可达）
 *
 * 动作语义（目标工作空间固定为编程小助手）：
 *   open     → handlePrebuiltAgentClick 切工作空间 + phOpenProjectDirectory 定位目录
 *   new-chat → handlePrebuiltAgentClick 切工作空间 + create_session 以该目录新建对话
 */

// URL query 键与动作名（与 desktop/src/main.rs 的 parse_open_request 保持一致）
const OPEN_QUERY_KEYS = { 'claw-open': 'open', 'claw-new-chat': 'new-chat' };
const OPEN_ACTIONS = new Set(Object.values(OPEN_QUERY_KEYS));

// 纯函数：从 URL query 解析一次性唤起请求（冷启动路径）。
// URLSearchParams 自动做 percent 解码；空白目录视为无请求。
function parseOpenRequestFromSearch(search) {
  try {
    const params = new URLSearchParams(String(search || ''));
    for (const key of Object.keys(OPEN_QUERY_KEYS)) {
      const raw = params.get(key);
      if (raw == null) continue;
      const cwd = String(raw).trim();
      if (cwd) return { action: OPEN_QUERY_KEYS[key], cwd };
    }
  } catch { /* malformed query：按无请求处理 */ }
  return null;
}

function normalizeOpenRequest(raw) {
  if (!raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  const action = String(obj?.action || '').trim();
  const cwd = String(obj?.cwd || '').trim();
  if (!OPEN_ACTIONS.has(action) || !cwd) return null;
  return { action, cwd };
}

// 动作链涉及工作空间切换与会话创建，必须串行：进行中收到的新请求排队，
// 只保留最新一条（快速连点右键时旧请求让位）。
let _openRequestRunning = false;
let _queuedOpenRequest = null;

async function runOpenRequest(request) {
  if (typeof window.handlePrebuiltAgentClick !== 'function') return;
  try {
    await window.handlePrebuiltAgentClick('programming-helper');
    if (request.action === 'new-chat') {
      await window.runWorkspaceAction(JSON.stringify({
        type: 'create_session',
        openDirectory: request.cwd,
      }));
    } else {
      await window.phOpenProjectDirectory(request.cwd);
    }
  } catch (error) {
    console.error('[desktop-open] open request failed:', error);
  }
}

// 桌面壳 webview eval 的统一入口（也接受 boot 传来的对象）
window.__clawConsumeOpenRequest = async (rawRequest) => {
  const request = normalizeOpenRequest(rawRequest);
  if (!request) return;
  if (_openRequestRunning) {
    _queuedOpenRequest = request;
    return;
  }
  _openRequestRunning = true;
  try {
    await runOpenRequest(request);
  } finally {
    _openRequestRunning = false;
    if (_queuedOpenRequest) {
      const next = _queuedOpenRequest;
      _queuedOpenRequest = null;
      window.__clawConsumeOpenRequest(next);
    }
  }
};

// boot 消费：读当前 URL query，命中即先清理 URL（刷新 / 复制链接不重复
// 触发）再执行动作。由 app-main.js 的 boot 序列在 loadAgents 后调用。
async function consumeBootOpenRequest() {
  const request = parseOpenRequestFromSearch(window.location?.search || '');
  if (!request) return;
  try {
    history.replaceState(null, '', window.location.pathname);
  } catch { /* 无 history 环境（测试沙箱）忽略 */ }
  await window.__clawConsumeOpenRequest(request);
}

window.ClawDesktopOpen = { consumeBootOpenRequest, parseOpenRequestFromSearch };
