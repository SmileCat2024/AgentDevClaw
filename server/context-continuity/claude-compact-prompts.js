const TOOL_CALL_PREAMBLE = `你必须调用 record_compaction_context 工具，将所有结果作为参数传入。

参数说明：
- session_title（必填，不能为空）：对对话主要内容的一句话概括，例如 "调试 Flow 节点工具权限逻辑"
- summary：完整十段式摘要文本
- important_files：恢复工作所需的文件路径列表
- important_skills：实际使用invoke_skill工具激活的技能名称列表

不要调用其他工具。`;

const TOOL_CALL_TRAILER = `现在调用 record_compaction_context，传入 session_title（必填）、summary、文件路径和技能名称。
只包含恢复工作真正需要的文件和技能。`;

const BASE_SUMMARY_PROMPT = `你的任务是为当前对话创建一份详细摘要，重点关注用户的明确请求和你之前采取的行动。
这份摘要应保留恢复工作所需的任务连续性关键信息。

按时间顺序分析对话：

1. 识别用户的明确请求和意图
2. 保留用户较为模糊的术语概念与情况表述，不做过多推测与转述
3. 识别你的方法和关键决策，以及用户的反馈，特别注意自己曾理解有误，或后续改变了方向的用户反馈
4. 记录与用户探讨的重要结论，以及最终放弃、或纠正某些决策的原因
5. 记录当前讨论要点之于整个项目的层次，以及重要的技术概念、文件名、代码模式
6. 记录遇到的错误及修复方式

摘要使用以下十段式结构：

1. 主要请求与意图
2. 用户观点表态与方向调整
3. 关键技术概念
4. 重要结论与决策
5. 参考文件、技能与代码段
6. 错误与修复
7. 问题解决过程
8. 待办事项
9. 当前工作
10. 可选的下一步

摘要控制在 3000 个词以内，优先使用要点而非段落。`;

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

const EXPLORATION_SUMMARY_PREAMBLE = `你必须调用 record_compaction_context 工具，将所有结果作为参数传入。

参数说明：
- session_title（必填，不能为空）：对对话主要内容的一句话概括，例如 "探索 Flow 运行时 Hook 驱动机制"
- summary：完整三段式探索摘要文本
- important_files：探索中发现的重要文件路径列表
- important_skills：探索中使用invoke_skill工具激活的技能名称列表

不要调用其他工具。`;

const EXPLORATION_SUMMARY_PROMPT = `你的任务是为一次代码探索生成一份精炼的探索摘要，帮助读者快速判断"这条探索记录跟我的当前任务相关吗"。

摘要面向主代理（Main Agent），用于一览列表中的快速扫描和相关度评估，不注入子代理上下文。

使用以下三段式结构：

1. **探索目标与范围**：本次探索被派去查什么，探索了哪些模块/目录/子系统
2. **关键发现与结论**：发现了什么，核心结论是什么，有什么值得注意的设计模式或架构特征
3. **重要的代码位置与文件**：对后续工作最有参考价值的文件路径和代码位置

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
