import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  CraftAwarenessFeature,
  shouldRemindDocCraft,
  loadKnowledgeDir,
  DOC_CRAFT_MIN_WRITE_LINES,
} from '../src/index.js';

/** 构造恰好 N 行的内容（N 个以 \n 分隔的行）。 */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
}

/** 编译产物旁的真实 knowledge 目录（copy 脚本拷入 dist 的那份）。 */
const REAL_KNOWLEDGE_DIR = fileURLToPath(new URL('../src/knowledge', import.meta.url));

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
