# Remote Claw Embedded Connector

Remote Claw connector can run inside AgentDevClaw itself. This is the default lightweight deployment mode: no extra local process is required, and the connector starts only when relay environment variables are present.

## Enable

```powershell
$env:REMOTE_CLAW_RELAY_URL="http://127.0.0.1:8080"
$env:REMOTE_CLAW_CONNECTOR_TOKEN="rcd_connector_token"
$env:REMOTE_CLAW_WORKSPACE_NAME="Home PC"
npm start
```

Optional intervals:

```powershell
$env:REMOTE_CLAW_HEARTBEAT_MS="15000"
$env:REMOTE_CLAW_SNAPSHOT_MS="5000"
$env:REMOTE_CLAW_COMMAND_MS="2000"
```

These values are wake-up intervals, not permission to rescan every transcript. Each loop is single-flight. The connector compares a catalog digest first and only reads a transcript when its file metadata or message count changes. An empty complete snapshot is authoritative and removes stale relay sessions.

If `REMOTE_CLAW_RELAY_URL` or `REMOTE_CLAW_CONNECTOR_TOKEN` is missing, AgentDevClaw behaves exactly as before.

## What It Does

- Registers this AgentDevClaw instance as a relay workspace.
- Reads local agents and prebuilt sessions.
- Upserts session metadata to the relay.
- Reads session transcript snapshots without mutating session files.
- Skips unchanged transcript files using `mtime + size + messageCount` fingerprints.
- Prevents overlapping heartbeat, catalog, and command loops.
- Reconciles the complete session catalog, including deleted local sessions.
- Appends new message events to relay streams.
- Pulls pending Android commands.
- Executes `message.send` through the existing ViewerWorker `/queue-input` path.
- Executes `runtime.interrupt` through the existing ViewerWorker interrupt path.

## Boundary

The embedded connector is intentionally separate from IM channels. It does not use carrier, line, portal, or selectedChannel concepts. It uses workspace/session/event/command.

It is also separate from session persistence. It never writes session files directly; all writes happen through existing Agent runtime autosave and ViewerWorker input APIs.

## When To Use A Standalone Connector

Use a standalone connector later only when you need hard process isolation, system service installation, auto-update independent of AgentDevClaw, or connection to a remote AgentDevClaw over LAN. The embedded connector is simpler and should be the first production path.
