import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const jar = process.env.TLA2TOOLS_JAR || path.join(homedir(), '.local/share/tlaplus/1.7.4/tla2tools.jar');
mkdirSync(path.join(here, 'artifacts'), { recursive: true });
const output = mkdtempSync(path.join(here, 'artifacts/host-delivery-'));

// 场景矩阵（2026-11-18 大幅细化版）：模型按真实机制建模（双投递路径、
// 诚实触发面、线程级退避、runtime 三态与绑定漂移、spawn 身份注入开关、
// ready 信号丢失开关、采纳反复失败探针）。场景分三组：
//   移植组（1-9）：H2 死锁、修复前后活性、安全性全对撞、变异辨别力、
//     唤醒路径、两类饥饿（D12）——全部在细化语义下重新验证。
//   挖掘组（10-15）：细化后才能表达的形态——全绿滞留（触发面诚实化）、
//     跨路径超车（wt-1ab8a75b 两个世界）、输入落错地方（绑定漂移）、
//     采纳反复失败饥饿（新轴）、ready 信号丢失（11-16 修复前后对照）、
//     漂移风暴饥饿（janitor 两拍收敛 vs 无界漂移，D12-3）。
const BOOLEANS = ['EnableReconcile', 'EnableHandoff', 'EnableCrash', 'InjectAdoptFail',
  'AdoptFailForever', 'SpawnInjectsIdentity', 'EnableReadyDrop', 'EnableBindDrift',
  'MutateStaleDeliver', 'JanitorFairness', 'DeliverFairness', 'SpawnFairness',
  'BoundHandoff', 'BoundCrash', 'BoundDrift'];
const cases = [
  {
    name: 'fencing-deadlock-pre-fix',
    spec: 'Spec', invariant: 'NotDeadlockFencing', expect: 'violation',
    note: '移植：H2 身份错位死锁可达（legacy spawn 无身份注入 → fencing 永拒，修复前无对账）',
    constants: { EnableReconcile: false, EnableHandoff: false, EnableCrash: false, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: false, EnableReadyDrop: false, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: false, DeliverFairness: false, SpawnFairness: false },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 0, boundDrift: true, drift: 0 },
  },
  {
    name: 'allgreen-stall-pre-fix',
    spec: 'Spec', invariant: 'NotStalledHealthy', expect: 'violation',
    note: '新：全绿滞留可达——runtime 在位绑定 head、身份对齐、退避已过、无待消费信号，',
    // eslint-disable-next-line @stylistic/max-len -- 场景注记
    note2: '修复前触发面上没有任何 action 对滞留指令负责（wt-1ab8a75b 09:52→11:24 静默窗口的精确形状）',
    constants: { EnableReconcile: false, EnableHandoff: false, EnableCrash: false, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: false, EnableReadyDrop: false, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: false, DeliverFairness: false, SpawnFairness: false },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 0, boundDrift: true, drift: 0 },
  },
  {
    name: 'liveness-pre-fix',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    note: '移植：修复前活性失守（错位 lasso 或全绿滞留 lasso）',
    constants: { EnableReconcile: false, EnableHandoff: true, EnableCrash: false, InjectAdoptFail: true,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: true, handoff: 3, boundCrash: true, crash: 0, boundDrift: true, drift: 0 },
  },
  {
    name: 'liveness-post-fix',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'pass',
    note: '移植+加强：修复后活性通过，叠加有界绑定漂移干扰（唤醒→重绑→下轮对账两拍收敛也要活性成立）',
    constants: { EnableReconcile: true, EnableHandoff: true, EnableCrash: true, InjectAdoptFail: true,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: true,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: true, handoff: 3, boundCrash: true, crash: 2, boundDrift: true, drift: 2 },
  },
  {
    name: 'safety-all-race',
    spec: 'Spec', invariants: ['TypeOK', 'DeliveredAtOrBeforeHead', 'DeliveredOnlyWhenAligned', 'QueueFIFO'],
    expect: 'pass',
    note: '移植：全机制对撞下安全性不变式成立（队列内 FIFO 无超车是 FIFO+retryable-break 的数学后果）',
    constants: { EnableReconcile: true, EnableHandoff: true, EnableCrash: true, InjectAdoptFail: true,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: true,
      MutateStaleDeliver: false, JanitorFairness: false, DeliverFairness: false, SpawnFairness: false },
    budget: { boundHandoff: true, handoff: 3, boundCrash: true, crash: 3, boundDrift: true, drift: 2 },
  },
  {
    name: 'mutation-stale-deliver',
    spec: 'Spec', invariant: 'DeliveredOnlyWhenAligned', expect: 'violation',
    note: '移植：变异辨别力——故意放行错位投递，fencing 不变式应击穿',
    constants: { EnableReconcile: true, EnableHandoff: true, EnableCrash: true, InjectAdoptFail: true,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: true,
      MutateStaleDeliver: true, JanitorFairness: false, DeliverFairness: false, SpawnFairness: false },
    budget: { boundHandoff: true, handoff: 3, boundCrash: true, crash: 3, boundDrift: true, drift: 2 },
  },
  {
    name: 'absent-wake-liveness',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'pass',
    note: '移植：条目缺位滞留的唤醒自愈链（requeue ensureHead，修复前后语义相同）在细化模型下仍活性成立',
    constants: { EnableReconcile: false, EnableHandoff: false, EnableCrash: true, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 2, boundDrift: true, drift: 0 },
  },
  {
    name: 'starve-handoff-storm',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    note: '移植（D12-1）：无限换头风暴饿死对账——投递活性依赖换头尝试收敛（生产的接续退避）',
    constants: { EnableReconcile: true, EnableHandoff: true, EnableCrash: false, InjectAdoptFail: true,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: false, handoff: 0, boundCrash: true, crash: 0, boundDrift: true, drift: 0 },
  },
  {
    name: 'starve-crash-loop',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    note: '移植（D12-2）：无限崩溃循环饿死投递（拉起即死 / 退出收割无预算）——与死锁无关的饥饿类',
    constants: { EnableReconcile: true, EnableHandoff: false, EnableCrash: true, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: true, handoff: 0, boundCrash: false, crash: 0, boundDrift: true, drift: 0 },
  },
  {
    name: 'starve-drift-storm',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    note: '新（D12-3）：无限绑定漂移风暴饿死对账——janitor 两拍收敛结构下，每次扫描都撞 foreign 走唤醒分支，',
    // eslint-disable-next-line @stylistic/max-len -- 场景注记
    note2: '对账拍永不发生；WF(JanitorActs) 被 Wake 分支无限代偿满足。生产对应物：shared-by-project 机器速度借用 / 高频会话切换',
    constants: { EnableReconcile: true, EnableHandoff: false, EnableCrash: false, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: true,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 0, boundDrift: false, drift: 0 },
  },
  {
    name: 'adopt-repeat-starve',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    note: '新：采纳反复失败饥饿——runtime 活着、绑定 head，但永不采纳身份：janitor 对账每轮都失败，',
    // eslint-disable-next-line @stylistic/max-len -- 场景注记
    note2: '修复后活性仍失守。投递活性隐含依赖「采纳最终成功或 runtime 重启」，这是 D12 之外第三条饥饿轴',
    constants: { EnableReconcile: true, EnableHandoff: false, EnableCrash: false, InjectAdoptFail: false,
      AdoptFailForever: true, SpawnInjectsIdentity: false, EnableReadyDrop: false, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 0, boundDrift: true, drift: 0 },
  },
  {
    name: 'ready-drop-starve',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'violation',
    note: '新：ready 信号丢失饥饿（11-16 迟到就绪补偿之前的语义，wt-a258c93b 事故类）——',
    // eslint-disable-next-line @stylistic/max-len -- 场景注记
    note2: '就绪信号被丢后一切健康但永久静默',
    constants: { EnableReconcile: false, EnableHandoff: false, EnableCrash: false, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: true, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 0, boundDrift: true, drift: 0 },
  },
  {
    name: 'ready-drop-janitored',
    spec: 'LiveSpec', property: 'PendingLeadsToDelivered', expect: 'pass',
    note: '新：ready 信号丢失 + janitor 对账 → 活性恢复（对账兜住了信号丢失的残余，量化 11-18 修复与 11-16 修复的覆盖关系）',
    constants: { EnableReconcile: true, EnableHandoff: false, EnableCrash: false, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: true, EnableBindDrift: false,
      MutateStaleDeliver: false, JanitorFairness: true, DeliverFairness: true, SpawnFairness: true },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 0, boundDrift: true, drift: 0 },
  },
  {
    name: 'direct-overtake-reachable',
    spec: 'Spec', invariant: 'NoCrossPathOvertake', expect: 'violation',
    note: '新：跨路径超车可达——更早入箱的指令还在 pending，更晚的输入已直投落在 runtime 当前会话',
    // eslint-disable-next-line @stylistic/max-len -- 场景注记
    note2: '（wt-1ab8a75b 10:09 新消息秒达而旧 4 条纹丝不动；线程 FIFO 保证不跨路径成立）',
    constants: { EnableReconcile: true, EnableHandoff: false, EnableCrash: false, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: true,
      MutateStaleDeliver: false, JanitorFairness: false, DeliverFairness: false, SpawnFairness: false },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 0, boundDrift: true, drift: 2 },
  },
  {
    name: 'offthread-direct-reachable',
    spec: 'Spec', invariant: 'NoOffThreadDirect', expect: 'violation',
    note: '新：输入静默落错地方可达——绑定漂移下直投成功 = 消息落在无关会话而非线程 head',
    constants: { EnableReconcile: true, EnableHandoff: false, EnableCrash: false, InjectAdoptFail: false,
      AdoptFailForever: false, SpawnInjectsIdentity: true, EnableReadyDrop: false, EnableBindDrift: true,
      MutateStaleDeliver: false, JanitorFairness: false, DeliverFairness: false, SpawnFairness: false },
    budget: { boundHandoff: true, handoff: 0, boundCrash: true, crash: 0, boundDrift: true, drift: 2 },
  },
];

const model = path.join(output, 'HostDeliveryPlane.tla');
writeFileSync(model, readFileSync(path.join(here, 'HostDeliveryPlane.tla')));
const results = [];
for (const item of cases) {
  const lines = [`SPECIFICATION ${item.spec}`, 'CONSTANTS', ' CommandCount = 2', ' MaxGen = 2'];
  for (const key of BOOLEANS) lines.push(` ${key} = ${item.constants[key] ? 'TRUE' : 'FALSE'}`);
  lines.push(` BoundHandoff = ${item.budget.boundHandoff ? 'TRUE' : 'FALSE'}`,
    ` BoundCrash = ${item.budget.boundCrash ? 'TRUE' : 'FALSE'}`,
    ` BoundDrift = ${item.budget.boundDrift ? 'TRUE' : 'FALSE'}`,
    ` HandoffBudget = ${item.budget.handoff}`, ` CrashBudget = ${item.budget.crash}`,
    ` DriftBudget = ${item.budget.drift}`);
  if (item.invariants) lines.push(`INVARIANTS ${item.invariants.join(' ')}`);
  if (item.invariant) lines.push(`INVARIANT ${item.invariant}`);
  if (item.property) lines.push(`PROPERTY ${item.property}`);
  const config = path.join(output, `${item.name}.cfg`);
  writeFileSync(config, `${lines.join('\n')}\n`);
  console.log(`START ${item.name}`);
  const run = spawnSync(process.env.JAVA || 'java', ['-XX:+UseParallelGC', '-Xmx1g', '-jar', jar,
    '-workers', '1', '-seed', '1', '-fp', '0', '-deadlock', '-metadir', path.join(output, `states-${item.name}`),
    '-config', config, model], { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
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
