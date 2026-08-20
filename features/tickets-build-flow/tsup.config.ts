import { existsSync, readdirSync } from 'fs';
import { defineConfig } from 'tsup';

function getTemplateEntries(): string[] {
  const templateDir = 'src/templates';
  if (!existsSync(templateDir)) {
    return [];
  }

  return readdirSync(templateDir)
    .filter((name) => name.endsWith('.render.ts'))
    .map((name) => `${templateDir}/${name}`);
}

export default defineConfig({
  entry: ['src/index.ts', ...getTemplateEntries()],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
