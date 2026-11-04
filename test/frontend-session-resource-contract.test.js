import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

function readRepoFile(relPath) {
  return fs.readFileSync(new URL(`../${relPath}`, import.meta.url), 'utf8');
}

describe('session resource identity contracts', () => {
  it('maps runtime child title requests to the logical workspace agent', () => {
    const autoTitle = readRepoFile('public/src/modules/auto-title.js');
    assert.match(autoTitle, /getLogicalAgentId\(runtimeAgent\)/);
    // 会话信息对象必须以逻辑 agent 作为 agentId（而不是 runtime child id），
    // 否则标题请求会被路由到不存在的会话归属。字段的排列与同行与否不是契约。
    assert.match(autoTitle, /agentId:\s*logicalAgentId\s*\|\|\s*runtimeAgent\.id/);
    assert.match(autoTitle, /autoGenerateSessionTitle\(logicalAgentId \|\| agent\.id, sessionId/);
  });

  it('yields the shell trigger to applications that own their title policy', () => {
    // ADR-0041：已自行接管标题策略的应用（metadata titlePolicy: 'app'）由它
    // 自己的 Feature 触发生成。壳层若同时触发，同一会话会被起两次名。
    const autoTitle = readRepoFile('public/src/modules/auto-title.js');
    assert.match(autoTitle, /function isAppOwnedTitlePolicy/);
    assert.match(autoTitle, /titlePolicy/);
    // 判定必须同时覆盖 runtime child 记录与逻辑 host 记录：不同快照轮次里
    // 声明可能只出现在其中一侧。
    assert.match(autoTitle, /isValidTitleEvent/);

    const connected = readRepoFile('server/routes/agent-connected.js');
    assert.match(connected, /titlePolicy:\s*agent\.titlePolicy === 'app' \? 'app' : null/);

    const metadata = JSON.parse(readRepoFile('prebuilt-agents/official/programming-helper/metadata.json'));
    assert.equal(metadata.titlePolicy, 'app');
  });

  it('keeps the shell trigger hard-disabled instead of merely yielding', () => {
    // ADR-0041：三个对话型应用都已迁移，壳层旧触发不再作为兜底启用。
    // 代码保留作历史参照，但必须硬屏蔽——否则新应用漏装配 AutoTitlePolicyFeature
    // 时会静默回落到壳层，形成第二套触发链路。调用点保留但都是 no-op。
    const appMain = readRepoFile('public/src/app-main.js');
    assert.match(appMain, /markAutoTitleCandidate\(/);
    assert.match(appMain, /tryAutoTitleGeneration\(/);

    const autoTitle = readRepoFile('public/src/modules/auto-title.js');
    // 开关必须恒真且不可被外部注入改写。
    assert.match(autoTitle, /function isShellTitleTriggerDisabled\(\)\s*\{\s*return true;\s*\}/);
    // 每个对外入口都必须在副作用之前调用该开关。
    const guardCount = (autoTitle.match(/if \(isShellTitleTriggerDisabled\(\)\) return;/g) || []).length;
    assert.ok(guardCount >= 4,
      `expected the disable guard at every entry point (mark / recheck / try / generate), got ${guardCount}`);
  });

  it('every conversation-producing application owns its title policy', () => {
    // ADR-0041：产生对话会话的应用都必须自行决定标题策略。漏掉装配会让
    // 该应用的标题静默回落到壳层兜底（或干脆不再生成），且不容易被发现。
    for (const agentId of ['programming-helper', 'coder', 'memo']) {
      const metadata = JSON.parse(readRepoFile(`prebuilt-agents/official/${agentId}/metadata.json`));
      assert.equal(metadata.titlePolicy, 'app', `${agentId} must declare titlePolicy: 'app'`);

      const source = readRepoFile(`prebuilt-agents/official/${agentId}/agent.js`);
      assert.match(source, /new AutoTitlePolicyFeature\(/, `${agentId} must mount AutoTitlePolicyFeature`);
      // 只装配而没转交总线，Feature 收不到任何轮次事实，标题永远不会生成。
      assert.match(source, /setTurnEventBus\(bus\)/, `${agentId} must forward the turn event bus`);
    }
  });

  it('does not reference compact-session state from the managed-session finally block', () => {
    const workspaceActions = readRepoFile('public/src/modules/workspace-actions.js');
    const start = workspaceActions.indexOf('if (needsManagedSession)');
    const end = workspaceActions.indexOf("if (action.type === 'show_chat'", start);
    const managedFlow = workspaceActions.slice(start, end);
    assert.doesNotMatch(managedFlow, /clearSessionLoading\(_csAgent\.id\)/);
    assert.match(managedFlow, /clearSessionLoading\(activeAgent\.id\)/);
  });
});
