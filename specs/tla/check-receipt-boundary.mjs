/** Run all bounded models; distinguish expected counterexamples from tool errors. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const jar = process.env.TLA2TOOLS_JAR
  || path.join(homedir(), '.local/share/tlaplus/1.7.4/tla2tools.jar');
if (!existsSync(jar)) throw new Error('Set TLA2TOOLS_JAR to an installed tla2tools.jar');
const artifactsRoot = path.join(here, 'artifacts');
mkdirSync(artifactsRoot, { recursive: true });
const output = mkdtempSync(path.join(artifactsRoot, 'run-'));
const cases = [
  { name: 'observations', module: 'ReceiptBoundary', code: 0 },
  { name: 'durability', module: 'ReceiptBoundary', code: 12, invariant: 'AckRequiresSnapshot' },
  { name: 'always-save', module: 'ReceiptBoundary', code: 0 },
  { name: 'cancel-policy', module: 'ReceiptBoundary', code: 12, invariant: 'CancelledPayloadNeverReachesModel' },
];
let failed = false;
const results = [];
for (const item of cases) {
  const config = `${item.module}-${item.name}.cfg`;
  const result = spawnSync(process.env.JAVA || 'java', [
    '-XX:+UseParallelGC', '-Xmx1g', '-jar', jar,
    '-workers', '1', '-seed', '1', '-fp', '0',
    '-metadir', path.join(output, `states-${item.module}-${item.name}`),
    '-config', path.join(here, config), path.join(here, `${item.module}.tla`),
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(path.join(output, `${item.name}.log`), text);
  // A partial search or infrastructure failure is never considered a pass.
  const correct = !result.error && result.status === item.code && (item.invariant
    ? text.includes(`Invariant ${item.invariant} is violated.`) && text.includes('State 1:')
    : text.includes('Model checking completed. No error has been found.') && text.includes('0 states left on queue.'));
  failed ||= !correct;
  const states = /([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue/.exec(text);
  const summary = { name: `${item.module}:${item.name}`, exit: result.status, expectedExit: item.code, matched: correct,
    ...(item.invariant ? { violatedInvariant: item.invariant } : {}),
    ...(states ? { generated: states[1], distinct: states[2], remaining: states[3] } : {}),
    ...(result.error ? { error: result.error.message } : {}) };
  results.push(summary);
  console.log(JSON.stringify(summary));
  if (!correct) console.error(text);
}
const gitHead = dir => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
writeFileSync(path.join(output, 'summary.json'), JSON.stringify({
  checkedAt: new Date().toISOString(), claw: gitHead(root),
  agentdev: gitHead(path.resolve(root, '../AgentDev')), jar, results,
}, null, 2));
// Preserve the exact models and configs used to interpret results later.
const modules = [...new Set(cases.map(item => item.module))];
for (const name of [
  ...modules.map(m => `${m}.tla`),
  ...cases.map(item => `${item.module}-${item.name}.cfg`),
]) {
  writeFileSync(path.join(output, name), readFileSync(path.join(here, name)));
}
console.log(`Artifacts: ${output}`);
console.log('Expected counterexamples reproduced is NOT a claim that the production contract passes.');
process.exitCode = failed ? 1 : 0;
