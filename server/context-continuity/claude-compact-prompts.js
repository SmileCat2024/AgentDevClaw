const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn.
- Your entire response must be plain text: <analysis> then <summary>.`;

const NO_TOOLS_TRAILER = `Again: respond with plain text only.
Do not call any tools.
Return <analysis> followed by <summary>.`;

const BASE_SUMMARY_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should preserve the task-continuity essentials needed to continue the work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - only short code excerpts when truly necessary
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.
3. Be concise. Prefer bullet points and short paragraphs. Do not reproduce the full transcript.
4. Keep the final <summary> under 1800 English words (or similarly compact in Chinese).

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include only short excerpts when needed and explain why each file matters.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. User Direction Changes: Summarize the important user messages and feedback that changed direction or constraints. Do not list every message verbatim.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant.
9. Optional Next Step: List the most direct next step that follows from the most recent user request and the current work state. Avoid tangents and do not quote large verbatim passages.

Use exactly this output envelope:

<analysis>
[Your thought process]
</analysis>

<summary>
1. Primary Request and Intent:
   ...

2. Key Technical Concepts:
   ...

3. Files and Code Sections:
   ...

4. Errors and fixes:
   ...

5. Problem Solving:
   ...

6. All user messages:
   ...

7. Pending Tasks:
   ...

8. Current Work:
   ...

9. Optional Next Step:
   ...
</summary>`;

export function buildClaudeCompactPrompt(options = {}) {
  const extraInstructions = typeof options.additionalInstructions === 'string'
    ? options.additionalInstructions.trim()
    : '';

  return [
    NO_TOOLS_PREAMBLE,
    '',
    BASE_SUMMARY_PROMPT,
    extraInstructions ? `## Compact Instructions\n${extraInstructions}` : '',
    '',
    NO_TOOLS_TRAILER,
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
