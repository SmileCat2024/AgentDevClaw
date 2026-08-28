/**
 * Tests for server/remote-connections/connection-store.js (R1-01)
 *
 * Covers: default empty state, load/index, schema validation
 * (id / mode / ssh / ports / secret rejection), persistence
 * round-trips, atomicity, port allocation.
 *
 * All file I/O is directed at an injected temp directory — the real
 * user data root is never touched.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConnectionStore, REMOTE_CONNECTION_PORT_RANGE } from '../server/remote-connections/connection-store.js';

let tempDir;
let configPath;

function createStore(overrides = {}) {
  return new ConnectionStore({
    configPath,
    appPort: overrides.appPort ?? 1420,
    viewerPort: overrides.viewerPort ?? 2026,
    ...overrides,
  });
}

function validManualConnection(overrides = {}) {
  return {
    id: 'server-a',
    name: '开发服务器',
    mode: 'manual',
    localPort: 22101,
    ...overrides,
  };
}

function validManagedConnection(overrides = {}) {
  return {
    id: 'server-b',
    name: '托管服务器',
    mode: 'managed',
    enabled: true,
    localPort: 22102,
    ssh: { host: 'dev.example.com', user: 'ubuntu', port: 22, hostAlias: null },
    remote: { appPort: 1420 },
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'rc-store-'));
  configPath = join(tempDir, 'remote-connections.json');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ── Default state ─────────────────────────────────────────────────

describe('connection store default state', () => {
  it('returns an empty list when the config file does not exist', async () => {
    const store = createStore();
    await store.load();
    assert.deepEqual(store.listConnections(), []);
    assert.equal(store.getConnection('server-a'), null);
  });

  it('returns an empty list for a blank file', async () => {
    writeFileSync(configPath, '   \n', 'utf8');
    const store = createStore();
    await store.load();
    assert.deepEqual(store.listConnections(), []);
  });

  it('returns an empty list for an empty connections array', async () => {
    writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, connections: [] }), 'utf8');
    const store = createStore();
    await store.load();
    assert.deepEqual(store.listConnections(), []);
  });

  it('does not create the config file when loading a missing file', async () => {
    const store = createStore();
    await store.load();
    assert.equal(existsSync(configPath), false);
  });
});

// ── Corrupt file handling ──────────────────────────────────────────

describe('connection store corrupt file handling', () => {
  it('rejects a corrupted JSON file with an explicit error naming the path', async () => {
    writeFileSync(configPath, '{ not valid json !!', 'utf8');
    const store = createStore();
    await assert.rejects(
      () => store.load(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('remote-connections.json'), 'error should name the config file');
        assert.ok(/损坏|corrupt/i.test(err.message), 'error should state corruption explicitly');
        return true;
      },
    );
  });

  it('rejects a top-level non-object payload', async () => {
    writeFileSync(configPath, '[]', 'utf8');
    const store = createStore();
    await assert.rejects(() => store.load());
  });

  it('rejects when connections is not an array', async () => {
    writeFileSync(configPath, JSON.stringify({ connections: 'oops' }), 'utf8');
    const store = createStore();
    await assert.rejects(() => store.load());
  });

  it('rejects an invalid connection entry inside the file without silently rebuilding', async () => {
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      connections: [{ id: 'bad:id', mode: 'manual', localPort: 22101 }],
    }), 'utf8');
    const store = createStore();
    await assert.rejects(() => store.load());
    // File must be left untouched — no silent rewrite.
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(raw.connections[0].id, 'bad:id');
  });
});

// ── Loading and indexing ───────────────────────────────────────────

describe('connection store load and index', () => {
  it('loads connections and indexes them by id', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 1,
      connections: [
        validManagedConnection(),
        validManualConnection({ id: 'server-c', name: '备用机', localPort: 22103 }),
      ],
    }), 'utf8');
    const store = createStore();
    await store.load();
    assert.equal(store.listConnections().length, 2);
    assert.equal(store.getConnection('server-b').ssh.host, 'dev.example.com');
    assert.equal(store.getConnection('server-c').mode, 'manual');
    assert.equal(store.getConnection('nope'), null);
  });

  it('applies defaults when optional fields are omitted in the file', async () => {
    writeFileSync(configPath, JSON.stringify({
      connections: [
        { id: 'server-a', name: '开发服务器', mode: 'manual', localPort: 22101 },
      ],
    }), 'utf8');
    const store = createStore();
    await store.load();
    const conn = store.getConnection('server-a');
    assert.equal(conn.enabled, false);
    assert.deepEqual(conn.remote, { appPort: 1420 });
    assert.equal(conn.ssh, null);
  });
});

// ── Validation: id ─────────────────────────────────────────────────

describe('connection id validation', () => {
  it('rejects an id containing a colon (namespace separator)', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManualConnection({ id: 'server:a' })));
  });

  it('rejects ids containing URL reserved characters', async () => {
    const store = createStore();
    for (const bad of ['server/a', 'server?a', 'server#a', 'server%41', 'server@a', 'server&a', 'server+a', 'ser ver']) {
      await assert.rejects(() => store.upsertConnection(validManualConnection({ id: bad })), `id "${bad}" should be rejected`);
    }
  });

  it('accepts ids with letters, digits, dash, underscore and dot', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection({ id: 'Server_01.prod-2' }));
    assert.equal(store.getConnection('Server_01.prod-2').name, '开发服务器');
  });

  it('rejects empty, missing or non-string ids', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManualConnection({ id: '' })));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ id: null })));
    await assert.rejects(() => store.upsertConnection({ ...validManualConnection(), id: undefined }));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ id: 42 })));
  });

  it('rejects duplicate ids on upsert of a different entry with the same id via the file path', async () => {
    // Duplicates cannot enter through upsert (same id means update), so the
    // store must reject a file containing duplicated ids instead.
    const dup = validManualConnection({ id: 'server-a', localPort: 22101 });
    const dup2 = validManualConnection({ id: 'server-a', localPort: 22104 });
    writeFileSync(configPath, JSON.stringify({ connections: [dup, dup2] }), 'utf8');
    const store = createStore();
    await assert.rejects(() => store.load(), /重复|duplicate/i);
  });
});

// ── Validation: mode / ssh ─────────────────────────────────────────

describe('connection mode and ssh validation', () => {
  it('rejects modes outside the manual|managed enum', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManualConnection({ mode: 'auto' })));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ mode: '' })));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ mode: null })));
    await assert.rejects(() => store.upsertConnection({ ...validManualConnection(), mode: undefined }));
  });

  it('rejects managed mode without ssh.host', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ ssh: {} })));
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ ssh: { user: 'ubuntu' } })));
    await assert.rejects(() => store.upsertConnection({ ...validManagedConnection(), ssh: undefined }));
  });

  it('rejects managed mode with a blank ssh.host', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ ssh: { host: '   ' } })));
  });

  it('accepts manual mode without any ssh block', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection());
    const conn = store.getConnection('server-a');
    assert.equal(conn.mode, 'manual');
    assert.equal(conn.ssh, null);
  });

  it('reloads a manual connection persisted with ssh:null (save/load round-trip)', async () => {
    // 回归：upsert 将 manual 的缺省 ssh 序列化为 null，load 曾把 null 误判为非法对象，
    // 导致重启后配置文件整体加载失败（所有已保存连接变砖）。
    const first = createStore();
    await first.upsertConnection(validManualConnection());
    const second = createStore();
    await second.load();
    const conn = second.getConnection('server-a');
    assert.ok(conn, 'persisted manual connection must survive restart');
    assert.equal(conn.ssh, null);
  });

  it('accepts manual mode with an ssh block (diagnostics info)', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection({
      ssh: { host: 'dev.example.com', user: 'ubuntu', port: 2222, hostAlias: 'dev-box' },
    }));
    assert.equal(store.getConnection('server-a').ssh.hostAlias, 'dev-box');
  });

  it('rejects invalid ssh.port values', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ ssh: { host: 'h', port: 0 } })));
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ ssh: { host: 'h', port: 70000 } })));
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ ssh: { host: 'h', port: '22' } })));
  });

  it('rejects unknown fields on the connection, ssh and remote objects (strict schema)', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ extra: true })));
    await assert.rejects(() => store.upsertConnection(validManagedConnection({
      ssh: { host: 'h', password: 'hunter2' },
    })));
    await assert.rejects(() => store.upsertConnection(validManagedConnection({
      remote: { appPort: 1420, viewerPort: 2026 },
    })));
  });
});

// ── Validation: secret fields ──────────────────────────────────────

describe('connection secret field rejection', () => {
  it('rejects ssh.password', async () => {
    const store = createStore();
    await assert.rejects(
      () => store.upsertConnection(validManagedConnection({ ssh: { host: 'h', password: 'hunter2' } })),
      /password|机密|密码/i,
    );
  });

  it('rejects ssh.privateKey', async () => {
    const store = createStore();
    await assert.rejects(
      () => store.upsertConnection(validManagedConnection({ ssh: { host: 'h', privateKey: '-----BEGIN' } })),
      /privateKey|私钥|机密/i,
    );
  });

  it('rejects ssh.passphrase', async () => {
    const store = createStore();
    await assert.rejects(
      () => store.upsertConnection(validManagedConnection({ ssh: { host: 'h', passphrase: 'secret' } })),
      /passphrase|机密/i,
    );
  });

  it('never persists secret-named keys even when nested inside allowed ssh fields', async () => {
    const store = createStore();
    await store.upsertConnection(validManagedConnection());
    const raw = readFileSync(configPath, 'utf8');
    assert.ok(!/password/i.test(raw));
    assert.ok(!/passphrase/i.test(raw));
    assert.ok(!/privateKey/i.test(raw));
  });
});

// ── Validation: ports ──────────────────────────────────────────────

describe('connection local port validation', () => {
  const { min, max } = REMOTE_CONNECTION_PORT_RANGE;

  it('rejects ports below the reserved range', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManualConnection({ localPort: min - 1 })));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ localPort: 1420 })));
  });

  it('rejects ports above the reserved range', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManualConnection({ localPort: max + 1 })));
  });

  it('rejects non-integer ports', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManualConnection({ localPort: 22100.5 })));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ localPort: '22101' })));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ localPort: null })));
  });

  it('rejects conflicts with APP_PORT and VIEWER_PORT', async () => {
    const store = createStore({ appPort: 1420, viewerPort: 2026 });
    await assert.rejects(
      () => store.upsertConnection(validManualConnection({ localPort: 1420 })),
      /APP_PORT|1420|范围/,
    );
    await assert.rejects(
      () => store.upsertConnection(validManualConnection({ localPort: 2026 })),
      /VIEWER_PORT|2026|范围/,
    );
  });

  it('rejects conflicts with another connection port', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection({ localPort: 22101 }));
    await assert.rejects(
      () => store.upsertConnection(validManagedConnection({ id: 'server-b', localPort: 22101 })),
      /端口|port/i,
    );
  });

  it('allows updating a connection while keeping its own port', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection({ localPort: 22101 }));
    await store.upsertConnection(validManualConnection({ localPort: 22101, name: '改名' }));
    assert.equal(store.getConnection('server-a').name, '改名');
  });

  it('rejects a file whose entries already conflict on ports', async () => {
    writeFileSync(configPath, JSON.stringify({
      connections: [
        validManualConnection({ localPort: 22101 }),
        validManagedConnection({ id: 'server-b', localPort: 22101 }),
      ],
    }), 'utf8');
    const store = createStore();
    await assert.rejects(() => store.load(), /端口|port/i);
  });

  it('rejects a file entry whose port collides with APP_PORT/VIEWER_PORT', async () => {
    writeFileSync(configPath, JSON.stringify({
      connections: [validManualConnection({ localPort: 1420 })],
    }), 'utf8');
    const store = createStore({ appPort: 1420, viewerPort: 2026 });
    await assert.rejects(() => store.load());
  });

  it('rejects an invalid remote.appPort', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ remote: { appPort: 0 } })));
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ remote: { appPort: 70000 } })));
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ remote: { appPort: '1420' } })));
  });
});

// ── Other field validation ─────────────────────────────────────────

describe('connection field validation', () => {
  it('rejects non-boolean enabled', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManualConnection({ enabled: 'yes' })));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ enabled: 1 })));
  });

  it('defaults enabled to false and name to the id', async () => {
    const store = createStore();
    await store.upsertConnection({ id: 'server-x', mode: 'manual', localPort: 22101 });
    const conn = store.getConnection('server-x');
    assert.equal(conn.enabled, false);
    assert.equal(conn.name, 'server-x');
  });

  it('rejects non-string or blank names when provided', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(validManualConnection({ name: '   ' })));
    await assert.rejects(() => store.upsertConnection(validManualConnection({ name: 42 })));
  });

  it('rejects a non-object payload', async () => {
    const store = createStore();
    await assert.rejects(() => store.upsertConnection(null));
    await assert.rejects(() => store.upsertConnection('nope'));
    await assert.rejects(() => store.upsertConnection(undefined));
  });
});

// ── Persistence round-trips ────────────────────────────────────────

describe('connection store persistence', () => {
  it('round-trips an upserted connection through a fresh store instance', async () => {
    const store = createStore();
    await store.upsertConnection(validManagedConnection());
    const second = createStore();
    await second.load();
    const conn = second.getConnection('server-b');
    assert.equal(conn.id, 'server-b');
    assert.equal(conn.mode, 'managed');
    assert.equal(conn.enabled, true);
    assert.deepEqual(conn.ssh, { host: 'dev.example.com', user: 'ubuntu', port: 22, hostAlias: null });
    assert.deepEqual(conn.remote, { appPort: 1420 });
  });

  it('updates an existing connection in place on re-upsert', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection());
    await store.upsertConnection(validManualConnection({ name: '新名字', localPort: 22199 }));
    const all = store.listConnections();
    assert.equal(all.length, 1);
    assert.equal(all[0].name, '新名字');
    assert.equal(all[0].localPort, 22199);
  });

  it('writes a stable file shape (schemaVersion + connections)', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection());
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    assert.equal(raw.schemaVersion, 1);
    assert.ok(Array.isArray(raw.connections));
    assert.equal(raw.connections.length, 1);
  });

  it('leaves the file untouched when upsert validation fails', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection());
    const before = readFileSync(configPath, 'utf8');
    await assert.rejects(() => store.upsertConnection(validManagedConnection({ id: 'server-a', mode: 'wrong' })));
    assert.equal(readFileSync(configPath, 'utf8'), before);
  });

  it('deletes a connection and persists the removal', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection());
    const removed = await store.deleteConnection('server-a');
    assert.equal(removed.id, 'server-a');
    assert.equal(store.getConnection('server-a'), null);
    const second = createStore();
    await second.load();
    assert.deepEqual(second.listConnections(), []);
  });

  it('throws when deleting an unknown connection', async () => {
    const store = createStore();
    await assert.rejects(() => store.deleteConnection('ghost'));
  });

  it('returns frozen connection objects to callers', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection());
    const conn = store.getConnection('server-a');
    assert.ok(Object.isFrozen(conn));
    assert.ok(Object.isFrozen(conn.remote));
    assert.throws(() => { conn.enabled = true; });
  });
});

// ── Port allocation ────────────────────────────────────────────────

describe('connection port allocation', () => {
  it('allocates the first free port in the range for an empty store', async () => {
    const store = createStore();
    await store.load();
    assert.equal(store.allocateLocalPort(), REMOTE_CONNECTION_PORT_RANGE.min);
  });

  it('allocates the next free port skipping taken connections and reserved ports', async () => {
    const store = createStore();
    await store.upsertConnection(validManualConnection({ id: 'a', localPort: REMOTE_CONNECTION_PORT_RANGE.min }));
    await store.upsertConnection(validManagedConnection({ id: 'b', localPort: REMOTE_CONNECTION_PORT_RANGE.min + 2 }));
    assert.equal(store.allocateLocalPort(), REMOTE_CONNECTION_PORT_RANGE.min + 1);
    assert.equal(store.allocateLocalPort(), REMOTE_CONNECTION_PORT_RANGE.min + 3);
  });

  it('throws when the whole range is exhausted', async () => {
    const store = new ConnectionStore({ configPath, appPort: 1, viewerPort: 2 });
    const { min, max } = REMOTE_CONNECTION_PORT_RANGE;
    writeFileSync(configPath, JSON.stringify({
      connections: Array.from({ length: max - min + 1 }, (_, index) => ({
        id: `conn-${min + index}`,
        name: `conn-${min + index}`,
        enabled: false,
        mode: 'manual',
        localPort: min + index,
      })),
    }), 'utf8');
    await store.load();
    assert.throws(() => store.allocateLocalPort(), /端口|port/i);
  });
});

// ── URL direct mode ────────────────────────────────────────────────

function validUrlConnection(overrides = {}) {
  return {
    id: 'server-url',
    name: '直连服务器',
    mode: 'url',
    enabled: true,
    baseUrl: 'https://claw.example.com',
    ...overrides,
  };
}

describe('connection store url direct mode schema', () => {
  it('accepts a url connection and normalizes the origin form', async () => {
    const store = createStore();
    const connection = await store.upsertConnection(
      validUrlConnection({ baseUrl: 'https://claw.example.com/' }),
    );
    assert.equal(connection.mode, 'url');
    assert.equal(connection.baseUrl, 'https://claw.example.com');
    assert.equal(connection.localPort, null);
    assert.equal(connection.ssh, null);
    assert.equal(connection.remote, null);
  });

  it('strips nothing but trailing slashes — origin stays verbatim', async () => {
    const store = createStore();
    const connection = await store.upsertConnection(
      validUrlConnection({ baseUrl: 'http://10.0.0.8:1420' }),
    );
    assert.equal(connection.baseUrl, 'http://10.0.0.8:1420');
  });

  it('round-trips a url connection through the config file', async () => {
    const store = createStore();
    await store.upsertConnection(validUrlConnection());
    const second = createStore();
    const loaded = await second.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].mode, 'url');
    assert.equal(loaded[0].baseUrl, 'https://claw.example.com');
    assert.equal(loaded[0].localPort, null);
  });

  it('requires baseUrl in url mode', async () => {
    const store = createStore();
    await assert.rejects(
      () => store.upsertConnection(validUrlConnection({ baseUrl: undefined })),
      /baseUrl/,
    );
    await assert.rejects(
      () => store.upsertConnection(validUrlConnection({ baseUrl: '   ' })),
      /baseUrl/,
    );
  });

  it('rejects non-http(s) schemes and non-origin forms', async () => {
    const store = createStore();
    for (const baseUrl of [
      'ftp://claw.example.com',
      'claw.example.com',
      'https://claw.example.com/base/path',
      'https://claw.example.com/?x=1',
      'not a url',
    ]) {
      await assert.rejects(
        () => store.upsertConnection(validUrlConnection({ baseUrl })),
        /baseUrl.*(URL|http|源|origin)/i,
      );
    }
  });

  it('rejects tunnel-only fields (localPort / ssh / remote) in url mode', async () => {
    const store = createStore();
    await assert.rejects(
      () => store.upsertConnection(validUrlConnection({ localPort: 22103 })),
      /localPort/,
    );
    await assert.rejects(
      () => store.upsertConnection(validUrlConnection({ ssh: { host: 'dev.example.com' } })),
      /ssh/,
    );
    await assert.rejects(
      () => store.upsertConnection(validUrlConnection({ remote: { appPort: 1420 } })),
      /remote/,
    );
  });

  it('does not treat two url connections as a local-port conflict', async () => {
    const store = createStore();
    await store.upsertConnection(validUrlConnection({ id: 'url-a' }));
    await store.upsertConnection(validUrlConnection({ id: 'url-b', baseUrl: 'https://other.example.com' }));
    assert.equal(store.listConnections().length, 2);
  });

  it('keeps null remote frozen-safe through list/get round-trips', async () => {
    const store = createStore();
    await store.upsertConnection(validUrlConnection());
    for (const connection of [...store.listConnections(), store.getConnection('server-url')]) {
      assert.equal(connection.remote, null);
      assert.equal(connection.ssh, null);
      assert.ok(Object.isFrozen(connection));
    }
  });
});
