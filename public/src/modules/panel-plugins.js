/**
 * panel-plugins.js — 面板插件清单（ADR-0044 P3/P4）
 *
 * 面板实现按需装载的声明处。每条声明注册一个 stub 占位：rail 按钮与
 * 显隐过滤（when）在实现模块装载前即可用；用户打开面板时编排层
 * （debug-panel-host）触发 ensurePlugin 按需拉取实现模块，装载完成
 * 后 real 替换 stub 进入正常渲染。实现模块是 ES 模块插件（claw-host
 * 协议：export default { id, panels, mount, unmount }），放在
 * public/src/panel-plugins/ 下。
 *
 * 声明字段：
 *   id       面板 id（与实现模块 panels 声明的键一致）
 *   pluginId 插件 id（与实现模块 export default 的 id 一致）
 *   url      实现模块 URL（相对站点根）
 *   meta     面板元数据：icon / order / label / description / title /
 *            when / badge——与 panels.register 的元数据同构（不含
 *            render/mountBody，那是实现模块的事）
 *
 * 登记纪律：P4 存量迁移时每迁一个面板，把 index.html 的静态 script
 * 标签删除、在此登记一条、更新金样本住址与门禁基线。
 */
(function () {
  'use strict';

  const DECLARATIONS = [
    {
      id: 'session-controls',
      pluginId: 'panel-session-controls',
      url: '/src/panel-plugins/session-controls.js',
      meta: {
        when: { surfaces: ['chat'] },
        title: () => currentLanguage === 'zh' ? '会话控制' : 'Session Controls',
        label: { zh: '会话控制', en: 'Session Controls' },
        description: { zh: 'API 重试与输出风格', en: 'API retries and output styles' },
        icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"> <path d="M21 12a9 9 0 1 1-2.64-6.36"></path> <path d="M21 3v6h-6"></path> </svg>',
        order: 20,
      },
    },
    {
      id: 'git',
      pluginId: 'panel-git',
      url: '/src/panel-plugins/git.js',
      meta: {
        when: { surfaces: ['chat'] },
        title: () => currentLanguage === 'zh' ? '源代码管理' : 'Source Control',
        label: { zh: '源代码管理', en: 'Source Control' },
        description: { zh: 'Git 状态与操作', en: 'Git status and operations' },
        icon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"> <circle cx="6" cy="6" r="2.6"></circle> <circle cx="6" cy="18" r="2.6"></circle> <circle cx="18" cy="8" r="2.6"></circle> <path d="M6 8.6v6.8"></path> <path d="M18 10.6c0 4-4.5 3.4-8 4.5"></path> </svg>',
        order: 30,
      },
    },
    {
      // Agentero 文献库（ADR-0044 P6 样本）：React 容器型面板，产物经
      // npm run build:react-panels 生成（src/index.tsx → dist/index.js）。
      // when 不限 surface：vault 配置与 agent 无关，任意界面可查文献。
      id: 'agentero-library',
      pluginId: 'agentero-library',
      url: '/src/plugins/agentero-library/dist/index.js',
      meta: {
        title: () => currentLanguage === 'zh' ? '文献' : 'Library',
        label: { zh: '文献', en: 'Library' },
        description: { zh: 'Agentero 研究 vault 论文库（只读）', en: 'Agentero vault papers (read-only)' },
        icon: '<svg width="18" height="18" viewBox="0 0 36 36" fill="none"> <rect x="8" y="7" width="20" height="22" rx="2" stroke="#8AB4F8" stroke-width="2"></rect> <path d="M13 14h10M13 19h10M13 24h6" stroke="#8AB4F8" stroke-width="2" stroke-linecap="round"></path> </svg>',
        order: 92,
      },
    },
  ];

  for (const d of DECLARATIONS) {
    try {
      window.ClawHost.panels.declare(d.id, d.meta, { pluginId: d.pluginId, url: d.url });
    } catch (err) {
      console.error('[panel-plugins] 懒面板声明失败：', d.id, err);
    }
  }
})();
