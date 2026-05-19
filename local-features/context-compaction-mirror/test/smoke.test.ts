import { ContextCompactionMirrorFeature } from '../src/index.js';

async function main(): Promise<void> {
  const disabled = [];
  const feature = new ContextCompactionMirrorFeature();

  await feature.onInitiate({
    logger: {
      info() {},
    },
  } as any);

  await feature.disableAllToolsOnFirstCall({
    isFirstCall: true,
    agent: {
      getTools() {
        return {
          getEntries() {
            return [
              { tool: { name: 'read_file' } },
              { tool: { name: 'shell_exec' } },
            ];
          },
          disable(name: string) {
            disabled.push(name);
            return true;
          },
        };
      },
    },
  } as any);

  if (disabled.length !== 2) {
    throw new Error(`expected 2 disabled tools, got ${disabled.length}`);
  }

  await feature.disableAllToolsOnFirstCall({
    isFirstCall: false,
    agent: {
      getTools() {
        return {
          getEntries() {
            return [{ tool: { name: 'late_tool' } }];
          },
          disable(name: string) {
            disabled.push(name);
            return true;
          },
        };
      },
    },
  } as any);

  if (disabled.length !== 2) {
    throw new Error('mirror feature should only disable tools on the first call');
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
});

