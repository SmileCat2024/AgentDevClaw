/**
 * P2 生产装载入口：已迁 ESM 的消费方批次模块。
 *
 * 为什么有这一层：这些模块原先各自占一条 index.html 的 classic `<script src>`
 * 标签，加载顺序就是它们的依赖顺序。P2 迁移把它们改成 ESM（命名导出 + 桥接期
 * KernelState 兼容键）后，classic 标签必须删除——classic 相解析含 import/export
 * 的文件会直接 SyntaxError。装载收口到本文件（一个入口，不产生入口碎片），由
 * kernel-entry.js 汇合，避免 index.html 出现几十条 module 标签。
 *
 * 时相（R4，改动前先读 ADR-0051 与《ESM 迁移配方》）：
 *   - 本模块与 kernel-entry 都是静态非 async module，浏览器在文档解析完成后、
 *     DOMContentLoaded 之前求值；因此所有 classic 脚本（含 app-core 的
 *     `createP2Bootstrap*Host` 工厂、markdown-bootstrap 的 renderer / escapeHtml、
 *     classic 文件在原声明位置 `defineKey` 注册的真初值）早已执行完。
 *   - 首屏同步链（app-main 顶层 `applyTheme → applyLanguage →
 *     renderCurrentMainView`）仍在 classic 相完成，不等待本模块；模块内被首屏
 *     链路间接触达的函数都有既有 `typeof` 守卫（见 test/p2-w1-4-classic-phase-guards）。
 *   - 桥键注册（defineKey/claim）发生在本模块执行相。逐文件已核实：模块求值期
 *     不存在此前置依赖的桥键读写，消费方触达点都在函数体内、调用时相更晚。
 *   - 认证启动（auth-client 的 DOMContentLoaded initialize → `__clawAuthReady` →
 *     app-main boot）排在本模块之后，因此下面的注册对 boot 首轮一定可见。
 *
 * 两层结构：
 *   1. 批次入口 —— 各批自带一个 bootstrap 入口文件（求值顺序、残余 classic 清单与
 *      注销条件写在各自头注里），本文件按批号顺序引入；
 *   2. 其余模块 —— 没有批次入口的全部已迁文件，按原 index.html 标签顺序排列
 *      （历史依赖顺序）。ESM 求值顺序 = 依赖图后序 + 本表顺序，跨模块依赖由各模块
 *      自己的 import 表达；本表只固定"无显式 import 边的相对装载顺序"，使桥键
 *      注册次序与迁移前一致。
 *
 * 不在本入口的边界（切勿顺手加）：
 *   - 悬置域（wg-* / im-* / dispatch-* / flow-editor / home-dashboard /
 *     resources-viewer）仍走 classic 标签，不在 P2 范围。
 *   - 混合文件（chat-viewport / runtime-status / input-composer / voice-input /
 *     input-helpers / input-render / persistent-input / rollback-dialog 等）的
 *     classic 主体仍是首屏同步实现（R1），标签保留；它们只把状态 owner 交给
 *     p2-w2-* 模块，owner 由本入口 / 批次入口装载。
 *   - 输入面的两个已迁域不在"仍 classic"之列：choice-input 的跨文件入口具名导出，
 *     由第二波 3b 入口带入（选择卡草稿状态已是该模块私有，classic 侧零读取，
 *     原 bootstrap 引用宿主已删除），input-model-switcher 在下面第 3 段显式
 *     import；两者的 classic 标签已从 index.html 删除。
 *   - thread-store（原 index.html 486）仍走 classic 标签：刷新引擎（状态 / 索引 /
 *     周期拉取 / 顶栏指示器）的三条同步调度必须原位注册，属 R4 残留；它的交互域
 *     thread-store-domain 是 ESM，经第 3 段 workspace-actions 的 import 链带入。
 *     workspace-actions 本身已迁 ESM，其 classic 标签已删除（见第 3 段）。
 *   - 调试面板按"classic-only 与 ESM"分裂，别整批当一类处理：debug-logs 与
 *     debug-features-hooks 仍是 classic 唯一实现（render / onOpen 入口由 app-ui
 *     的面板注册闭包持有，rail 按钮在 classic 相就可点，入口搬进 deferred ESM 会
 *     让早点击抛 ReferenceError），标签保留且**不要**由本入口 import；
 *     debug-overview / debug-preflight / debug-mcp 才是 ESM，走两个调试批次入口。
 *   - 仍是 classic 首屏同步实现的输入面文件（input-render / input-helpers /
 *     persistent-input / input-composer）经桥接期访问器读上述两域：裸标识符
 *     解析到 `defineKey` 注册的 window 属性，语义与迁移前一致。首屏无选中
 *     runtime，`renderPersistentInput → updateInputModelSwitcher()` 与 choice
 *     渲染分支都不在经典相触达。
 *   - template-engine / auto-title / message-timeline / agent-data-loader 经
 *     kernel-entry 的宿主图（agent-data-loader → 各 loader host）进入 ESM 图，
 *     原 classic 标签已删，这里不再重复 import。
 *
 * 撤除：index.html 收敛到 module 入口 + 悬置域（P3）后，本文件与 kernel-entry
 * 合并为单一入口，批次入口随批次收尾一并删除。
 */

// ── 1. 批次入口（按批号顺序；批内顺序见各自头注） ──
import './p2-w1-2-panel-bootstrap.js'; // 批次 2：右栏注册表与插件底座
import './p2-w2-3a-input-bootstrap.js'; // 第二波 3a：输入面状态 owner + 队列投影
import './p2-w2-3b-input-bootstrap.js'; // 第二波 3b：回退域 owner + APP 输入面
import './p2-w2-4-title-timeline-bootstrap.js'; // 第二波 4：模板 / overview / 标题 / 时间线
import './p2-w2-6-sidebar-session-bootstrap.js'; // 第二波 6：侧栏操作与会话状态
import './p2-w2-7-menu-session-bootstrap.js'; // 第二波 7：会话列表与菜单声明
import './p2-w2-7-context-menu-bootstrap.js'; // 第二波 7：上下文菜单开关与动作
import './p2-w2-8-project-domain-bootstrap.js'; // 第二波 8：编程小助手项目域
import './p2-w2-10-assembly-bootstrap.js'; // 第二波 10：装配工作台与表面块
import './p2-debug-small-bootstrap.js'; // 调试小批：装配预检 / MCP 面板
import './p2-w2-11-debug-deep-bootstrap.js'; // 第二波 11：调试总览面板

// ── 2. 生产兼容桥 / 状态 owner 宿主（批次交付时未附入口文件） ──
// p2-w2-1：process 窗口分级与整行实测窗口的 classic 消费面桥键（实现模块可重装，
// 注册只在此处发生一次，见文件头注）。
import './p2-w2-1-chat-windowing-host.js';
// p2-w2-2：runtime-status 域三个跨文件可变状态键的 owner（初值由 classic
// runtime-status.js 在原声明位置注册，这里 claim 吸收）。
import './p2-w2-2-runtime-status-owner.js';

// ── 3. 其余已迁模块（原 index.html classic 标签已删除） ──
// 原 index.html 413-479 段（配置 / 面板 / 工具）中未被批次入口覆盖的部分
import './speech-config-cache.js';
import './claw-select.js';
import './app-info.js';
import './usage-info-overlay.js';
import './speech-settings.js';
import './oauth-flow.js';
import './proxy-overlay.js';
import './workspace-settings.js';
import './model-settings.js';
import './mcp-gateway-ui.js';
import './remote-claw-settings.js';
import './context-guard-toggle.js';
import './conversation-export-dialog.js';
import './generative-ui-renderer.js';

// 原 index.html 480-500 段（表面块 / 右栏）
import './annotations.js';

// 原 index.html 476 段（Phase B 输入面）：choice-input 由第二波 3b 入口带入，
// 这里只补 input-model-switcher。两者之间仍是 classic 的 input-helpers /
// input-render / persistent-input 继续按原位置加载（见文件头"不在本入口的边界"）。
import './input-model-switcher.js';

// 原 index.html 501-517 段（Phase A：输入 / 会话引用 / 项目与线程）
// （session-reference-picker / ph-thread-history 走批次导入）

// 原 index.html 518-532 段（Phase B/C：会话变更 / 菜单 / 工具进度 / slash）
import './tool-progress.js';
// workspace-actions（原 index.html 485 段）：整文件已迁 ESM，classic 标签删除。
// 唯一桥键 runWorkspaceAction 继续服务 classic 消费方（app-main / app-ui /
// thread-store / 悬置域）；thread-store 自身仍是 classic 刷新引擎，不在此入口。
import './workspace-actions.js';
import './slash-menu.js';
import './slash-commands.js';

// 原 index.html 533-551 段（Phase D：聊天渲染 / 侧栏会话 / SSE / feature 通道）
import './chat-row-visibility.js';
import './lazy-tool-content.js';
import './workspace-agents.js';
import './runtime-mode-menu.js';
import './chat-nav-timeline.js';
import './session-readonly-view.js';
import './sse-client.js';
import './feature-communication.js';
