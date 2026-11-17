/**
 * boot.js — 首屏渲染链的 ESM 入口（P4 时序切换）。
 *
 * 背景：迁移前首屏由 app-main.js（classic，文档解析期执行）顶层同步调用
 * `applyTheme(currentTheme); applyLanguage();` 建立。classic 相早于一切模块求值，
 * 这使「首屏链上的每个函数」都必须保持 classic 实现，否则首屏会 ReferenceError
 * （见各文件头注的 R1 收敛条件，如 workspace-docset.js）。
 *
 * P4 裁决接受唯一行为变化：首屏渲染时点从 classic 逐标签同步相移到静态 ESM
 * 模块求值相（DOMContentLoaded 前）。本模块就是那条调用：classic 文件全部执行完
 * 之后，模块相再触发一次「主题 → 语言 → 侧栏 / 面板 / 主视图」同步渲染。
 *
 * 时相约束（改装载链前必读）：
 *   - 本模块必须是 index.html 中**最后一个** module 标签。它触发首屏渲染，而首屏
 *     链会触达其他已迁模块经桥注册的键（以及 `typeof` 守卫的 ESM 命名导出），
 *     因此必须晚于其余 module 入口求值。
 *   - 认证启动链不受影响：app-main.js 的 boot IIFE 仍在 classic 相注册，但它
 *     `await window.__clawAuthReady`，而认证初始化等 DOMContentLoaded，后者等
 *     静态非 async ESM 求值——因此 boot 一定先于 startApplication。
 *   - 主题闪烁由 index.html 的内联 `app-theme-bootstrap` 兜住（body 解析开始即把
 *     localStorage 主题落到 body[data-theme]），本模块不重复该职责。
 *
 * 依赖：`applyTheme` / `applyLanguage` 住在 i18n-environment-state（P4 T1 由
 * classic theme-lang 并入），本模块直接命名 import；它们内部的跨文件调用
 * （renderAgentList / renderCurrentMainView 等）仍是 classic 实现，经 window
 * 晚绑定——首屏链的 classic 残余随 T2 渲染层批次消化。
 */

import {
  applyTheme, applyLanguage, getCurrentTheme, bindStaticToggleButtons,
} from './i18n-environment-state.js';

applyTheme(getCurrentTheme());
applyLanguage();

// 首屏落定后才挂主题 / 语言按钮的 click：此前点击无效果，避免走进半就绪的
// 渲染链（见 bindStaticToggleButtons 的注释）。
bindStaticToggleButtons();
