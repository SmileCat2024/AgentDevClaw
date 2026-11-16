import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Keep source-boundary assertions platform-independent (Git may check out CRLF).
const SERVER_SOURCE = readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/\r\n/g, '\n');

function mainBody(source) {
  const start = source.indexOf('async function main() {');
  assert.notEqual(start, -1, 'server.js must contain main()');
  const end = source.indexOf('\n}\n\nmain().catch', start);
  assert.notEqual(end, -1, 'server.js main() boundary must remain discoverable');
  return source.slice(start, end);
}

test('server applies the outbound proxy before startup recovery can spawn runtimes', () => {
  const body = mainBody(SERVER_SOURCE);
  const apply = body.indexOf('  applyProxy();');
  assert.notEqual(apply, -1, 'main() must apply the proxy');
  assert.ok(apply < body.indexOf('await viewerWorker.start();'),
    'proxy must be applied before Viewer startup');
  assert.ok(apply < body.indexOf('threadRestartResume.resumeInterruptedThreads();'),
    'proxy must be applied before thread recovery can spawn a runtime');
  assert.ok(apply < body.indexOf('fireBootSchedules();'),
    'proxy must be applied before on-boot schedules can spawn a runtime');
  assert.equal((body.match(/\bapplyProxy\(\);/g) || []).length, 1,
    'main() must have one authoritative proxy-application point');
});
