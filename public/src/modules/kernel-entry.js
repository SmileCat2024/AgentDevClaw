// Native ESM entry for kernel implementations. State owners are imported by
// their implementation hosts; classic bootstrap still runs at its original time.
import './session-view-commit-host.js';
import './runtime-status-loader-host.js';
import './session-data-loader-host.js';
import './poll-coordinator-host.js';
import './message-probe-host.js';
import './metadata-commit-host.js';
import './runtime-poll-host.js';
import './poll-cycle-host.js';
import './agent-loader-host.js';
import './runtime-view-cache-host.js';
import './call-interrupt-host.js';
import './agent-call-states-host.js';
import './agent-snapshot-loader-host.js';
import './time-format-host.js';
// P4 T1 原料层：i18n 域的 t 桥键（实现见 ../i18n.js）。模块相注册即可——
// classic 相已无 t 的加载期调用（首屏由 boot 在模块相触发）。
import './i18n-host.js';
import './runtime-switch-host.js';
import './workspace-session-navigation-host.js';
import './workspace-entry-host.js';
import './compact-resume-host.js';
// workspace-surface-host 随 app-ui 批进入 p4-entry（求值期取 app-ui 的宿主工厂，
// 必须在 app-ui 之后求值）。
import './application-startup-host.js';
import './stream-draft-logic.js';
import './trim-ratio-core.js';
// P2 消费方批次模块的生产装载入口（原 index.html classic 标签已删除）。
// 放在最后：这些模块的桥键注册与 classic 相无交叉读写，与上面的宿主图之间
// 也不存在求值期依赖；顺序理由与逐批清单见 p2-entry.js 头注。
// P4（活跃域 classic 清零）批次入口：时序切换后新迁移的域。必须排在 p2-entry 之前：
// P2 图里的消费方会在求值期经桥键取用 P4 提供的能力（如 thread-store-domain 装载时
// 调 window.createThreadStoreHost()、chat-window 链取 chat-viewport 的锚点函数）。
import './p4-entry.js';
import './p2-entry.js';
