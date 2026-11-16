// Native ESM entry for kernel implementations. State owners are imported by
// their implementation hosts; classic bootstrap still runs at its original time.
import './session-view-commit-host.js';
import './runtime-status-loader-host.js';
import './session-data-loader-host.js';
import './poll-coordinator-host.js';
import './message-probe-host.js';
import './agent-loader-host.js';
import './runtime-view-cache-host.js';
import './call-interrupt-host.js';
import './agent-call-states-host.js';
import './agent-snapshot-loader-host.js';
import './time-format-host.js';
