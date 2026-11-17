import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLA2TOOLS_JAR || path.join(homedir(), '.local/share/tlaplus/1.7.4/tla2tools.jar');
mkdirSync(path.join(here, 'artifacts'), { recursive: true });
const output = mkdtempSync(path.join(here, 'artifacts/cancellation-'));
const cases = [
  { name: 'local-cutoff', pending: false, scoped: false },
  { name: 'inbox-pending-gap', pending: false, scoped: false, invariant: 'PreCheckpointPendingNotDelivered' },
  { name: 'runtime-cutoff-gap', pending: false, scoped: false, invariant: 'PostCheckpointRuntimeInputSurvives' },
  { name: 'scoped-control', pending: true, scoped: true, control: true },
];
const model = path.join(output, 'CancellationCheckpoint.tla');
writeFileSync(model, readFileSync(path.join(here, 'CancellationCheckpoint.tla')));
const results = [];
for (const item of cases) {
  const checks = ['TypeOK', 'NewInputNotCancelled'];
  if (item.invariant) checks.push(item.invariant);
  if (item.control) checks.push('PreCheckpointPendingNotDelivered', 'PostCheckpointRuntimeInputSurvives');
  const config = path.join(output, `${item.name}.cfg`);
  writeFileSync(config, `SPECIFICATION Spec\nCONSTANTS\n IncludePending = ${item.pending ? 'TRUE' : 'FALSE'}\n ScopedRuntimeClear = ${item.scoped ? 'TRUE' : 'FALSE'}\nINVARIANTS ${checks.join(' ')}\n`);
  console.log(`START ${item.name}`);
  const run = spawnSync(process.env.JAVA || 'java', ['-XX:+UseParallelGC', '-Xmx1g', '-jar', jar,
    '-workers', '1', '-seed', '1', '-fp', '0', '-metadir', path.join(output, `states-${item.name}`),
    '-config', config, model], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const text = `${run.stdout || ''}${run.stderr || ''}`;
  writeFileSync(path.join(output, `${item.name}.log`), text);
  const expected = item.invariant ? 12 : 0;
  const matched = !run.error && run.status === expected && (item.invariant
    ? text.includes(`Invariant ${item.invariant} is violated.`) && text.includes('State 1:')
    : text.includes('Model checking completed. No error has been found.') && text.includes('0 states left on queue.'));
  const result = { name: item.name, exit: run.status, expected, matched };
  results.push(result); console.log(JSON.stringify(result));
  if (!matched) console.error(text);
}
const git = dir => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
  claw: git(path.resolve(here, '../..')), agentdev: git(path.resolve(here, '../../../AgentDev')),
  jar, cases, results }, null, 2));
console.log(`Artifacts: ${output}`);
process.exitCode = results.every(row => row.matched) ? 0 : 1;
