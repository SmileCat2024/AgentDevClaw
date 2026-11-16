// Native ESM entry for kernel implementations. State owners are imported by
// their implementation hosts; classic bootstrap still runs at its original time.
import './agent-loader-host.js';
import './runtime-view-cache-host.js';
import './call-interrupt-host.js';
import './agent-call-states-host.js';
import './time-format-host.js';
