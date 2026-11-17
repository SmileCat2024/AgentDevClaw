import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLA2TOOLS_JAR || path.join(homedir(), '.local/share/tlaplus/1.7.4/tla2tools.jar');
mkdirSync(path.join(here, 'artifacts'), { recursive: true });
const output = mkdtempSync(path.join(here, 'artifacts/deep-'));
const base = { CommandCount: 2, HistoryCap: 2, EnableIdentityChange: false,
  EnableRetry: true, AllowSaveFailure: false, ProbeMemoryShortcut: true,
  FairProgress: false, MutateLeaseFence: false, MutateFifo: false };
const cases = [
  { name: 'baseline', module: 'ReceiptBoundaryDeep', constants: { ...base, AllowSaveFailure: true }, invariant: 'AckRequiresSnapshot' },
  { name: 'fencing', module: 'ReceiptBoundaryDeep', constants: { ...base, EnableIdentityChange: true } },
  { name: 'fifo-three', module: 'ReceiptBoundaryDeep', constants: { ...base, CommandCount: 3, HistoryCap: 3 } },
  { name: 'history-eviction', module: 'ReceiptBoundaryDeep', constants: { ...base, HistoryCap: 1 }, invariant: 'NoReAdmissionAfterHistoryEviction' },
  { name: 'cancel-history-eviction', module: 'ReceiptBoundaryDeep', constants: { ...base, HistoryCap: 1 }, invariant: 'NoCancelledReAdmission' },
  { name: 'retry-after-identity-change', module: 'ReceiptBoundaryDeep', constants: { ...base, EnableIdentityChange: true }, invariant: 'AckRetryAlwaysAccepted' },
  { name: 'liveness-fair', module: 'ReceiptBoundaryDeep', constants: { ...base, CommandCount: 3, HistoryCap: 3, AllowSaveFailure: true, ProbeMemoryShortcut: false, FairProgress: true }, property: 'EventuallyDisposed' },
  { name: 'liveness-no-fairness', module: 'ReceiptBoundaryDeep', constants: { ...base }, property: 'EventuallyDisposed', temporalFailure: true },
  { name: 'mutation-lease', module: 'ReceiptBoundaryDeep', constants: { ...base, EnableIdentityChange: true, MutateLeaseFence: true }, invariant: 'NoCrossIdentityAck' },
  { name: 'mutation-fifo', module: 'ReceiptBoundaryDeep', constants: { ...base, MutateFifo: true }, invariant: 'FifoClaim' },
  { name: 'succession-safety', module: 'SuccessionWindow', constants: { CommandCount: 2, FairRecovery: false, AllowSuccession: true } },
  { name: 'succession-late-classification', module: 'SuccessionWindow', constants: { CommandCount: 2, FairRecovery: false, AllowSuccession: true }, invariant: 'NoLateUnclassifiedDelivery' },
  { name: 'succession-inflight-old-runtime', module: 'SuccessionWindow', constants: { CommandCount: 2, FairRecovery: false, AllowSuccession: true }, invariant: 'NoAcceptanceAfterHeadChanged' },
];
let failed = false;
const results = [];
for (const item of cases) {
  const receipt = item.module === 'ReceiptBoundaryDeep';
  const safety = receipt ? 'TypeOK NoSilentDisappearance NoCrossIdentityAck FifoClaim'
    : 'TypeOK NoNewRequestThroughGate';
  // Mutation cases replace the target's ordinary safety occurrence, keeping
  // the same independent invariant and an explicit expected counterexample.
  const invariants = [...new Set(`${safety} ${item.invariant || ''}`.trim().split(/\s+/))];
  const config = `SPECIFICATION Spec\nCONSTANTS\n${Object.entries(item.constants).map(([k,v]) => ` ${k} = ${typeof v === 'boolean' ? String(v).toUpperCase() : v}`).join('\n')}\nINVARIANTS ${invariants.join(' ')}\n${item.property ? `PROPERTY ${item.property}\n` : ''}`;
  const cfgPath = path.join(output, `${item.name}.cfg`);
  writeFileSync(cfgPath, config);
  const modelPath = path.join(output, `${item.module}.tla`);
  writeFileSync(modelPath, readFileSync(path.join(here, `${item.module}.tla`)));
  console.log(`START ${item.name}`);
  const result = spawnSync(process.env.JAVA || 'java', ['-XX:+UseParallelGC', '-Xmx1g', '-jar', jar,
    '-workers', '1', '-seed', '1', '-fp', '0', '-metadir', path.join(output, `states-${item.name}`),
    '-config', cfgPath, modelPath], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  writeFileSync(path.join(output, `${item.name}.log`), text);
  const expected = item.temporalFailure ? 13 : item.invariant ? 12 : 0;
  const matched = !result.error && result.status === expected && (item.temporalFailure
    ? text.includes('Temporal properties were violated.')
    : item.invariant ? text.includes(`Invariant ${item.invariant} is violated.`) && text.includes('State 1:')
    : text.includes('Model checking completed. No error has been found.') && text.includes('0 states left on queue.'));
  const states = /([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue/.exec(text);
  const row = { name: item.name, exit: result.status, expected, matched,
    ...(states ? { generated: states[1], distinct: states[2], remaining: states[3] } : {}),
    ...(result.error ? { error: result.error.message } : {}) };
  results.push(row); failed ||= !matched;
  console.log(JSON.stringify(row));
  if (!matched) console.error(text);
}
const git = dir => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
  claw: git(path.resolve(here, '../..')), agentdev: git(path.resolve(here, '../../../AgentDev')),
  jar, cases, results }, null, 2));
console.log(`Artifacts: ${output}\nExpected counterexamples are diagnostic probes, not production correctness passes.`);
process.exitCode = failed ? 1 : 0;
