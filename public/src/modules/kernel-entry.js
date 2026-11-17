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
import './runtime-switch-host.js';
import './workspace-session-navigation-host.js';
import './workspace-entry-host.js';
import './compact-resume-host.js';
import './workspace-surface-host.js';
import './application-startup-host.js';
import './stream-draft-logic.js';
import './trim-ratio-core.js';
// P2 消费方批次模块的生产装载入口（原 index.html classic 标签已删除）。
// 放在最后：这些模块的桥键注册与 classic 相无交叉读写，与上面的宿主图之间
// 也不存在求值期依赖；顺序理由与逐批清单见 p2-entry.js 头注。
import './p2-entry.js';
