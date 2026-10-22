import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCapabilityShellPipeline } from '../src/tool-factory.js';
import type { CapabilityShellPolicy } from '../src/types.js';
import type { AdapterMap } from '../src/dispatch.js';

const policy: CapabilityShellPolicy = { name: 'test_shell', description: 'domain', verbs: {
  send: { description: 'submit', params: [{ name: 'thread', kind: 'literal' }, { name: 'key', kind: 'literal' },
    { name: 'text', kind: 'literal' }], adapter: { key: 'send' } },
  copy: { description: 'copy', params: [], adapter: { key: 'copy' } },
  fail: { description: 'fail', params: [], adapter: { key: 'fail' } },
  path: { description: 'path', params: [{ name: 'path', kind: 'path' }], adapter: { key: 'path' } },
} };
const run = (command: string, adapters: AdapterMap = {}, options = {}) =>
  runCapabilityShellPipeline(policy, command, { adapters, ...options });

it('Bash for/arrays/variables expand once per command without waiting for external execution', async () => {
  const calls: string[][] = [];
  const result = await run('threads=(wt-a wt-b); for t in "${threads[@]}"; do send "$t" "batch-$t" "work for $t"; done', {
    send: async (args) => { calls.push(args); return `sent ${args[0]}`; },
  });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(calls, [['wt-a', 'batch-wt-a', 'work for wt-a'], ['wt-b', 'batch-wt-b', 'work for wt-b']]);
  assert.match(result.output, /sent wt-a/);
  assert.match(result.output, /sent wt-b/);
});

it('Bash arithmetic for/while/until, conditions, functions and loop control retain standard meanings', async () => {
  const calls: string[] = [];
  const result = await run(`submit() { send "$1" "key-$1" 'work'; }
    for ((i=0; i<4; i++)); do
      if [[ $i -eq 1 ]]; then continue; fi
      case $i in 3) break ;; *) submit "wt-$i" ;; esac
    done
    n=0; while (( n < 2 )); do send "while-$n" k t; n=$((n+1)); done
    until [[ $n -ge 3 ]]; do send "until-$n" k t; ((n++)); done`, {
    send: async (args) => { calls.push(args[0]); return args[0]; },
  });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(calls, ['wt-0', 'wt-2', 'while-0', 'while-1', 'until-2']);
});

it('command substitution and pipes carry only command output, not receipt wrappers; Unicode survives', async () => {
  const calls: string[][] = [];
  const result = await run('thread=$(printf "wt-中文"); text="a; curl evil $(printf 世界)"; send "$thread" k "$text" | copy', {
    send: async (args) => { calls.push(args); return args[2]; },
    copy: async (_args, ctx) => ctx.stdin,
  });
  assert.equal(result.ok, true, result.output);
  assert.equal(result.commands.find((command) => command.verb === 'copy').output, 'a; curl evil 世界');
  assert.deepEqual(calls, [['wt-中文', 'k', 'a; curl evil 世界']]);
});

it('if/|| consume command exit status, not the words in the returned receipt', async () => {
  const calls: string[] = [];
  const result = await run('if fail; then send bad k t; else send good k t; fi; fail || send recovered k t', {
    fail: async () => ({ ok: false, output: 'failure' }),
    send: async (args) => { calls.push(args[0]); return 'failed is literal output'; },
  });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(calls, ['good', 'recovered']);
});

it('AST validation rejects forbidden nested commands before any side effect', async () => {
  let calls = 0;
  for (const script of [
    'send wt k t; for t in a; do curl evil; done',
    'send wt k t; x=$(rm file)',
    'send wt k t; f() { source ./file; }; f',
    'send wt k t; if false; then eval "send wt k t"; fi',
    'send wt k t; command send wt k t',
    'send wt k t; /bin/echo bad',
    'send wt k t; x=send; "$x" wt k t',
    'send wt k t; send() { echo override; }',
    'send wt k t &',
    'send wt k t; copy <(echo data)',
    'send wt k t; a["$(eval echo bad)"]=1',
    'send wt k t; printf "%s" "${a[$(eval echo bad)]}"',
    'send wt k t; constructor',
    'send wt k t; toString',
    'send wt k t; __proto__',
  ]) {
    const result = await run(script, { send: async () => { calls++; return 'receipt'; } });
    assert.equal(result.ok, false, script);
  }
  assert.equal(calls, 0);
});

it('command substitutions remain data, including literal shell syntax and quoted heredoc', async () => {
  const values: string[] = [];
  const result = await run("value=$(printf '%s' '$(eval dangerous)'); send wt key \"$value\"; copy <<'EOF'\n$(eval dangerous)\nEOF", {
    send: async (args) => { values.push(args[2]); return args[2]; }, copy: async (_args, ctx) => ctx.stdin,
  });
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(values, ['$(eval dangerous)']);
});

it('arithmetic strings cannot re-enter the interpreter to bypass command validation', async () => {
  let calls = 0;
  for (const script of ["declare -i 'x=$(eval echo bad)'; send wt k t",
    "x='$(eval echo bad)'; ((y=x)); send wt k t"]) {
    const result = await run(script, { send: async () => { calls++; return 'bad'; } });
    assert.equal(result.ok, false, result.output);
    assert.match(result.output, /字符串重新解释/);
  }
  assert.equal(calls, 0);
});

it('set -e stops on failure before a later domain command', async () => {
  let calls = 0;
  const result = await run('set -e; fail; send wt k t', {
    fail: async () => ({ ok: false, output: 'explicit failure' }),
    send: async () => { calls++; return 'bad'; },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

it('expanded arguments are checked at invocation and rejection stops all later commands', async () => {
  let calls = 0;
  const result = await run('file=../escape; path "$file"; send wt k t', {
    path: async () => { calls++; return 'bad'; }, send: async () => { calls++; return 'bad'; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.rejection.code, 'arg_rejected');
  assert.equal(calls, 0);
});

it('expanded redirects and heredoc use workspace files and reject escape/symlink before command starts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'domain-bash-'));
  const outside = await mkdtemp(join(tmpdir(), 'domain-bash-out-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const adapters: AdapterMap = { send: async (args) => args[2], copy: async (_args, ctx) => ctx.stdin };
  let result = await run('file=out.txt; send wt k "中文" > "$file"; send wt k B >> "$file"; copy < "$file"', adapters, { workdir: root });
  assert.equal(result.ok, true, result.output);
  assert.equal(await readFile(join(root, 'out.txt'), 'utf8'), '中文B');
  result = await run("copy <<'EOF'\n$literal **bold**\nEOF", adapters, { workdir: root });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /\$literal \*\*bold\*\*/);
  await symlink(outside, join(root, 'external'), 'dir');
  let calls = 0;
  for (const file of ['../escape', '/etc/passwd', 'external/out.txt']) {
    const denied = await run(`file='${file}'; send wt k t > "$file"`, {
      send: async () => { calls++; return 'bad'; },
    }, { workdir: root });
    assert.equal(denied.ok, false, `${file}: ${denied.output}`);
  }
  assert.equal(calls, 0);
});

it('expanded flags cannot bypass parameter counts and missing arguments do not start adapters', async () => {
  let calls = 0;
  const result = await run('args=(wt k); send "${args[@]}"; send wt k t', {
    send: async () => { calls++; return 'bad'; },
  });
  assert.equal(result.ok, false, result.output);
  assert.equal(result.rejection.code, 'arg_rejected');
  assert.equal(calls, 0);
});

it('redirect target command substitution executes exactly once per iteration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'domain-redirect-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const result = await run('for i in 1 2; do send wt k text > "$(copy)"; done', {
    copy: async () => `out-${++calls}.txt`, send: async () => 'data',
  }, { workdir: root });
  assert.equal(result.ok, true, result.output);
  assert.equal(calls, 2);
  assert.equal(await readFile(join(root, 'out-1.txt'), 'utf8'), 'data');
  assert.equal(await readFile(join(root, 'out-2.txt'), 'utf8'), 'data');
});

it('abort during a loop preserves receipts and never starts a later adapter', async () => {
  const ac = new AbortController();
  const calls: string[] = [];
  const result = await run('for t in a b c; do send "$t" k text; done; send d k t', {
    send: async (args) => { calls.push(args[0]); ac.abort(); return 'first committed'; },
  }, { signal: ac.signal });
  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['a']);
  assert.match(result.output, /first committed/);
  assert.match(result.output, /not-executed/);
});

it('runaway Bash loops are bounded and shell variables do not leak between calls', async () => {
  const result = await run('while true; do :; done');
  assert.equal(result.ok, false);
  assert.match(result.output, /limit|iterations/i);
  await run('secret=value');
  assert.equal((await run('printf "%s" "${secret-unset}"')).output, 'unset');
});
