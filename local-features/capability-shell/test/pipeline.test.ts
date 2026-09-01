/**
 * 完整管线测试 — 四道检查点串联 + 工具工厂（ticket 033）
 *
 * 覆盖工单验收标准：
 * - `gh pr list --json number,title | jq '.[:5]'` 形态输入可被分段并逐段判定
 * - 含命令替换/变量/glob 的输入 100% 被拒绝且报错含可用动词清单
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runCapabilityShellPipeline, createCapabilityShellTool } from '../src/tool-factory.js';
import type { CapabilityShellToolOptions } from '../src/tool-factory.js';
import type { CapabilityShellPolicy } from '../src/types.js';

/** 测试用 adapter map（键 = 动词声明的 adapter key）。 */
const adapters = {
  'gh-adapter': async (args: string[]) => `gh called: ${args.join(' ')}`,
  'jq-adapter': async (args: string[], ctx?: { stdin: string }) =>
    `jq:${args[0] ?? ''} stdin=${ctx?.stdin ?? ''}`,
  'pr_list_adapter': async () => 'pr-1\npr-2',
  'pr_view_adapter': async (args: string[]) => `view:${args[0] ?? ''}`,
  'upper_adapter': async (args: string[], ctx?: { stdin: string }) =>
    (ctx?.stdin ?? '').toUpperCase(),
  'read_adapter': async () => 'file-content',
};

/** 测试用领域策略（bashPath: null 时语法道降级跳过，管线由结构道兜底）。 */
const POLICY: CapabilityShellPolicy = {
  name: 'test_shell',
  description: '测试用领域 shell',
  verbs: {
    'pr_list': {
      description: '列出 PR',
      params: [],
      adapter: { key: 'pr_list_adapter' },
    },
    'pr_view': {
      description: '查看 PR',
      params: [{ name: 'number', kind: 'literal' }],
      usage: 'pr_view <number>',
      adapter: { key: 'pr_view_adapter' },
    },
    'upper': {
      description: '转大写',
      params: [],
      adapter: { key: 'upper_adapter' },
    },
  },
};

const OPTS: CapabilityShellToolOptions = {
  bashPath: null, // 降级：语法道跳过（结构/动词/参数道覆盖拒绝语义）
};

describe('capability-shell 完整管线', () => {
  it('工单验收形态：gh pr list --json number,title | jq \'.[:5]\' 可被分段并逐段判定', async () => {
    // 动词表模拟 github 形态（本票只验管线，不实现 github 动词表）
    const policy: CapabilityShellPolicy = {
      name: 'githubish',
      description: 'test',
      verbs: {
        'gh': {
          description: 'GitHub CLI',
          params: [
            { name: 'resource', kind: 'literal' },
            { name: 'action', kind: 'literal' },
            { name: 'flag', kind: 'literal' },
            { name: 'fields', kind: 'literal' },
          ],
          adapter: { key: 'gh-adapter' },
        },
        'jq': {
          description: 'JSON 处理',
          params: [{ name: 'filter', kind: 'literal' }],
          adapter: { key: 'jq-adapter' },
        },
      },
    };
    const result = await runCapabilityShellPipeline(
      policy,
      "gh pr list --json number,title | jq '.[:5]'",
      {
        adapters: {
          'gh-adapter': async () => 'GH_OUTPUT',
          'jq-adapter': async (args, ctx) => `jq:${args[0]} stdin=${ctx?.stdin ?? ''}`,
        },
        bashPath: null, // 跳过 bash -n（结构道已覆盖该输入的验收）
      },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    // 管道语义：gh 段输出应作为上游数据流到 jq 段（内存串流）
    assert.ok(result.output.includes('GH_OUTPUT'), `上游输出应流入下游: ${result.output}`);
    assert.ok(result.output.includes('.[:5]'));
  });

  it('四道全过后分派到进程内 adapter 并返回输出', async () => {
    const result = await runCapabilityShellPipeline(POLICY, 'pr_view 42', {
      adapters,
      bashPath: null,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.output, 'view:42');
  });

  it('管道多段：逐段判定 + adapter 依次分派（上游数据流入下游 stdin）', async () => {
    const result = await runCapabilityShellPipeline(POLICY, 'pr_list | upper', {
      adapters,
      bashPath: null,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    // upper adapter 消费上游 pr_list 输出并转大写
    assert.equal(result.output, 'PR-1\nPR-2');
  });

  it('含命令替换的输入 100% 拒绝且报错含可用动词清单', async () => {
    for (const cmd of ['pr_view $(cat id)', 'pr_view `id`']) {
      const r = await runCapabilityShellPipeline(POLICY, cmd, {
        adapters,
        bashPath: null, // 降级：语法道跳过，结构道必须拦住
      });
      assert.equal(r.ok, false, `应拒绝: ${cmd}`);
      assert.ok(r.output.includes('pr_list'), `拒绝文案应含可用动词: ${r.output}`);
    }
  });

  it('含变量的输入 100% 被拒绝', async () => {
    const r = await runCapabilityShellPipeline(POLICY, 'pr_view $ID', {
      adapters,
      bashPath: null,
    });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('可用动词'), r.output);
  });

  it('含 glob 的输入被拒绝且报错含可用动词清单', async () => {
    const r = await runCapabilityShellPipeline(POLICY, 'pr_view *', {
      adapters,
      bashPath: null,
    });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('可用动词'));
  });

  it('未知动词 → 拒绝并列出可用动词清单', async () => {
    const r = await runCapabilityShellPipeline(POLICY, 'unknown_verb x', {
      adapters,
      bashPath: null,
    });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('可用动词'));
    assert.ok(r.output.includes('pr_list'));
  });

  it('参数个数不符 → arg_rejected 文案含用法', async () => {
    const r = await runCapabilityShellPipeline(POLICY, 'pr_view', {
      adapters,
      bashPath: null,
    });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('参数'));
    assert.ok(r.output.includes('pr_view <number>'));
  });

  it('路径参数逃逸 workspace 被拒绝', async () => {
    const policy: CapabilityShellPolicy = {
      name: 'pathy',
      description: '',
      verbs: {
        'read': {
          description: '',
          params: [{ name: 'file', kind: 'path' }],
          adapter: { key: 'read-adapter' },
        },
      },
    };
    const r = await runCapabilityShellPipeline(policy, 'read ../../etc/passwd', {
      adapters: { 'read-adapter': async () => 'x' },
      bashPath: null,
    });
    assert.equal(r.ok, false);
    assert.ok(r.output.includes('..'));
  });
});

describe('capability-shell 工具工厂', () => {
  it('createCapabilityShellTool 产出 name/description/parameters 齐备的 Tool', () => {
    const tool = createCapabilityShellTool(POLICY, adapters, { bashPath: null });
    assert.equal(tool.name, 'test_shell');
    assert.ok(tool.description.includes('pr_list'));
    assert.ok(tool.timeout); // 超时唯一闸门 = 框架 Tool.timeout 契约
    assert.deepEqual(tool.parameters?.required, ['command']);
    // 策略未声明 parallelizable → 不透传（按框架默认串行）
    assert.equal(tool.parallelizable, undefined);
  });

  it('工具 execute：拒绝文案经返回值给模型', async () => {
    const tool = createCapabilityShellTool(POLICY, adapters, { bashPath: null });
    const out = await tool.execute({ command: 'pr_view $(id)' });
    assert.ok(String(out).includes('可用动词'));
  });

  it('工具 execute 正常路径返回 adapter 输出', async () => {
    const tool = createCapabilityShellTool(POLICY, adapters, { bashPath: null });
    const out = await tool.execute({ command: 'pr_view 7' });
    assert.equal(out, 'view:7');
  });
});
