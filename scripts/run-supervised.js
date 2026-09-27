#!/usr/bin/env node
// Starts the service and records health/lifecycle events. This process is
// deliberately observational: health failures and elapsed time never grant it
// authority to stop or kill the server or any descendant process.

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SERVER_ENTRY = path.join(__dirname, '..', 'server.js');
const GRACE_MS = Number.parseInt(process.env.CLAW_SUPERVISOR_GRACE_MS || '', 10) || 10_000;

// Lifecycle events survive terminal output loss; failures to write diagnostics
// must never affect the service.
const LOG_FILE = (() => {
  const override = (process.env.CLAW_SUPERVISOR_LOG || '').trim();
  if (override.toLowerCase() === 'off') return null;
  if (override) return override;
  const dataDir = (process.env.AGENTDEV_DATA_DIR || '').trim();
  const dataRoot = dataDir
    ? path.resolve(dataDir)
    : path.join(os.homedir(), '.agentdev', 'AgentDevClaw');
  return path.join(dataRoot, 'logs', 'supervisor.log');
})();

function persistEvent(event) {
  if (!LOG_FILE) return;
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${new Date().toISOString()} [pid ${process.pid}] ${event}\n`, 'utf8');
  } catch { /* diagnostics are best-effort */ }
}

const childCommand = process.env.CLAW_SUPERVISED_CMD
  ? process.env.CLAW_SUPERVISED_CMD.split(' ').filter(Boolean)
  : [process.execPath, DEFAULT_SERVER_ENTRY];

const child = spawn(childCommand[0], childCommand.slice(1), {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, CLAW_SUPERVISED: '1' },
});
persistEvent(`supervisor started: pid ${process.pid}, child pid ${child.pid}, cmd ${childCommand.join(' ')}`);

let stopRequested = false;
let reportTimer = null;

function requestGracefulStop(reason) {
  if (stopRequested || child.exitCode !== null) return;
  stopRequested = true;
  console.log(`[supervisor] ${reason}; requesting graceful service shutdown`);
  persistEvent(`graceful shutdown requested: ${reason}`);

  // This is only reached after an explicit process signal. No probe result or
  // timeout calls it. The service owns its own orderly shutdown; this host does
  // not send OS kill signals and does not reap process trees.
  const port = Number.parseInt(process.env.PORT || '1420', 10);
  fetch(`http://127.0.0.1:${port}/protoclaw/shutdown`, {
    method: 'POST',
    headers: { Origin: `http://127.0.0.1:${port}` },
    signal: AbortSignal.timeout(1500),
  }).catch(() => {});

  reportTimer = setTimeout(() => {
    if (child.exitCode === null) {
      const message = `service has not exited ${GRACE_MS}ms after explicit shutdown request; leaving it untouched`;
      console.warn(`[supervisor] ${message}`);
      persistEvent(message);
    }
  }, GRACE_MS);
  reportTimer.unref?.();
}

process.on('SIGINT', () => requestGracefulStop('interrupt received'));
process.on('SIGTERM', () => requestGracefulStop('terminate received'));
process.on('SIGHUP', () => requestGracefulStop('hangup received'));

// Read-only health observation for diagnostics. A slow, unreachable, or
// shutting-down server is never a reason for the supervisor to stop it.
const healthPort = Number.parseInt(process.env.PORT || '1420', 10);
const healthIntervalMs = Number.parseInt(process.env.CLAW_SUPERVISOR_HEALTH_MS || '', 10) || 2000;
const healthProbeTimeoutMs = Number.parseInt(process.env.CLAW_SUPERVISOR_PROBE_MS || '', 10) || 3000;
let healthReadySeen = false;
let unreachableSince = null;

async function probeHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), healthProbeTimeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${healthPort}/protoclaw/health`, { signal: controller.signal });
    if (unreachableSince !== null) {
      persistEvent(`health reachable again after ${Date.now() - unreachableSince}ms`);
      unreachableSince = null;
    }
    if (response.ok) {
      healthReadySeen = true;
      return;
    }
    let state = '';
    try { state = (await response.json())?.state || ''; } catch { /* log unknown response */ }
    if (state === 'shutting_down') persistEvent('health reports shutting_down');
  } catch {
    if (!healthReadySeen || unreachableSince !== null) return;
    unreachableSince = Date.now();
    persistEvent('health unreachable after ready (observation only)');
  } finally {
    clearTimeout(timer);
  }
}

const healthWatcher = setInterval(() => void probeHealth(), healthIntervalMs);
healthWatcher.unref?.();

child.on('exit', (code, signal) => {
  clearInterval(healthWatcher);
  if (reportTimer) clearTimeout(reportTimer);
  persistEvent(`child exited: code ${code ?? 'null'} signal ${signal || 'none'}`);
  process.exit(stopRequested ? 0 : (code ?? 0));
});

child.on('error', (error) => {
  clearInterval(healthWatcher);
  console.error(`[supervisor] failed to start server: ${error.message}`);
  persistEvent(`failed to start server: ${error.message}`);
  process.exit(1);
});
