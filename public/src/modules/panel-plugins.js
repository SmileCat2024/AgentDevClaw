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
  ];

  for (const d of DECLARATIONS) {
    try {
      window.ClawHost.panels.declare(d.id, d.meta, { pluginId: d.pluginId, url: d.url });
    } catch (err) {
      console.error('[panel-plugins] 懒面板声明失败：', d.id, err);
    }
  }
})();
