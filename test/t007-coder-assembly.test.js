/**
 * T007 真实本地运行链：coder successor 的提示词、工具没有退回 main。
 *
 * 既有测试（agent-lifecycle.test.js）覆盖的是「投影」层——coder 会话的
 * 侧栏投影条目与子进程路由；本文件覆盖「装配」层：真实 import 生产
 * agent 模块、经 resolveAgentClass 按 sessionType 分派、真实实例化
 * Agent 类、strict 初始化全部 feature、渲染真实系统提示词、读回真实
 * 工具表。子进程 probe（fixtures/t007-coder-assembly-probe.mjs）HOME
 * 隔离，不触碰真实用户数据目录。
 *
 * 断言三层：
 * 1. 身份分派：sessionType=coder → CoderAgent；main → ProgrammingHelperAgent；
 * 2. 提示词：coder 提示词含 coder 身份标记、不含 main 身份标记（互斥，
 *    防止装配退回 main 时两个标记同时出现或互换）；
 * 3. 工具：coder 工具集不含 main 独有的交互工具（ask_user_choice /
 *    ui_surface_* / mcp_*），且保留 coder 专属的 tickets_flow_skill——
 *    两侧工具集存在真实差异即证明装配没有共用同一实例。
 *
 * 竞态/时序：spawn 子进程 + 120s 硬超时兜底（probe 实测 <2s；超时视为
 * 装配挂起，确定性失败而非 sleep 猜测）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_PATH = path.join(REPO_ROOT, 'test', 'fixtures', 't007-coder-assembly-probe.mjs');

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE_PATH], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`probe timeout (120s): assembly hung\nstderr:\n${stderr.slice(-4000)}`));
    }, 120_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`probe exited ${code}\nstderr:\n${stderr.slice(-4000)}`));
        return;
      }
      // stdout 只应有一行 JSON（probe 纪律）；框架日志走 stderr
      const lastLine = stdout.trim().split('\n').pop();
      try {
        resolve(JSON.parse(lastLine));
      } catch (err) {
        reject(new Error(`probe output not JSON: ${err.message}\nstdout:\n${stdout.slice(-2000)}`));
      }
    });
  });
}

describe('T007 真实运行链：coder 身份装配（提示词 + 工具未退回 main）', () => {
  let assembly;

  describe('probe 结果（真实 import + 真实实例化 + strict 装配）', { timeout: 130_000 }, () => {
    it('resolveAgentClass 按 sessionType 分派到不同 Agent 类', async () => {
      assembly = await runProbe();
      assert.equal(assembly.coder.className, 'CoderAgent', 'coder 会话装配 CoderAgent');
      assert.equal(assembly.main.className, 'ProgrammingHelperAgent', 'main 会话装配 ProgrammingHelperAgent');
      assert.notEqual(assembly.coder.className, assembly.main.className);
    });

    it('提示词：coder 与 main 身份标记互斥（装配未退回 main）', async () => {
      const { coder, main } = assembly || (assembly = await runProbe());
      assert.equal(coder.hasCoderPrompt, true, 'coder 提示词含 coder 身份标记');
      assert.equal(coder.hasMainPrompt, false, 'coder 提示词不含 main 身份标记（未退回）');
      assert.equal(main.hasMainPrompt, true, 'main 提示词含 main 身份标记');
      assert.equal(main.hasCoderPrompt, false, 'main 提示词不含 coder 身份标记');
      assert.notEqual(coder.promptLen, main.promptLen, '两套提示词真实不同（非同一模板）');
    });

    it('工具集：coder 不含 main 交互工具，且保留 coder 专属构建流程工具', async () => {
      const { coder, main } = assembly || (assembly = await runProbe());
      const coderTools = new Set(coder.tools);
      const mainTools = main.tools; // 数组（保留顺序供 filter）
      const mainToolSet = new Set(mainTools);

      // main 独有的交互/面板/MCP 工具：coder（无人值守）必须没有
      const mainOnlyTools = mainTools.filter((name) => !coderTools.has(name));
      assert.ok(mainOnlyTools.length > 0, '两侧工具集存在真实差异');
      for (const name of ['ask_user_choice', 'ui_surface_upsert', 'ui_surface_get', 'ui_surface_list', 'ui_surface_close']) {
        assert.ok(mainToolSet.has(name), `main 应有交互工具 ${name}（fixture 前提）`);
        assert.ok(!coderTools.has(name), `coder 不得装配 main 交互工具 ${name}（无人值守场景会永久 pending）`);
      }
      // MCP：coder 刻意不挂 MCPFeature（无人值守），无论环境如何都成立。
      // main 侧挂载 MCPFeature，但 mcp_* 工具需真实 MCP server 配置才注册，
      // probe HOME 隔离环境没有，故不对 main 做环境依赖的硬断言。
      const mcpInCoder = coder.tools.filter((n) => n.startsWith('mcp_'));
      assert.equal(mcpInCoder.length, 0, 'coder 不装配 MCP 工具');

      // coder 专属：tickets-build-flow 构建流程规范（implement / tdd / code-review）
      assert.ok(coderTools.has('tickets_flow_skill'), 'coder 装配 tickets_flow_skill');
      assert.ok(!mainToolSet.has('tickets_flow_skill'), 'main 不装配 tickets_flow_skill');

      // 执行类工具链共享底座：两侧都有核心读写/命令工具
      for (const name of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
        assert.ok(coderTools.has(name) && mainToolSet.has(name), `共享底座工具 ${name} 两侧齐备`);
      }
    });
  });
});
