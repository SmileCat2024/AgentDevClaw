/**
 * AgenteroFeature 工具面测试 — mock CLI 执行器，覆盖：
 * - 信封解析三态（ok:true / ok:false / 非 JSON）
 * - 参数映射（--vault 注入、--query/--tag/--unread 透传、set-read --false 条件）
 * - 未配置 vaultPath 时不注入 --vault（CLI 自身解析链兜底）
 * - REF 校验（拒绝空值与 - 开头的 flag 注入）
 * - 工具返回形态（text 列表 / total / 错误 + hint）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgenteroFeature,
  AgenteroCliError,
  runAgenteroCli,
} from '../src/index.js';
import type { AgenteroCliExecutor } from '../src/index.js';

type Call = { args: string[]; vaultPath?: string };

function mockExecutor(
  stdout: string,
  options: { stderr?: string; fail?: 'spawn' | 'nonzero' } = {},
): { exec: AgenteroCliExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const exec: AgenteroCliExecutor = async (args, opts) => {
    calls.push({ args, vaultPath: opts?.vaultPath });
    if (options.fail === 'spawn') {
      throw new Error('spawn ENOENT');
    }
    return { stdout, stderr: options.stderr ?? '' };
  };
  return { exec, calls };
}

const okEnvelope = (data: unknown) => JSON.stringify({ ok: true, data });

const SAMPLE_ROWS = [
  {
    id: 'arxiv-1706.03762',
    path: 'papers/arxiv-1706.03762',
    title: 'Attention Is All You Need',
    year: 2017,
    authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
    tags: ['transformer'],
    is_read: false,
  },
  {
    id: 'arxiv-2005.14165',
    path: 'papers/arxiv-2005.14165',
    title: 'Language Models are Few-Shot Learners',
    year: 2020,
    authors: ['Tom Brown', 'Benjamin Mann', 'Vinyals'],
    tags: ['gpt-3', 'few-shot'],
    is_read: true,
  },
];

function makeFeature(exec: AgenteroCliExecutor, vaultPath = 'C:\\vault\\fixture') {
  return new AgenteroFeature({ vaultPath, exec });
}

function getTool(feature: AgenteroFeature, name: string) {
  const tool = feature.getTools().find((t) => t.name === name);
  assert.ok(tool, `tool not found: ${name}`);
  return tool as { execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
}

// ── runAgenteroCli 信封解析 ─────────────────────────────────────

test('runAgenteroCli resolves ok:true envelope data', async () => {
  const { exec } = mockExecutor(okEnvelope({ count: 3 }));
  const data = await runAgenteroCli<{ count: number }>(['vault', 'list', '--json'], { exec });
  assert.equal(data.count, 3);
});

test('runAgenteroCli throws AgenteroCliError with CLI code on ok:false', async () => {
  const { exec } = mockExecutor(
    JSON.stringify({ ok: false, error: { code: 'paper-not-found', message: 'no such paper' } }),
  );
  await assert.rejects(
    runAgenteroCli(['paper', 'get', 'x', '--json'], { exec }),
    (err: unknown) => {
      assert.ok(err instanceof AgenteroCliError);
      assert.equal(err.code, 'paper-not-found');
      assert.match(err.message, /no such paper/);
      return true;
    },
  );
});

test('runAgenteroCli throws on non-JSON stdout', async () => {
  const { exec } = mockExecutor('plain text output', { stderr: 'warning line' });
  await assert.rejects(
    runAgenteroCli(['paper', 'list', '--json'], { exec }),
    (err: unknown) => {
      assert.ok(err instanceof AgenteroCliError);
      assert.equal(err.code, 'cli-output-not-json');
      return true;
    },
  );
});

test('runAgenteroCli throws on envelope without ok field', async () => {
  const { exec } = mockExecutor('{"data":[]}');
  await assert.rejects(
    runAgenteroCli(['paper', 'list', '--json'], { exec }),
    (err: unknown) => {
      assert.ok(err instanceof AgenteroCliError);
      assert.equal(err.code, 'cli-output-not-envelope');
      return true;
    },
  );
});

// ── agentero_papers ─────────────────────────────────────────────

test('agentero_papers maps query/tag/unread to CLI flags and vault to --vault', async () => {
  const { exec, calls } = mockExecutor(okEnvelope(SAMPLE_ROWS));
  const tool = getTool(makeFeature(exec), 'agentero_papers');
  const result = await tool.execute({ query: 'attention', tag: ['transformer', 'nlp'], unread: true });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].vaultPath, 'C:\\vault\\fixture');
  assert.deepEqual(calls[0].args, [
    'paper', 'list', '--json', '--fields', 'title,year,authors,tags,is_read',
    '--query', 'attention',
    '--tag', 'transformer',
    '--tag', 'nlp',
    '--unread',
  ]);
  assert.equal(result.total, 2);
  assert.match(result.text as string, /共 2 篇/);
  assert.match(result.text as string, /Attention Is All You Need/);
  assert.match(result.text as string, /未读/);
  assert.match(result.text as string, /gpt-3/);
});

test('agentero_papers with no filters sends bare list command', async () => {
  const { exec, calls } = mockExecutor(okEnvelope(SAMPLE_ROWS));
  const tool = getTool(makeFeature(exec), 'agentero_papers');
  await tool.execute({});
  assert.deepEqual(calls[0].args, [
    'paper', 'list', '--json', '--fields', 'title,year,authors,tags,is_read',
  ]);
});

test('agentero_papers on empty vault reports empty', async () => {
  const { exec } = mockExecutor(okEnvelope([]));
  const tool = getTool(makeFeature(exec), 'agentero_papers');
  const result = await tool.execute({});
  assert.equal(result.total, 0);
  assert.match(result.text as string, /没有匹配/);
});

test('agentero_papers turns CLI failure into error + hint (no throw)', async () => {
  const { exec } = mockExecutor(
    JSON.stringify({ ok: false, error: { code: 'vault-not-found', message: 'vault missing' } }),
  );
  const tool = getTool(makeFeature(exec), 'agentero_papers');
  const result = await tool.execute({});
  assert.match(result.error as string, /vault-not-found/);
  assert.match(result.hint as string, /vaultPath/);
});

// ── agentero_paper_get ──────────────────────────────────────────

test('agentero_paper_get passes ref as positional arg and unwraps {assets, paper}', async () => {
  // 真实 CLI 结构：data = {assets:{pdf:true,...}, paper:{id,title,...}}，工具解包平铺。
  const { exec, calls } = mockExecutor(okEnvelope({
    assets: { pdf: true, tex: true, notesMd: false, marksDir: false, paperMd: false },
    paper: { id: '1706.03762', title: 'Attention Is All You Need' },
  }));
  const tool = getTool(makeFeature(exec), 'agentero_paper_get');
  const result = await tool.execute({ id: '1706.03762' });
  assert.deepEqual(calls[0].args, ['paper', 'get', '1706.03762', '--json']);
  assert.equal((result.paper as { id: string }).id, '1706.03762');
  assert.deepEqual(result.assets, { pdf: true, tex: true, notesMd: false, marksDir: false, paperMd: false });
});

test('agentero_paper_get rejects flag-like refs', async () => {
  const { exec, calls } = mockExecutor(okEnvelope({}));
  const tool = getTool(makeFeature(exec), 'agentero_paper_get');
  const result = await tool.execute({ id: '--query' });
  assert.match(result.error as string, /无效/);
  assert.equal(calls.length, 0);
});

test('agentero_paper_get rejects empty id', async () => {
  const { exec, calls } = mockExecutor(okEnvelope({}));
  const tool = getTool(makeFeature(exec), 'agentero_paper_get');
  const result = await tool.execute({ id: '  ' });
  assert.match(result.error as string, /无效/);
  assert.equal(calls.length, 0);
});

// ── agentero_paper_set_read ─────────────────────────────────────

test('agentero_paper_set_read default marks read without extra flag', async () => {
  const { exec, calls } = mockExecutor(okEnvelope({ ok: true }));
  const tool = getTool(makeFeature(exec), 'agentero_paper_set_read');
  const result = await tool.execute({ id: 'arxiv-1706.03762' });
  assert.deepEqual(calls[0].args, ['paper', 'set-read', 'arxiv-1706.03762', '--json']);
  assert.equal(result.read, true);
});

test('agentero_paper_set_read false appends --false', async () => {
  const { exec, calls } = mockExecutor(okEnvelope({ ok: true }));
  const tool = getTool(makeFeature(exec), 'agentero_paper_set_read');
  await tool.execute({ id: 'arxiv-1706.03762', read: false });
  assert.deepEqual(calls[0].args, ['paper', 'set-read', 'arxiv-1706.03762', '--json', '--false']);
});

test('agentero_paper_set_read rejects flag-like id without spawning', async () => {
  const { exec, calls } = mockExecutor(okEnvelope({}));
  const tool = getTool(makeFeature(exec), 'agentero_paper_set_read');
  const result = await tool.execute({ id: '-y' });
  assert.match(result.error as string, /无效/);
  assert.equal(calls.length, 0);
});

// ── agentero_vault_info ─────────────────────────────────────────

test('agentero_vault_info reports configured vault and paper count', async () => {
  const { exec, calls } = mockExecutor(okEnvelope(SAMPLE_ROWS));
  const tool = getTool(makeFeature(exec), 'agentero_vault_info');
  const result = await tool.execute({});
  assert.deepEqual(calls[0].args, ['paper', 'list', '--json']);
  assert.equal(result.vaultPath, 'C:\\vault\\fixture');
  assert.equal(result.totalPapers, 2);
  assert.match(result.text as string, /2/);
});

test('agentero_vault_info without vaultPath omits --vault and reports null path', async () => {
  const { exec, calls } = mockExecutor(okEnvelope(SAMPLE_ROWS));
  const feature = new AgenteroFeature({ exec });
  const tool = getTool(feature, 'agentero_vault_info');
  const result = await tool.execute({});
  assert.equal(calls[0].vaultPath, undefined);
  assert.equal(result.vaultPath, null);
  assert.match(result.text as string, /未配置/);
});

// ── 特性元数据 ──────────────────────────────────────────────────

test('feature exposes name and four tools', () => {
  const feature = new AgenteroFeature({ vaultPath: 'x', exec: mockExecutor('{}').exec });
  assert.equal(feature.name, 'agentero');
  const names = feature.getTools().map((t) => t.name);
  assert.deepEqual(names.sort(), [
    'agentero_paper_get',
    'agentero_paper_set_read',
    'agentero_papers',
    'agentero_vault_info',
  ]);
});
