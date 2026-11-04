/**
 * plugin-manifest.js — APP 前端插件清单
 *
 * 宿主需要知道「哪个 APP 的界面在哪个模块里，才能按需装载」。插件文件本身
 * 无法在被加载之前声明自己，所以清单必须由宿主侧持有。
 *
 * 新增 APP 前端插件时在此登记一行；agentId 与 metadata.json 的 id 一致。
 */
window.ClawPluginManifest = {
  // url 相对站点根解析（不是相对某个模块文件），避免随调用点漂移
  memo: { id: 'memo', url: '/src/plugins/memo/index.js' },
  'claw-guide': { id: 'claw-guide', url: '/src/plugins/claw-guide/guide-docset.js' },
};

/** 返回该 agent 需要的插件描述，没有则返回 null。 */
window.resolveAgentPlugin = function resolveAgentPlugin(agentId) {
  const key = String(agentId || '');
  const entry = window.ClawPluginManifest[key];
  if (!entry) return null;
  return typeof entry === 'string' ? { id: key, url: entry } : { id: entry.id || key, url: entry.url };
};
