import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Small scenario runner: require exact expected diagnostic or completed exploration. */
export function checkProtocolModel(module, cases) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const jar = process.env.TLA2TOOLS_JAR || path.join(homedir(), '.local/share/tlaplus/1.7.4/tla2tools.jar');
  mkdirSync(path.join(here, 'artifacts'), { recursive: true });
  const output = mkdtempSync(path.join(here, `artifacts/${module}-`));
  const model = path.join(output, `${module}.tla`);
  writeFileSync(model, readFileSync(path.join(here, `${module}.tla`)));
  const results = [];
  for (const item of cases) {
    const config = path.join(output, `${item.name}.cfg`);
    const constants = Object.entries(item.constants).map(([key, value]) =>
      ` ${key} = ${typeof value === 'boolean' ? String(value).toUpperCase() : JSON.stringify(value)}`);
    writeFileSync(config, `SPECIFICATION Spec\nCONSTANTS\n${constants.join('\n')}\nINVARIANTS ${item.checks.join(' ')}\n${item.property ? `PROPERTY ${item.property}\n` : ''}`);
    console.log(`START ${module}:${item.name}`);
    const run = spawnSync(process.env.JAVA || 'java', ['-XX:+UseParallelGC', '-Xmx1g', '-jar', jar,
      '-workers', '1', '-seed', '1', '-fp', '0', '-metadir', path.join(output, `states-${item.name}`),
      '-config', config, model], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    const text = `${run.stdout || ''}${run.stderr || ''}`;
    writeFileSync(path.join(output, `${item.name}.log`), text);
    const expected = item.violation ? 12 : item.temporalFailure ? 13 : 0;
    const matched = !run.error && run.status === expected && (item.violation
      ? text.includes(`Invariant ${item.violation} is violated.`) && text.includes('State 1:')
      : item.temporalFailure ? text.includes('Temporal properties were violated.')
        : text.includes('Model checking completed. No error has been found.') && text.includes('0 states left on queue.'));
    const states = /([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue/.exec(text);
    const result = { name: item.name, exit: run.status, expected, matched,
      ...(states ? { generated: states[1], distinct: states[2], remaining: states[3] } : {}),
      ...(run.error ? { error: run.error.message } : {}) };
    results.push(result); console.log(JSON.stringify(result));
    if (!matched) console.error(text);
  }
  const git = dir => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ checkedAt: new Date().toISOString(),
    claw: git(path.resolve(here, '../..')), agentdev: git(path.resolve(here, '../../../AgentDev')),
    jar, cases, results }, null, 2));
  console.log(`Artifacts: ${output}`);
  console.log('Expected counterexamples are diagnostic results, not production correctness passes.');
  process.exitCode = results.every(row => row.matched) ? 0 : 1;
}
