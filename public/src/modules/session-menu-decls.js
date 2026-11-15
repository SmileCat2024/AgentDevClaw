/**
 * session-menu-decls.js — 会话菜单的应用声明面（ADR-0049）
 *
 * 职责三件：
 *   - sessionOpsAllowed(ns)：sessionOps 产品事实的单一来源。菜单
 *     （ctx-menu-items.js）与 slash 命令（slash-commands.js）都从这里读，
 *     代码内白名单已退役。
 *   - getDeclaredSessionMenuItems(ns, facts)：APP 声明的自定义菜单项
 *     （metadata ui.sessionMenu.items），谓词过滤后供宿主在内建族之后追加。
 *   - 谓词词表：v1 三个（not-archived / has-thread / thread-busy），宿主
 *     求值；服务端扫描（agent-discovery）是校验边界，此处对未知谓词兜底
 *     跳项并告警。词表权威面是服务端导出
 *     （server/shared/session-menu-registry.js），本模块内联镜像、同步修改。
 *
 * 声明来源（两源一汇）：
 *   - prebuilt APP：metadata.json 经 agent-discovery 归一后随 agent 记录
 *     下发（...metadata 展开），无新增传输。
 *   - 外部插件 APP（ADR-0049 P3，按需后置）：manifest v3 ui.sessionMenu
 *     facet 经声明合成通道下发，届时在此合并。
 *
 * 依赖全局状态（定义在 app-core.js）：
 *   allAgents, currentLanguage
 * 依赖 app-core.js / remote 模块：
 *   isRemoteNamespaceAgentId
 * 依赖 remote-connections.js（可选，运行期探测）：
 *   window.RemoteConnections.capabilityFor
 */

function _sessionMenuAgentRecord(agentId) {
  if (typeof allAgents === 'undefined' || !Array.isArray(allAgents)) return null;
  return allAgents.find((item) => item?.id === agentId) || null;
}

function _sessionMenuIsRemoteNs(ns) {
  return typeof isRemoteNamespaceAgentId === 'function' && isRemoteNamespaceAgentId(ns);
}

// sessionOps 事实（ADR-0049）：
//   - 本地 ns：读 agent 记录的 metadata 声明（sessionOps === true）。
//   - 远程 ns（remote:<connId>:<hostAgentId>）：内层宿主 id 查本地同名 APP
//     镜像记录（远程主机跑同一批 prebuilt APP 的同版本假设，与旧白名单
//     同源），再受握手能力位 sessionOps 门控（ADR-0011：旧远程缺位时
//     降级隐藏）。connId 不含冒号（request-target 不变量），第二个冒号
//     之后即宿主 agent id。
function sessionOpsAllowed(ns) {
  if (typeof ns !== 'string' || !ns) return false;
  if (!_sessionMenuIsRemoteNs(ns)) {
    return _sessionMenuAgentRecord(ns)?.sessionOps === true;
  }
  const innerId = ns.split(':').slice(2).join(':');
  if (_sessionMenuAgentRecord(innerId)?.sessionOps !== true) return false;
  if (typeof window !== 'undefined' && window.RemoteConnections && typeof window.RemoteConnections.capabilityFor === 'function') {
    return window.RemoteConnections.capabilityFor(ns, 'sessionOps') === true;
  }
  return true;
}

// label {zh, en} 纯数据按当前语言解析，缺失时回退另一语言（与
// feature-ui-registry 的 toHostMeta 同款语义）。
function _resolveSessionMenuLabel(label) {
  if (!label || typeof label !== 'object') return '';
  const lang = (typeof currentLanguage !== 'undefined' && currentLanguage) || 'zh';
  return String(label[lang] || label.zh || label.en || '');
}

// APP 声明的自定义菜单项，谓词过滤后返回渲染形状 [{label, action, danger}]。
// facts 由宿主求值传入：{ archived, hasThread, threadBusy }。
// v1 边界（ADR-0049 取舍）：远程叶子不呈现自定义项（处理器在本机）；
// 未知谓词按声明错误处理——项跳过并告警，不静默通过。
function getDeclaredSessionMenuItems(ns, facts) {
  if (typeof ns !== 'string' || !ns) return [];
  if (_sessionMenuIsRemoteNs(ns)) return [];
  const declared = _sessionMenuAgentRecord(ns)?.ui?.sessionMenu?.items;
  if (!Array.isArray(declared) || declared.length === 0) return [];
  const evaluated = typeof facts === 'object' && facts !== null ? facts : {};
  // 谓词词表镜像（v1）：与 server/shared/session-menu-registry.js 同步修改。
  const knownPredicates = new Set(['not-archived', 'has-thread', 'thread-busy']);
  const items = [];
  for (const entry of declared) {
    if (!entry || typeof entry !== 'object') continue;
    const label = _resolveSessionMenuLabel(entry.label);
    if (!label || typeof entry.action !== 'string' || !entry.action) continue;
    const when = Array.isArray(entry.when) ? entry.when : [];
    let passes = true;
    for (const predicate of when) {
      if (!knownPredicates.has(predicate)) {
        passes = false;
        console.warn(`[session-menu] unknown predicate "${predicate}" on item "${entry.id || '(no id)'}" (${ns}); item skipped`);
        break;
      }
      if (predicate === 'not-archived' && evaluated.archived === true) { passes = false; break; }
      if (predicate === 'has-thread' && evaluated.hasThread !== true) { passes = false; break; }
      if (predicate === 'thread-busy' && evaluated.threadBusy !== true) { passes = false; break; }
    }
    if (!passes) continue;
    items.push({
      label,
      action: entry.action,
      danger: entry.danger === true,
    });
  }
  return items;
}
