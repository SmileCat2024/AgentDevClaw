import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLA2TOOLS_JAR || path.join(homedir(), '.local/share/tlaplus/1.7.4/tla2tools.jar');
mkdirSync(path.join(here, 'artifacts'), { recursive: true });
const output = mkdtempSync(path.join(here, 'artifacts/host-delivery-'));

// 场景矩阵：修复前（pre-fix, EnableReconcile=FALSE）/ 修复后（post-fix, TRUE）
// 交叉投递触发票、身份采纳注入、换头与 runtime 退出。活性场景假设挡板收敛 +
// janitor 周期扫描 + 触发点投递弱公平（LiveSpec 的 Fairness 合取）；换头尝试
// 与 runtime 退出的干扰预算把活性声明的边界显式化：预算有限 = 假设收敛，
// 预算 -1（无限）= 专门暴露饥饿类发现（starve-* 场景）。
const BOOLEANS = ['EnableReconcile', 'EnableHandoff', 'EnableRuntimeExit', 'InjectAdoptFail',
  'JanitorFairness', 'DeliverFairness', 'MutateStaleDeliver', 'BoundHandoff', 'BoundExit'];
const cases = [
  {
    name: 'deadlock-pre-fix-reachable',
    spec: 'Spec', invariant: 'NotDeadlockStalled', expect: 'violation',
    constants: { EnableReconcile: false, EnableHandoff: true, EnableRuntimeExit: false, InjectAdoptFail: true,
      JanitorFairness: false, DeliverFairness: false, MutateStaleDeliver: false },
    budget: { boundHandoff: true, handoff: 3, boundExit: true, exit: 0 },
  },
  {
    name: 'liveness-pre-fix',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    constants: { EnableReconcile: false, EnableHandoff: true, EnableRuntimeExit: false, InjectAdoptFail: true,
      JanitorFairness: true, DeliverFairness: true, MutateStaleDeliver: false },
    budget: { boundHandoff: false, handoff: 0, boundExit: true, exit: 0 },
  },
  {
    name: 'deadlock-post-fix-liveness',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'pass',
    constants: { EnableReconcile: true, EnableHandoff: true, EnableRuntimeExit: false, InjectAdoptFail: true,
      JanitorFairness: true, DeliverFairness: true, MutateStaleDeliver: false },
    budget: { boundHandoff: true, handoff: 3, boundExit: true, exit: 0 },
  },
  {
    name: 'safety-all-race',
    spec: 'Spec', invariants: ['TypeOK', 'DeliveredAtOrBeforeHead', 'NoDeliveryWithoutAdoption', 'DeliveredOnlyWhenAligned'],
    expect: 'pass',
    constants: { EnableReconcile: true, EnableHandoff: true, EnableRuntimeExit: true, InjectAdoptFail: true,
      JanitorFairness: false, DeliverFairness: false, MutateStaleDeliver: false },
    budget: { boundHandoff: true, handoff: 3, boundExit: true, exit: 3 },
  },
  {
    name: 'mutation-stale-deliver',
    spec: 'Spec', invariant: 'DeliveredOnlyWhenAligned', expect: 'violation',
    constants: { EnableReconcile: true, EnableHandoff: true, EnableRuntimeExit: true, InjectAdoptFail: true,
      JanitorFairness: false, DeliverFairness: false, MutateStaleDeliver: true },
    budget: { boundHandoff: true, handoff: 3, boundExit: true, exit: 3 },
  },
  {
    name: 'absent-wake-liveness',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'pass',
    constants: { EnableReconcile: false, EnableHandoff: false, EnableRuntimeExit: true, InjectAdoptFail: false,
      JanitorFairness: true, DeliverFairness: true, MutateStaleDeliver: false },
    budget: { boundHandoff: true, handoff: 0, boundExit: true, exit: 2 },
  },
  {
    name: 'starve-handoff-toggle',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    note: '发现②：无限换头风暴饿死对账——即使修复后，投递活性仍依赖换头尝试收敛（生产的接续退避）',
    constants: { EnableReconcile: true, EnableHandoff: true, EnableRuntimeExit: false, InjectAdoptFail: true,
      JanitorFairness: true, DeliverFairness: true, MutateStaleDeliver: false },
    budget: { boundHandoff: false, handoff: 0, boundExit: true, exit: 0 },
  },
  {
    name: 'starve-crash-loop',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    note: '发现②：无限崩溃循环饿死投递——与死锁无关的饥饿类，投递活性依赖 runtime 最终稳定',
    constants: { EnableReconcile: false, EnableHandoff: false, EnableRuntimeExit: true, InjectAdoptFail: false,
      JanitorFairness: true, DeliverFairness: true, MutateStaleDeliver: false },
    budget: { boundHandoff: true, handoff: 0, boundExit: false, exit: 0 },
  },
];

const model = path.join(output, 'HostDeliveryPlane.tla');
writeFileSync(model, readFileSync(path.join(here, 'HostDeliveryPlane.tla')));
const results = [];
for (const item of cases) {
  const lines = [`SPECIFICATION ${item.spec}`, 'CONSTANTS', ' CommandCount = 2', ' MaxGen = 2', ' TicketCap = 2'];
  for (const key of BOOLEANS) lines.push(` ${key} = ${item.constants[key] ? 'TRUE' : 'FALSE'}`);
  lines.push(` BoundHandoff = ${item.budget.boundHandoff ? 'TRUE' : 'FALSE'}`,
    ` BoundExit = ${item.budget.boundExit ? 'TRUE' : 'FALSE'}`,
    ` HandoffBudget = ${item.budget.handoff}`, ` ExitBudget = ${item.budget.exit}`);
  if (item.invariants) lines.push(`INVARIANTS ${item.invariants.join(' ')}`);
  if (item.invariant) lines.push(`INVARIANT ${item.invariant}`);
  if (item.property) lines.push(`PROPERTY ${item.property}`);
  const config = path.join(output, `${item.name}.cfg`);
  writeFileSync(config, `${lines.join('\n')}\n`);
  console.log(`START ${item.name}`);
  const run = spawnSync(process.env.JAVA || 'java', ['-XX:+UseParallelGC', '-Xmx1g', '-jar', jar,
    '-workers', '1', '-seed', '1', '-fp', '0', '-deadlock', '-metadir', path.join(output, `states-${item.name}`),
    '-config', config, model], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const text = `${run.stdout || ''}${run.stderr || ''}`;
  writeFileSync(path.join(output, `${item.name}.log`), text);
  const expectedExit = item.expect === 'violation' ? (item.property ? 13 : 12) : 0;
  const evidence = item.expect === 'violation'
    ? (item.property
      ? text.includes('Temporal properties were violated.')
      : text.includes(`Invariant ${item.invariant} is violated.`) && text.includes('State 1:'))
    : text.includes('Model checking completed') && text.includes('No error has been found.');
  const matched = !run.error && run.status === expectedExit && evidence;
  const result = { name: item.name, exit: run.status, expected: expectedExit, matched,
    states: /(\d+) distinct states/.exec(text)?.[1] };
  results.push(result); console.log(JSON.stringify(result));
  if (!matched) console.error(text);
}
const gitRef = dir => { const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return r.stdout?.trim(); };
writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
  claw: gitRef(path.resolve(here, '../..')), agentdev: gitRef(path.resolve(here, '../../../AgentDev')),
  jar, cases, results }, null, 2));
console.log(`Artifacts: ${output}`);
process.exitCode = results.every(row => row.matched) ? 0 : 1;
