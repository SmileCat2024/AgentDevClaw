import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Context, CoreLifecycle, discover, HandoffSeedFeature, HooksRegistry, TodoFeature } from '@agentdevjs/core';
import {
  CraftAwarenessFeature,
  shouldRemindDocCraft,
  shouldRemindDesignTrace,
  loadKnowledgeDir,
  DOC_CRAFT_MIN_WRITE_LINES,
} from '../src/index.js';

/** 构造恰好 N 行的内容（N 个以 \n 分隔的行）。 */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

/** 编译产物旁的真实 knowledge 目录（copy 脚本拷入 dist 的那份）。 */
const REAL_KNOWLEDGE_DIR = fileURLToPath(new URL('../src/knowledge', import.meta.url));

// 仅验证技能发现和发布内容一致性，不据此推断模型会遵守技能。
describe('grill-me（技能发现与构建同步）', () => {
  const skillsDir = join(dirname(new CraftAwarenessFeature().source), 'skills');
  const skillPath = join(skillsDir, 'grill-me', 'SKILL.md');
  const sourcePath = fileURLToPath(new URL('../../../craft-awareness/skills/grill-me/SKILL.md', import.meta.url));

  it('从 feature source 同级发现 grill-me，并解析其元数据', async () => {
    const skills = await discover({ dir: skillsDir });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'grill-me');
    assert.equal(skills[0].path, skillPath);
    assert.ok(skills[0].description.trim());
    assert.notEqual(skills[0].disableModelInvocation, true);
  });

  it('运行时读取的技能全文与权威源码一致', () => {
    assert.equal(readFileSync(skillPath, 'utf8'), readFileSync(sourcePath, 'utf8'));
  });
});

describe('shouldRemindDesignTrace（目标回溯触发）', () => {
  it('Todo 定义字段发生成功更新时触发，纯状态流转不触发', () => {
    for (const field of ['subject', 'description', 'deliver', 'kind']) {
      assert.equal(shouldRemindDesignTrace({ toolName: 'task_update', args: { taskId: '1', [field]: 'changed' }, success: true }), true, field);
    }
    assert.equal(shouldRemindDesignTrace({ toolName: 'task_update', args: { taskId: '1', status: 'in_progress' }, success: true }), false);
    assert.equal(shouldRemindDesignTrace({ toolName: 'task_update', args: { taskId: '1', status: 'completed' }, success: true }), false);
    assert.equal(shouldRemindDesignTrace({ toolName: 'task_update', args: { taskId: '1', status: 'deleted' }, success: true }), true);
    assert.equal(shouldRemindDesignTrace({ toolName: 'task_clear', args: {}, success: true }), true);
  });

  it('成功写入或编辑源码时触发，文档、测试、配置及失败操作不触发', () => {
    for (const toolName of ['write', 'edit']) {
      for (const filePath of ['src/feature.ts', 'server/routes/session.js', 'scripts/build.mjs', 'src/view.tsx']) {
        assert.equal(shouldRemindDesignTrace({ toolName, args: { filePath }, success: true }), true, `${toolName} ${filePath}`);
      }
      for (const filePath of [
        'docs/plan.md',
        'test/feature.test.ts',
        'src/feature.test.ts',
        'src/__tests__/feature.ts',
        String.raw`src\test\feature.ts`,
        String.raw`D:\repo\tests\feature.ts`,
        'config/app.json',
      ]) {
        assert.equal(shouldRemindDesignTrace({ toolName, args: { filePath }, success: true }), false, `${toolName} ${filePath}`);
      }
      assert.equal(shouldRemindDesignTrace({ toolName, args: { filePath: 'src/feature.ts' }, success: false }), false);
    }
  });

  it('ToolFinished 实际注入 Todo 定义和源码改动提醒，状态更新不注入', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-design-trace-'));
    const content = '沿设计树回溯主线';
    writeFileSync(join(dir, 'design-trace-reflection.md'), content);
    const feature = new CraftAwarenessFeature({ knowledgeDir: dir });
    const injected: string[] = [];
    const fire = (toolName: string, args: Record<string, unknown>) => feature.injectCraftReminder({
      toolName,
      call: { arguments: args },
      success: true,
      context: { getRecent() { return [{ turn: 4 }]; }, addSystemMessage(text: string) { injected.push(text); } },
    } as never);
    try {
      await fire('task_update', { taskId: '1', status: 'in_progress' });
      assert.deepEqual(injected, [], '纯状态流转不触发');
      await fire('task_update', { taskId: '1', description: '缩小本轮范围' });
      assert.deepEqual(injected, [`[工程素养] ${content}`]);
      await fire('edit', { filePath: 'src/feature.ts' });
      assert.equal(injected.length, 1, '同一提醒每会话一次');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('knowledge 文案要求说明改动缘由、主线关系、影响并按设计树回溯', () => {
    const content = loadKnowledgeDir(REAL_KNOWLEDGE_DIR).get('design-trace-reflection');
    assert.ok(content);
    assert.ok(content.includes('为什么要改这里'));
    assert.ok(content.includes('支撑主线目标'));
    assert.ok(content.includes('既有行为'));
    assert.ok(content.includes('补方案'));
    assert.ok(content.includes('用户已定的目标、边界或重要取舍'));
  });
});

describe('Todo 完成后的语境化承接提醒', () => {
  type Task = {
    id: string;
    subject: string;
    description?: string;
    deliver?: string;
    kind?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  };

  function makeHarness(tasks: Task[]) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const injected: string[] = [];
    const feature = new CraftAwarenessFeature({ knowledgeDir: REAL_KNOWLEDGE_DIR });
    const getFeature = (name: string) => name === 'todo'
      ? { getTask: (taskId: string) => byId.get(taskId) }
      : undefined;
    const context = {
      addSystemMessage(text: string) { injected.push(text); },
      getRecent() { return [{ turn: 12 }]; },
    };
    return { feature, byId, injected, getFeature, context };
  }

  async function runCompletion(
    harness: ReturnType<typeof makeHarness>,
    taskId: string,
    options: { step?: number; success?: boolean } = {},
  ) {
    const step = options.step ?? 0;
    const task = harness.byId.get(taskId)!;
    const call = { id: `call-${taskId}-${step}`, name: 'task_update', arguments: { taskId, status: 'completed' } };
    await harness.feature.recordTodoCompletionCandidate({
      call,
      tool: {},
      step,
      input: '',
      context: harness.context,
      getFeature: harness.getFeature,
    } as never);
    if (options.success !== false) task.status = 'completed';
    await harness.feature.confirmTodoCompletion({
      toolName: 'task_update',
      call,
      success: options.success !== false,
      data: null,
      duration: 0,
      tool: {},
      step,
      input: '',
      context: harness.context,
      getFeature: harness.getFeature,
    } as never);
  }

  function startNextStep(harness: ReturnType<typeof makeHarness>, step = 1) {
    return harness.feature.injectTodoCompletionReflection({
      step,
      callIndex: 1,
      input: '',
      agent: undefined,
      context: harness.context,
    } as never);
  }

  it('只在未完成任务成功进入 completed 后，在后续步骤开始时注入一条承接提醒', async () => {
    const h = makeHarness([{
      id: '1', subject: '实现排序保持', description: '让真实页面刷新后顺序仍然稳定',
      deliver: '排序回归测试', kind: 'implement', status: 'in_progress',
    }]);
    await runCompletion(h, '1');
    assert.deepEqual(h.injected, [], '完成确认后不应立即插入长段提醒');
    await startNextStep(h);
    assert.equal(h.injected.length, 1);
    assert.ok(h.injected[0].includes('实现排序保持'));
    assert.ok(h.injected[0].includes('让真实页面刷新后顺序仍然稳定'));
    assert.ok(h.injected[0].includes('排序回归测试'));
    assert.ok(h.injected[0].includes('接下来把这部分实现接回原来的使用路径'));
    assert.ok(h.injected[0].includes('当前产物可以作为后续工作的基础'));
    assert.ok(h.injected[0].includes('用户最初要解决的问题'));
  });

  it('失败更新、重复完成和非完成状态更新都不注入', async () => {
    const h = makeHarness([
      { id: '1', subject: '调查现象', kind: 'investigate', status: 'in_progress' },
      { id: '2', subject: '已完成任务', kind: 'verify', status: 'completed' },
    ]);
    await runCompletion(h, '1', { success: false });
    await runCompletion(h, '2');
    const otherCall = { id: 'call-other', name: 'task_update', arguments: { taskId: '1', status: 'in_progress' } };
    await h.feature.recordTodoCompletionCandidate({
      call: otherCall, tool: {}, step: 0, input: '', context: h.context, getFeature: h.getFeature,
    } as never);
    await h.feature.confirmTodoCompletion({
      toolName: 'task_update', call: otherCall, success: true, data: null, duration: 0,
      tool: {}, step: 0, input: '', context: h.context, getFeature: h.getFeature,
    } as never);
    await startNextStep(h);
    assert.deepEqual(h.injected, []);
  });

  it('真实 Todo 工具经 HooksRegistry 完成状态流转后，在下一步追加承接提醒', async () => {
    const todo = new TodoFeature();
    const craft = new CraftAwarenessFeature({ knowledgeDir: REAL_KNOWLEDGE_DIR });
    const hooks = new HooksRegistry();
    hooks.collectFromFeature(todo);
    hooks.collectFromFeature(craft);
    const context = new Context();
    const task = todo.createTask('保持真实页面排序', '刷新页面后顺序仍应稳定', {
      deliver: '页面刷新回归测试',
      kind: 'implement',
    });
    todo.updateTask(task.id, { status: 'in_progress' });
    const agent = {
      getFeature(name: string) {
        return name === 'todo' ? todo : name === 'craft-awareness' ? craft : undefined;
      },
    };
    const updateTool = todo.getTools().find(tool => tool.name === 'task_update')!;
    const call = { id: 'real-todo-completion', name: 'task_update', arguments: { taskId: task.id, status: 'completed' } };

    await hooks.executeVoid(CoreLifecycle.CallStart, {
      input: '继续', context, isFirstCall: true, agent,
    } as never);
    await hooks.executeVoid(CoreLifecycle.StepStart, {
      step: 0, callIndex: 0, context, input: '继续', agent,
    } as never);
    await hooks.executeVoid(CoreLifecycle.ToolUse, {
      call, tool: updateTool, step: 0, input: '继续', context, getFeature: agent.getFeature,
    } as never);
    const data = await updateTool.execute(call.arguments);
    await hooks.executeVoid(CoreLifecycle.ToolFinished, {
      toolName: 'task_update', call, tool: updateTool, success: true, data, duration: 0,
      step: 0, input: '继续', context, getFeature: agent.getFeature,
    } as never);
    await hooks.executeVoid(CoreLifecycle.StepStart, {
      step: 1, callIndex: 0, context, input: '继续', agent,
    } as never);

    const reminders = context.getAllEnriched().filter(message => message.source === 'craft-awareness');
    assert.equal(todo.getTask(task.id)?.status, 'completed');
    assert.equal(reminders.length, 1);
    assert.ok(reminders[0].content.includes('保持真实页面排序'));
    assert.ok(reminders[0].content.includes('接下来把这部分实现接回原来的使用路径'));
  });

  it('同一 Step 完成多个任务时合并为一条，并按各自 kind 承接', async () => {
    const h = makeHarness([
      { id: '1', subject: '查明数据来源', kind: 'investigate', status: 'pending' },
      { id: '2', subject: '确定接口方案', kind: 'design', status: 'in_progress' },
    ]);
    await runCompletion(h, '1');
    await runCompletion(h, '2');
    await startNextStep(h);
    assert.equal(h.injected.length, 1);
    assert.ok(h.injected[0].includes('查明数据来源'));
    assert.ok(h.injected[0].includes('确定接口方案'));
    assert.ok(h.injected[0].includes('把这些材料放回用户要解决的问题中'));
    assert.ok(h.injected[0].includes('把这套安排放回用户想得到的结果中'));
  });

  it('不同 kind 会承接各自的后续关系，未声明 kind 使用通用承接', async () => {
    const h = makeHarness([
      { id: '1', subject: '修复已定位路径', kind: 'fix', status: 'pending' },
      { id: '2', subject: '核对当前主张', kind: 'verify', status: 'pending' },
      { id: '3', subject: '整理阶段产出', status: 'pending' },
    ]);
    await runCompletion(h, '1', { step: 0 });
    await runCompletion(h, '2', { step: 0 });
    await runCompletion(h, '3', { step: 0 });
    await startNextStep(h, 1);
    assert.equal(h.injected.length, 1);
    assert.ok(h.injected[0].includes('把这次处理放回原来的故障路径'));
    assert.ok(h.injected[0].includes('把这次核对所得的认识放回原始要求'));
    assert.ok(h.injected[0].includes('把这个阶段性结果放回用户原本要解决的问题中'));
  });

  it('完成提醒不按条目永久冷却，后续 Step 的另一个完成仍可注入', async () => {
    const h = makeHarness([
      { id: '1', subject: '完成第一步', kind: 'fix', status: 'pending' },
      { id: '2', subject: '完成第二步', kind: 'verify', status: 'pending' },
    ]);
    await runCompletion(h, '1', { step: 0 });
    await startNextStep(h, 1);
    await runCompletion(h, '2', { step: 1 });
    await startNextStep(h, 2);
    assert.equal(h.injected.length, 2);
    assert.ok(h.injected[1].includes('完成第二步'));
  });
});

describe('接续后的目标与验证证据校准', () => {
  it('handoff seed 回放后、首个模型步骤前注入一次，且排在接续内容之后', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-handoff-calibration-'));
    const reminder = '按用户确认的目标继续；尊重已发生的验证及其实际覆盖范围。';
    writeFileSync(join(dir, 'handoff-context-calibration.md'), reminder);
    const craft = new CraftAwarenessFeature({ knowledgeDir: dir });
    const seed = new HandoffSeedFeature({ handoff: {
      packageId: 'handoff-test',
      mode: 'summary',
      seedMessages: [{ role: 'user', content: '用户原先确认的目标', turn: 1 }],
    } });
    const context = new Context();
    const agent = {
      _callIndex: 2,
      getFeature: (name: string) => name === 'handoff-seed' ? seed : name === 'craft-awareness' ? craft : undefined,
    };
    const hooks = new HooksRegistry();
    hooks.collectFromFeature(seed);
    hooks.collectFromFeature(craft);
    try {
      await hooks.executeVoid(CoreLifecycle.CallStart, { input: '继续', context, isFirstCall: true, agent });
      await hooks.executeVoid(CoreLifecycle.StepStart, { step: 0, callIndex: 2, context, input: '继续', agent });
      const messages = context.getAllEnriched();
      assert.equal(messages.filter((message) => message.content === `[工程素养] ${reminder}`).length, 1);
      assert.ok(messages.findIndex((message) => message.content === '用户原先确认的目标') < messages.findIndex((message) => message.content === `[工程素养] ${reminder}`));
      assert.equal(messages.find((message) => message.content === `[工程素养] ${reminder}`)?.source, 'craft-awareness');
      await hooks.executeVoid(CoreLifecycle.StepStart, { step: 1, callIndex: 2, context, input: '继续', agent });
      assert.equal(context.getAllEnriched().filter((message) => message.content === `[工程素养] ${reminder}`).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('没有接续 seed、seed 尚未注入或空 seed 时不触发', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-handoff-calibration-'));
    writeFileSync(join(dir, 'handoff-context-calibration.md'), '校准提醒');
    const feature = new CraftAwarenessFeature({ knowledgeDir: dir });
    const injected: string[] = [];
    const makeCtx = (handoffState?: unknown) => ({
      step: 0,
      callIndex: 0,
      input: '继续',
      agent: { getFeature: (name: string) => name === 'handoff-seed' && handoffState !== undefined ? { captureState: () => handoffState } : undefined },
      context: { addSystemMessage(text: string) { injected.push(text); } },
    });
    try {
      await feature.injectHandoffCalibration(makeCtx() as never);
      await feature.injectHandoffCalibration(makeCtx({ injected: false }) as never);
      await feature.injectHandoffCalibration(makeCtx({ injected: true, seedCount: 0 }) as never);
      assert.deepEqual(injected, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('知识文案保留用户目标、摘要断章取义与既有验证的平衡', () => {
    const content = loadKnowledgeDir(REAL_KNOWLEDGE_DIR).get('handoff-context-calibration');
    assert.ok(content);
    assert.ok(content.includes('用户确认的目标和取舍'));
    assert.ok(content.includes('不要断章取义'));
    assert.ok(content.includes('尊重它们确实发生过'));
    assert.ok(content.includes('不因接续本身重做'));
  });
});

describe('shouldRemindDocCraft（触发判定纯函数）', () => {
  it('write 达到行数阈值的 md/txt/markdown 文档 → 触发', () => {
    for (const filePath of ['a.md', 'README.markdown', 'notes.txt', 'docs/GUIDE.MD']) {
      assert.equal(
        shouldRemindDocCraft({ toolName: 'write', args: { filePath, content: lines(DOC_CRAFT_MIN_WRITE_LINES) }, success: true }),
        true,
        `${filePath} 应触发`,
      );
    }
  });

  it('write 行数不足（阈值边界外）→ 不触发', () => {
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: { filePath: 'a.md', content: lines(DOC_CRAFT_MIN_WRITE_LINES - 1) }, success: true }),
      false,
    );
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: { filePath: 'a.md', content: '随手记一句' }, success: true }),
      false,
    );
  });

  it('write 非文档扩展名 / content 非字符串 / 路径缺失 → 不触发', () => {
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: { filePath: 'a.js', content: lines(100) }, success: true }),
      false,
    );
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: { filePath: 'a.md', content: 123 }, success: true }),
      false,
    );
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: { content: lines(100) }, success: true }),
      false,
    );
  });

  it('write 路径参数别名 filepath/path 同样识别', () => {
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: { filepath: 'a.md', content: lines(40) }, success: true }),
      true,
    );
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: { path: 'a.md', content: lines(40) }, success: true }),
      true,
    );
  });

  it('edit 文档文件 → 触发（不看内容规模）', () => {
    assert.equal(
      shouldRemindDocCraft({ toolName: 'edit', args: { filePath: 'a.md', oldString: 'a', newString: 'b' }, success: true }),
      true,
    );
    assert.equal(
      shouldRemindDocCraft({ toolName: 'edit', args: { filePath: 'notes.txt', oldString: 'a', newString: 'b' }, success: true }),
      true,
    );
  });

  it('edit 非文档扩展名 → 不触发', () => {
    assert.equal(
      shouldRemindDocCraft({ toolName: 'edit', args: { filePath: 'a.ts', oldString: 'a', newString: 'b' }, success: true }),
      false,
    );
  });

  it('失败的调用不触发（文件未落盘，提醒不成立）', () => {
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: { filePath: 'a.md', content: lines(40) }, success: false }),
      false,
    );
    assert.equal(
      shouldRemindDocCraft({ toolName: 'edit', args: { filePath: 'a.md', oldString: 'a', newString: 'b' }, success: false }),
      false,
    );
  });

  it('其他工具与非对象参数 → 不触发', () => {
    assert.equal(
      shouldRemindDocCraft({ toolName: 'read', args: { filePath: 'a.md' }, success: true }),
      false,
    );
    assert.equal(
      shouldRemindDocCraft({ toolName: 'write', args: null, success: true }),
      false,
    );
  });
});

describe('测试素养（分层注入契约）', () => {
  const layerIds = ['test-behavior-contract', 'test-discriminating-power', 'test-verification-delivery'];
  const knowledgeDir = mkdtempSync(join(tmpdir(), 'craft-test-layers-'));
  for (const id of layerIds) writeFileSync(join(knowledgeDir, `${id}.md`), id);
  after(() => rmSync(knowledgeDir, { recursive: true, force: true }));

  function session(dir = knowledgeDir) {
    const feature = new CraftAwarenessFeature({ knowledgeDir: dir });
    const injected: Array<{ text: string; turn: number; source?: string; tag?: string }> = [];
    return {
      feature,
      injected,
      async fire(filePath = 'cart.test.ts', toolName = 'edit', success = true, pathKey = 'filePath') {
        await feature.injectCraftReminder({
          toolName,
          call: { arguments: { [pathKey]: filePath, content: 'test', oldString: 'a', newString: 'b' } },
          success,
          context: {
            getRecent() { return [{ role: 'user', sequence: 10, turn: 7 }, { role: 'tool', turn: 7 }]; },
            addSystemMessage(text: string, turn: number, source?: string, tag?: string) {
              injected.push({ text, turn, source, tag });
            },
          },
        } as never);
      },
    };
  }

  it('给定的文件名模式均触发，包括跨平台路径和多重扩展名', async () => {
    for (const name of [
      'test_cart.py', 'test_cart', 'cart_test.go', 'cart.test.ts', 'cart.test.helper.ts',
      'cart.spec.tsx', 'CartTest.java', 'CartTests.cs', 'CartTestCase.php', 'CartSpec.scala',
      'D:\\repo\\CartTest.java', '/repo/tests/cart.spec.js',
    ]) {
      const s = session();
      await s.fire(name, 'write');
      assert.deepEqual(s.injected.map((item) => item.text), ['[工程素养] test-behavior-contract'], name);
      assert.equal(s.injected[0].turn, 7);
      assert.equal(s.injected[0].source, 'craft-awareness');
      assert.equal(s.injected[0].tag, 'reminder');
    }
  });

  it('只匹配文件名，不匹配测试目录、普通名称或近似后缀', async () => {
    for (const name of ['tests/cart.ts', 'test_cart/cart.py', 'a.test.ts/main.js', 'contest.js',
      'special.ts', 'CartTestsHelper.cs', 'cart.test', 'cart_test', 'README.md', '']) {
      const s = session();
      await s.fire(name);
      assert.equal(s.injected.length, 0, name);
    }
  });

  it('同一用户输入内的 write、edit、edit 逐层注入，后续不重复', async () => {
    const s = session();
    await s.fire('cart.test.ts', 'write');
    assert.deepEqual(s.injected.map((item) => item.text), ['[工程素养] test-behavior-contract']);
    await s.fire();
    assert.equal(s.injected.at(-1)?.text, '[工程素养] test-discriminating-power');
    await s.fire();
    assert.deepEqual(s.injected.map((item) => item.text), layerIds.map((id) => `[工程素养] ${id}`));
    await s.fire();
    await s.fire('other.spec.ts');
    assert.equal(s.injected.length, 3, '每层每会话一次，而不是每文件一次');
  });

  it('首次 edit 也只注入第一层，重复 write 不解锁后两层', async () => {
    const s = session();
    await s.fire('cart.test.ts');
    await s.fire('cart.test.ts', 'write');
    await s.fire('cart.test.ts', 'write');
    assert.equal(s.injected.length, 1);
    await s.fire();
    assert.equal(s.injected.at(-1)?.text, '[工程素养] test-discriminating-power');
    await s.fire();
    assert.equal(s.injected.at(-1)?.text, '[工程素养] test-verification-delivery');
  });

  it('不同文件进度分开，不因连续新建测试文件而提前注入深层知识', async () => {
    const s = session();
    await s.fire('a.test.ts', 'write');
    await s.fire('b.spec.ts', 'write');
    await s.fire('c_test.go');
    assert.equal(s.injected.length, 1);
    await s.fire('b.spec.ts');
    assert.equal(s.injected.at(-1)?.text, '[工程素养] test-discriminating-power');
    await s.fire('a.test.ts');
    assert.equal(s.injected.length, 2, '第三层需要当前文件至少第三次修改');
    await s.fire('b.spec.ts');
    assert.equal(s.injected.at(-1)?.text, '[工程素养] test-verification-delivery');
  });

  it('失败、无关工具、缺失路径不注入也不累计，路径参数别名可用', async () => {
    const s = session();
    await s.fire('cart.test.ts', 'write', false);
    await s.fire('cart.test.ts', 'read');
    await s.fire('');
    assert.equal(s.injected.length, 0);
    await s.fire('cart.test.ts', 'edit', true, 'filepath');
    assert.equal(s.injected.length, 1);
    await s.fire('cart.test.ts', 'edit', false);
    await s.fire('cart.test.ts', 'read');
    await s.fire('cart.test.ts', 'edit', true, 'path');
    assert.equal(s.injected.length, 2);
    assert.equal(s.injected.at(-1)?.text, '[工程素养] test-discriminating-power');
  });

  it('分隔符和 Windows 大小写漂移仍延续同文件进度', async () => {
    const s = session();
    await s.fire('D:/repo/cart.test.ts', 'write');
    await s.fire('d:\\repo\\cart.test.ts');
    await s.fire('D:/REPO/cart.test.ts');
    assert.deepEqual(s.injected.map((item) => item.text), layerIds.map((id) => `[工程素养] ${id}`));
  });

  it('快照经 JSON 往返恢复后保留文件进度及各层冷却，快照不被后续编辑改变', async () => {
    const first = session();
    await first.fire('cart.test.ts', 'write');
    const snapshot = first.feature.captureState();
    await first.fire();
    const second = session();
    second.feature.restoreState(JSON.parse(JSON.stringify(snapshot)));
    await second.fire();
    assert.deepEqual(second.injected.map((item) => item.text), ['[工程素养] test-discriminating-power']);
    const third = session();
    third.feature.restoreState(JSON.parse(JSON.stringify(second.feature.captureState())));
    await third.fire();
    assert.deepEqual(third.injected.map((item) => item.text), ['[工程素养] test-verification-delivery']);
    await third.fire();
    assert.equal(third.injected.length, 1);
  });

  it('没有测试进度的现有快照从首次操作开始，非法进度不提前解锁', async () => {
    for (const testFileChanges of [undefined, null, 'bad', { 'cart.test.ts': -1 },
      { 'cart.test.ts': '3' }, { 'cart.test.ts': 1.5 }, { 'cart.test.ts': 99 }]) {
      const s = session();
      s.feature.restoreState({ injected: { 'test-behavior-contract': true }, testFileChanges } as never);
      await s.fire();
      assert.equal(s.injected.length, 0);
      await s.fire();
      assert.equal(s.injected.at(-1)?.text, '[工程素养] test-discriminating-power');
    }
  });

  it('前层知识缺失时不越级注入，缺失条目不消耗冷却', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-test-missing-'));
    try {
      writeFileSync(join(dir, `${layerIds[1]}.md`), layerIds[1]);
      writeFileSync(join(dir, `${layerIds[2]}.md`), layerIds[2]);
      const s = session(dir);
      await s.fire();
      await s.fire();
      await s.fire();
      assert.equal(s.injected.length, 0);
      assert.deepEqual((s.feature.captureState() as { injected: Record<string, true> }).injected, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('真实 Context 中每次工具结果后仅追加一层提醒，不改变工具结果', async () => {
    const feature = new CraftAwarenessFeature({ knowledgeDir });
    const context = new Context();
    context.addUserMessage('补充购物车回归测试', 4);
    for (const [index, name] of ['write', 'edit', 'edit'].entries()) {
      const call = { id: `test-${index}`, name, arguments: { filePath: 'cart.test.ts', content: 'test' } };
      context.addToolMessage(call, { success: true, result: 'saved' }, 4);
      await feature.injectCraftReminder({ toolName: name, call, success: true, context } as never);
      const [tool, reminder] = context.getRecent(2);
      assert.equal(tool.role, 'tool');
      assert.equal(JSON.parse(tool.content).result, 'saved');
      assert.equal(reminder.role, 'system');
      assert.equal(reminder.content, `[工程素养] ${layerIds[index]}`);
      assert.equal(reminder.turn, 4);
      assert.equal(reminder.source, 'craft-awareness');
      assert.equal(reminder.tag, 'reminder');
    }
    assert.deepEqual(context.getRecent(6).map((message) => message.role),
      ['tool', 'system', 'tool', 'system', 'tool', 'system']);
  });

  it('上下文注入失败不阻断工具回调、不消耗冷却，重试仍从第一层开始', async () => {
    const feature = new CraftAwarenessFeature({ knowledgeDir });
    const call = { arguments: { filePath: 'cart.test.ts' } };
    await assert.doesNotReject(feature.injectCraftReminder({
      toolName: 'edit', call, success: true,
      context: { getRecent() { return []; }, addSystemMessage() { throw new Error('injection unavailable'); } },
    } as never));
    const next = session();
    next.feature.restoreState(JSON.parse(JSON.stringify(feature.captureState())));
    await next.fire();
    assert.deepEqual(next.injected.map((item) => item.text), ['[工程素养] test-behavior-contract']);
    await next.fire();
    assert.equal(next.injected.at(-1)?.text, '[工程素养] test-discriminating-power');
  });

  it('文档条目和测试条目冷却独立，一次事件最多一条提醒', async () => {
    const s = session(REAL_KNOWLEDGE_DIR);
    await s.fire('guide.md');
    assert.equal(s.injected.length, 1);
    await s.fire();
    assert.equal(s.injected.length, 2);
    assert.equal(s.injected.at(-1)?.text, `[工程素养] ${loadKnowledgeDir(REAL_KNOWLEDGE_DIR).get(layerIds[0])}`);
    await s.fire('test_notes.md');
    assert.equal(s.injected.length, 2, '另一文件首次修改不提前解锁，也不重复文档条目');
  });

  it('真实构建知识库按层次加载，注入文案与文件一致且互不重复', async () => {
    const s = session(REAL_KNOWLEDGE_DIR);
    const knowledge = loadKnowledgeDir(REAL_KNOWLEDGE_DIR);
    for (const id of layerIds) {
      assert.ok(knowledge.get(id), `${id} 已随构建复制`);
      await s.fire();
      assert.equal(s.injected.at(-1)?.text, `[工程素养] ${knowledge.get(id)}`);
    }
    assert.equal(new Set(s.injected.map((item) => item.text)).size, 3);
  });
});

describe('loadKnowledgeDir（知识库目录加载）', () => {
  it('读取真实 knowledge 目录：doc-reader-awareness.md 内容完整载入', () => {
    const knowledge = loadKnowledgeDir(REAL_KNOWLEDGE_DIR);
    const content = knowledge.get('doc-reader-awareness');
    assert.ok(content, '内置条目 md 应存在');
    assert.ok(content.includes('准备交付、发布或独立留存'), '范围锚定为交付文本');
    assert.ok(content.includes('回复用户、编辑代码'), '排除对话与代码');
    assert.ok(content.includes('完整、清楚、像一开始就这么写成'), '成品视角立论在场');
    assert.ok(content.includes('文档本身就是记录过程'), '保留过程记录作为文档的情形');
    assert.ok(content.includes('先判断新增要求与全文的关系'), '后续编辑先审视全文关系');
    assert.ok(content.includes('不要为了“整体重写”而强行重组'), '不强制重写');
    assert.ok(content.includes('原结构仍然清楚时，局部修改即可'), '允许必要的局部修改');
    assert.ok(content.includes('保留原文中准确、清楚且仍适用的措辞'), '整体调整时保护有效表达');
    assert.ok(content.includes('以免反复编辑造成意思漂移'), '避免反复编辑导致语义漂移');
    assert.ok(content.includes('改动对读者的影响'), '保留读者需要的事实');
    assert.ok(content.includes('句子直接承载信息'), '补充自然表达建议');
    assert.ok(content.includes('不是……而是……'), '避免无真实对比的模板句式，同时允许有用对比');
    assert.ok(content.includes('论证姿态上的自我说明'), '深层过程痕迹：自解释姿态');
    assert.ok(content.includes('删掉后，论证链受损吗'), '自解释判据可操作：删掉后论证链是否受损');
    assert.ok(content.includes('合上这次对话的记忆'), '收尾工序：陌生人通读而非重读找毛病');
    assert.ok(content.includes('层与层之间的行文腔调是否统一'), '多轮追加的全文腔调统一警示');
    assert.ok(content.includes('反馈针对的是局部事实还是整体姿态'), '反馈定位范围不等于影响范围');
    assert.ok(content.includes('归一成最终需求'), '多轮补丁后的需求归一化重写选项');
    assert.ok(!content.startsWith('[工程素养]'), 'md 只存正文，前缀由代码加');
  });

  it('目录不存在 → 空知识库不抛错', () => {
    assert.equal(loadKnowledgeDir(join(tmpdir(), 'craft-awareness-nonexistent')).size, 0);
  });

  it('读取真实 knowledge 目录：doc-delivery-mode.md 内容完整载入', () => {
    const knowledge = loadKnowledgeDir(REAL_KNOWLEDGE_DIR);
    const content = knowledge.get('doc-delivery-mode');
    assert.ok(content, '条目 md 应存在');
    assert.ok(content.includes('哪种工作方式'), '阶段判断开场');
    assert.ok(content.includes('逐轮协作'), '两种工作方式对照在场');
    assert.ok(content.includes('交付定稿'), '交付态命名在场');
    assert.ok(content.includes('旧稿降为素材'), '归一化重写操作');
    assert.ok(content.includes('不是所有多轮修改都需要重写'), '防过度工程安全阀');
    assert.ok(!content.startsWith('[工程素养]'), 'md 只存正文，前缀由代码加');
  });

  it('忽略非 md 文件，正文去尾部空白', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-knowledge-'));
    try {
      writeFileSync(join(dir, 'doc-reader-awareness.md'), '自定义提醒正文\n\n');
      writeFileSync(join(dir, 'README.txt'), 'not knowledge');
      const knowledge = loadKnowledgeDir(dir);
      assert.equal(knowledge.size, 1);
      assert.equal(knowledge.get('doc-reader-awareness'), '自定义提醒正文');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CraftAwarenessFeature（注入与冷却契约）', () => {
  interface InjectedCall { text: string; turn: number; source: string; tag: string }

  /** 临时知识库目录（自定义 md），用后清理。 */
  const tempDirs: string[] = [];
  function makeKnowledgeDir(files: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'craft-knowledge-'));
    tempDirs.push(dir);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    return dir;
  }
  after(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  function makeHarness(overrides: {
    toolName?: string;
    args?: Record<string, unknown>;
    success?: boolean;
    recentTurn?: number | null;
    knowledgeDir?: string;
  } = {}) {
    const feature = new CraftAwarenessFeature({ knowledgeDir: overrides.knowledgeDir ?? REAL_KNOWLEDGE_DIR });
    const injected: InjectedCall[] = [];
    const recent = overrides.recentTurn === null ? [] : [{ turn: overrides.recentTurn ?? 3 }];
    const ctx = {
      toolName: overrides.toolName ?? 'write',
      call: {
        id: 'c1',
        name: overrides.toolName ?? 'write',
        arguments: overrides.args ?? { filePath: 'guide.md', content: lines(DOC_CRAFT_MIN_WRITE_LINES + 5) },
      },
      success: overrides.success ?? true,
      step: 2,
      context: {
        addSystemMessage(text: string, turn: number, source?: string, tag?: string) {
          injected.push({ text, turn, source: source || '', tag: tag || '' });
        },
        getRecent(_n: number) { return recent; },
      },
    };
    // fire 运行时读 h.feature：允许用例替换实例（模拟会话恢复/跨实例冷却验证）
    const h = {
      feature,
      injected,
      async fire() { await h.feature.injectCraftReminder(ctx as never); },
    };
    return h;
  }

  it('首次写出成规模文档 → 注入一次提醒，source/tag/turn 契约正确，前缀由代码添加', async () => {
    const h = makeHarness();
    await h.fire();
    assert.equal(h.injected.length, 1);
    assert.equal(h.injected[0].source, 'craft-awareness');
    assert.equal(h.injected[0].tag, 'reminder');
    assert.equal(h.injected[0].turn, 3, 'turn 取自最近一条（刚写入的工具结果）');
    assert.ok(h.injected[0].text.startsWith('[工程素养] '), '统一前缀由代码添加');
    assert.ok(h.injected[0].text.includes('准备交付、发布或独立留存'), '正文来自 knowledge md');
  });

  it('注入内容跟随 knowledge md：换一份 md 即换一套文案', async () => {
    const dir = makeKnowledgeDir({ 'doc-reader-awareness.md': '全新的自定义提醒内容。' });
    const h = makeHarness({ knowledgeDir: dir });
    await h.fire();
    assert.equal(h.injected.length, 1);
    assert.equal(h.injected[0].text, '[工程素养] 全新的自定义提醒内容。');
  });

  it('条目命中但 knowledge 缺失对应 md → 不注入', async () => {
    const h = makeHarness({ knowledgeDir: makeKnowledgeDir() });
    await h.fire();
    assert.equal(h.injected.length, 0);
  });

  it('每会话一次：注入后再次写出成规模文档不再注入（write 与 edit 共用冷却）', async () => {
    const h = makeHarness();
    await h.fire();
    await h.fire();
    assert.equal(h.injected.length, 1, '同场景重复触发不注入');

    // 同实例换 edit 场景：同会话另一类文档编辑也不注入
    const editCtx = makeHarness({
      toolName: 'edit',
      args: { filePath: 'guide.md', oldString: 'a', newString: 'b' },
    });
    editCtx.feature = h.feature;
    await editCtx.fire();
    assert.equal(editCtx.injected.length, 0, '同会话 edit 在 write 已注入后不再注入');
  });

  it('未达条件的调用不消耗冷却：短文档 write 后，成规模 write 仍能触发', async () => {
    const feature = new CraftAwarenessFeature({ knowledgeDir: REAL_KNOWLEDGE_DIR });
    const shortCtx = {
      toolName: 'write',
      call: { id: 'c1', name: 'write', arguments: { filePath: 'todo.md', content: '一行随手记' } },
      success: true,
      context: { addSystemMessage() { /* 不应发生 */ }, getRecent() { return [{ turn: 1 }]; } },
    };
    await feature.injectCraftReminder(shortCtx as never);

    const h = makeHarness();
    h.feature = feature; // 复用同一实例（同一会话）
    await h.fire();
    assert.equal(h.injected.length, 1, '短文档未消耗冷却，成规模文档首次仍注入');
  });

  it('captureState 记录已注入条目，restoreState 后延续冷却（会话恢复/重启）', async () => {
    const h = makeHarness();
    await h.fire();
    const snapshot = h.feature.captureState();
    assert.deepEqual(snapshot, { injected: { 'doc-reader-awareness': true } });

    const revived = new CraftAwarenessFeature({ knowledgeDir: REAL_KNOWLEDGE_DIR });
    revived.restoreState(snapshot);
    const again = makeHarness();
    again.feature = revived;
    await again.fire();
    assert.equal(again.injected.length, 0, '会话恢复后不重复提醒');
  });

  it('restoreState 收到缺失/非法快照按未注入处理', async () => {
    for (const bad of [null, undefined, {}, 'junk', { injected: 'x' }, { injected: { other: true } }]) {
      const feature = new CraftAwarenessFeature({ knowledgeDir: REAL_KNOWLEDGE_DIR });
      feature.restoreState(bad as never);
      const h = makeHarness();
      h.feature = feature;
      await h.fire();
      assert.equal(h.injected.length, 1, `${JSON.stringify(bad)} 应视为未注入`);
    }
  });

  it('context.getRecent 为空或抛错时 turn 兜底 0，注入不失败', async () => {
    for (const recent of [null, 'throw']) {
      const feature = new CraftAwarenessFeature({ knowledgeDir: REAL_KNOWLEDGE_DIR });
      const seenTurns: number[] = [];
      const ctx = {
        toolName: 'write',
        call: { id: 'c1', name: 'write', arguments: { filePath: 'a.md', content: lines(40) } },
        success: true,
        context: {
          addSystemMessage(_t: string, turn: number) { seenTurns.push(turn); },
          getRecent() {
            if (recent === 'throw') throw new Error('boom');
            return [];
          },
        },
      };
      await feature.injectCraftReminder(ctx as never);
      assert.deepEqual(seenTurns, [0], `${String(recent)} 应兜底 turn 0`);
    }
  });

  it('失败的 write 不注入（success false）', async () => {
    const h = makeHarness({ success: false });
    await h.fire();
    assert.equal(h.injected.length, 0);
  });
});

describe('doc-delivery-mode（交付模式判断条目触发契约）', () => {
  /** 模拟 context 消息尾部：一条 user 消息（sequence 即边界标识）+ 刚写入的工具结果。 */
  function userBoundary(sequence: number, turn = 1): Array<Record<string, unknown>> {
    return [
      { role: 'user', content: '反馈', sequence, turn },
      { role: 'tool', content: 'result', sequence: sequence + 1, turn },
    ];
  }

  /**
   * 同一 feature 实例上可多次 fire 的会话模型：boundary 可在 fire 之间切换，
   * 模拟"用户有新输入（新 call 或 busy 排队插话）后模型再次编辑文档"。
   */
  function makeSession() {
    const feature = new CraftAwarenessFeature({ knowledgeDir: REAL_KNOWLEDGE_DIR });
    const injected: string[] = [];
    let recent: Array<Record<string, unknown>> = userBoundary(10);
    const fire = (toolName: 'write' | 'edit', filePath = 'guide.md') => {
      const ctx = {
        toolName,
        call: {
          id: 'c1',
          name: toolName,
          arguments: toolName === 'write'
            ? { filePath, content: lines(DOC_CRAFT_MIN_WRITE_LINES + 5) }
            : { filePath, oldString: 'a', newString: 'b' },
        },
        success: true,
        context: {
          addSystemMessage(text: string) { injected.push(text); },
          getRecent() { return recent; },
        },
      };
      return feature.injectCraftReminder(ctx as never);
    };
    return {
      feature,
      injected,
      fire,
      /** 切换边界：数值 = context 中最近一条 user 消息的 sequence；null = 无 user 消息。 */
      setBoundary(sequence: number | null) {
        recent = sequence === null
          ? [{ role: 'tool', content: 'x', sequence: 99, turn: 1 }]
          : userBoundary(sequence);
      },
    };
  }

  const isDelivery = (text: string) => text.includes('哪种工作方式');

  it('同一用户输入边界内的多次 edit（模型自我更正）不触发 delivery 条目', async () => {
    const s = makeSession();
    s.setBoundary(10);
    await s.fire('edit');
    await s.fire('edit');
    await s.fire('edit');
    assert.equal(s.injected.length, 1, '只有 reader 条目注入一次');
    assert.ok(!isDelivery(s.injected[0]));
  });

  it('跨越第二个用户输入边界的 edit 触发 delivery 条目，带统一前缀', async () => {
    const s = makeSession();
    s.setBoundary(10);
    await s.fire('edit'); // reader 注入，guide.md 记账边界数 1
    s.setBoundary(20);
    await s.fire('edit'); // 跨到第二个边界 → delivery 注入
    assert.equal(s.injected.length, 2);
    assert.ok(isDelivery(s.injected[1]));
    assert.ok(s.injected[1].startsWith('[工程素养] '), '前缀由代码添加');
  });

  it('write 跨边界不触发 delivery（触发限定 edit 动作）', async () => {
    const s = makeSession();
    s.setBoundary(10);
    await s.fire('write'); // reader 注入
    s.setBoundary(20);
    await s.fire('write'); // 记账跨边界，但动作是 write
    assert.equal(s.injected.length, 1, '只有 reader，delivery 不触发');
  });

  it('delivery 注入后冷却：跨第三个边界不再注入', async () => {
    const s = makeSession();
    s.setBoundary(10);
    await s.fire('edit');
    s.setBoundary(20);
    await s.fire('edit'); // delivery 注入
    s.setBoundary(30);
    await s.fire('edit');
    assert.equal(s.injected.length, 2, '每会话每条目一次');
  });

  it('路径大小写与分隔符漂移计入同一份文档', async () => {
    const s = makeSession();
    s.setBoundary(10);
    await s.fire('edit', 'docs/guide.md');
    s.setBoundary(20);
    await s.fire('edit', 'docs\\GUIDE.MD');
    assert.equal(s.injected.filter(isDelivery).length, 1, '归一化后同一记账触发');
  });

  it('不同文档的边界记账互不累计', async () => {
    const s = makeSession();
    s.setBoundary(10);
    await s.fire('edit', 'a.md'); // reader 注入，a.md 边界数 1
    s.setBoundary(20);
    await s.fire('edit', 'b.md'); // b.md 首次记账边界数 1，不触发
    assert.equal(s.injected.length, 1, 'b.md 未跨自己的两个边界');
  });

  it('context 无 user 消息（边界 null）不抛错，null 与数值边界互异', async () => {
    const s = makeSession();
    s.setBoundary(null);
    await s.fire('edit'); // 边界 null，reader 注入，记账 1
    s.setBoundary(10);
    await s.fire('edit'); // null → 10 视为跨边界 → delivery 注入
    assert.equal(s.injected.filter(isDelivery).length, 1);
  });

  it('会话恢复（新实例 restoreState）后边界记账从零开始', async () => {
    const s1 = makeSession();
    s1.setBoundary(10);
    await s1.fire('edit');
    s1.setBoundary(20);
    await s1.fire('edit');
    assert.equal(s1.injected.filter(isDelivery).length, 1);

    const s2 = makeSession();
    s2.feature.restoreState({ injected: { 'doc-reader-awareness': true } } as never);
    s2.setBoundary(10);
    await s2.fire('edit'); // 恢复后重新记账，边界数 1
    assert.equal(s2.injected.length, 0, 'reader 已注入、delivery 未达条件');
    s2.setBoundary(20);
    await s2.fire('edit');
    assert.equal(s2.injected.filter(isDelivery).length, 1, '重新跨两边界才触发');
  });
});
