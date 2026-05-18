import { Context } from 'agentdev';
import { ContextHandoffSeedFeature } from '../src/index.js';

async function main(): Promise<void> {
  const feature = new ContextHandoffSeedFeature({
    handoff: {
      packageId: 'pkg-1',
      sourceSessionId: 'session-1',
      mode: 'trim-transcript',
      seedMessages: [
        { role: 'system', content: 'Folded tool activity', turn: 1 },
        { role: 'user', content: 'Please continue the task.', turn: 2 },
        { role: 'assistant', content: 'I will continue from the trimmed transcript.', turn: 2 },
      ],
    },
  });

  const messages: Array<{ role: string; content: string }> = [];
  const context = {
    addSystemMessage(content: string): void {
      messages.push({ role: 'system', content });
    },
    addUserMessage(content: string): void {
      messages.push({ role: 'user', content });
    },
    addAssistantMessage(response: { content: string }): void {
      messages.push({ role: 'assistant', content: response.content });
    },
  } as unknown as Context;

  await feature.injectHandoffSummary({
    input: 'hello',
    isFirstCall: true,
    context,
    agent: { _callIndex: 0 },
  } as any);

  if (messages.length !== 3) {
    throw new Error(`expected three injected seed messages, got ${messages.length}`);
  }

  await feature.injectHandoffSummary({
    input: 'again',
    isFirstCall: false,
    context,
    agent: { _callIndex: 1 },
  } as any);

  if (messages.length !== 3) {
    throw new Error('handoff seed should inject only once');
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});
