const TOOL_CALL_PREAMBLE = `你有一个可用工具：record_compaction_context。
你必须按以下两步输出：

第一步 — 将九段式摘要写为纯文本（不使用工具）：
<analysis>
[你的思考过程 — 可选]
</analysis>

<summary>
1. 主要请求与意图：
   ...
2. 关键技术概念：
   ...
3. 文件与代码段：
   ...
4. 错误与修复：
   ...
5. 问题解决过程：
   ...
6. 用户方向调整：
   ...
7. 待办事项：
   ...
8. 当前工作：
   ...
9. 可选的下一步：
   ...
</summary>

第二步 — 调用 record_compaction_context，传入 important_files 和 important_skills。
不要把摘要文本放进工具调用参数中——摘要应写在上面的文本里。
不要调用任何其他工具。`;

const TOOL_CALL_TRAILER = `现在调用 record_compaction_context，传入文件路径和技能名称。
只包含恢复工作真正需要的文件和技能。`;

const BASE_SUMMARY_PROMPT = `你的任务是为当前对话创建一份详细摘要，重点关注用户的明确请求和你之前采取的行动。
这份摘要应保留恢复工作所需的任务连续性关键信息。

按时间顺序分析对话：

1. 识别用户的明确请求和意图
2. 识别你的方法和关键决策
3. 记录重要的技术概念、文件名、代码模式
4. 记录遇到的错误及修复方式
5. 特别注意改变了方向的用户反馈

将摘要以文本形式写在 <summary>...</summary> 标签中。
然后调用 record_compaction_context，传入：

- **important_files**：对继续任务至关重要的文件路径。只包含恢复工作真正需要其内容的文件。
- **important_skills**：被实际使用过且继续工作需要用到的技能名称。

摘要控制在 1800 个英文单词以内（中文对应压缩），优先使用要点而非段落。`;

export function scanFilesAndSkills(rawMessages) {
  const files = new Set();
  const skills = new Set();
  const fileRanges = {};
  for (const message of rawMessages) {
    if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue;
    for (const tc of message.toolCalls) {
      const name = typeof tc?.name === 'string' ? tc.name : '';
      const args = tc?.arguments && typeof tc.arguments === 'object' ? tc.arguments : {};
      if ((name === 'read' || name === 'write' || name === 'edit') && typeof args.filePath === 'string') {
        files.add(args.filePath);
      }
      if (name === 'read' && typeof args.filePath === 'string') {
        const offset = typeof args.offset === 'number' ? args.offset : (typeof args.line === 'number' ? args.line : 0);
        const limit = typeof args.limit === 'number' ? args.limit : 0;
        if (offset > 0 || limit > 0) {
          const start = Math.max(1, offset || 1);
          const end = limit > 0 ? start + limit - 1 : start;
          fileRanges[args.filePath] = `${start}-${end}`;
        }
      }
      if (name === 'invoke_skill' && typeof args.skill === 'string') {
        skills.add(args.skill);
      }
    }
  }
  return { files: [...files], skills: [...skills], fileRanges };
}

const EXPLORATION_SUMMARY_PREAMBLE = `你有一个可用工具：record_compaction_context。
你必须按以下两步输出：

第一步 — 将探索摘要写为纯文本（不使用工具）：
<analysis>
[你的思考过程 — 可选]
</analysis>

<summary>
1. 探索目标与范围：
   ...
2. 关键发现与结论：
   ...
3. 重要的代码位置与文件：
   ...
</summary>

第二步 — 调用 record_compaction_context，传入 important_files 和 important_skills。
不要把摘要文本放进工具调用参数中——摘要应写在上面的文本里。
不要调用任何其他工具。`;

const EXPLORATION_SUMMARY_PROMPT = `你的任务是为一次代码探索生成一份精炼的探索摘要，帮助读者快速判断"这条探索记录跟我的当前任务相关吗"。

摘要面向主代理（Main Agent），用于一览列表中的快速扫描和相关度评估，不注入子代理上下文。

按以下三段输出：

1. **探索目标与范围**：本次探索被派去查什么，探索了哪些模块/目录/子系统
2. **关键发现与结论**：发现了什么，核心结论是什么，有什么值得注意的设计模式或架构特征
3. **重要的代码位置与文件**：对后续工作最有参考价值的文件路径和代码位置

将摘要以文本形式写在 <summary>...</summary> 标签中。
然后调用 record_compaction_context，传入：

- **important_files**：本次探索中实际访问过、对理解代码最有价值的文件路径
- **important_skills**：被实际使用过且继续工作需要用到的技能名称

摘要控制在 800 个英文单词以内（中文对应压缩），优先使用要点而非段落。`;

export function buildClaudeCompactPrompt(options = {}) {
  const extraInstructions = typeof options.additionalInstructions === 'string'
    ? options.additionalInstructions.trim()
    : '';
  const isExploration = options.sessionType === 'exploration';

  if (isExploration) {
    return [
      EXPLORATION_SUMMARY_PREAMBLE,
      '',
      EXPLORATION_SUMMARY_PROMPT,
      extraInstructions ? `## 额外压缩指令\n${extraInstructions}` : '',
      '',
      TOOL_CALL_TRAILER,
    ].filter(Boolean).join('\n');
  }

  return [
    TOOL_CALL_PREAMBLE,
    '',
    BASE_SUMMARY_PROMPT,
    extraInstructions ? `## 额外压缩指令\n${extraInstructions}` : '',
    '',
    TOOL_CALL_TRAILER,
  ].filter(Boolean).join('\n');
}

export function stripCompactAnalysis(rawText) {
  const text = typeof rawText === 'string' ? rawText.trim() : '';
  if (!text) return '';

  const withoutAnalysis = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summaryBody = summaryMatch ? summaryMatch[1].trim() : withoutAnalysis;
  return summaryBody.replace(/\n{3,}/g, '\n\n').trim();
}
