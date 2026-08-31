/**
 * T007 真实运行链 probe：驱动 prebuilt-agents/official/programming-helper
 * 的生产装配链（resolveAgentClass → new AgentClass → ensureFeatureTools
 * strict → onInitiate → 提示词渲染 + 工具表），输出 JSON 供测试断言。
 *
 * 在独立子进程运行（HOME/USERPROFILE 指向临时目录），不读真实用户数据；
 * 测试文件 spawn 本脚本并解析 stdout 的最后一行 JSON。
 *
 * 证明目标：coder successor 会话（sessionType=coder）经 resolveAgentClass
 * 分派到 CoderAgent，提示词与工具集是 coder 身份而非退回 main。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_MODULE = path.join(REPO_ROOT, 'prebuilt-agents', 'official', 'programming-helper', 'agent.js');

// HOME 隔离必须发生在 import agent.js 之前：server/shared/constants.js 的
// USER_DATA_ROOT 在模块加载期取 os.homedir()（动态 import 保证求值顺序）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-t007-probe-home-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-t007-probe-ws-'));

const fakeLlm = { modelName: 't007-probe', chat: async () => { throw new Error('no llm in probe'); } };

async function probeIdentity(sessionType) {
  const agentModule = await import(pathToFileURL(AGENT_MODULE).href);
  const AgentClass = agentModule.resolveAgentClass({ runtime: { sessionType } });
  const agent = new AgentClass({
    name: sessionType,
    workspaceDir,
    llm: fakeLlm,
    runtime: { agentId: 'programming-helper', sessionId: `t007-probe-${sessionType}` },
  });
  await agent.ensureFeatureTools({ strict: true });
  await agent.onInitiate({});
  const prompt = await agent.templateResolver.resolve();
  const tools = agent.getTools().getAll().map((tool) => tool.name);
  return {
    className: AgentClass.name,
    promptLen: prompt.length,
    hasCoderPrompt: prompt.includes('自动化编码智能体'),
    hasMainPrompt: prompt.includes('编程小助手'),
    toolCount: tools.length,
    tools,
  };
}

let exitCode = 0;
try {
  const result = {
    coder: await probeIdentity('coder'),
    main: await probeIdentity('main'),
  };
  console.log(JSON.stringify(result));
} catch (error) {
  process.stderr.write(`probe failed: ${error && error.stack || error}\n`);
  exitCode = 1;
} finally {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  // MCP/HTTP feature 持有 socket 不退出 event loop：probe 是单向快照，
  // 结果落 stdout 后显式退出（生产装配链的退出语义由 runtime 宿主负责）。
  process.exit(exitCode);
}
