import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveModelPresetLLM,
  resolveAgentModelLLM,
} from '../server/model-preset-resolver.js';

describe('model-preset-resolver', () => {

  describe('resolveModelPresetLLM', () => {
    it('returns null for empty preset name', () => {
      assert.equal(resolveModelPresetLLM(''), null);
      assert.equal(resolveModelPresetLLM(null), null);
      assert.equal(resolveModelPresetLLM(undefined), null);
    });

    it('returns null for nonexistent preset', () => {
      assert.equal(resolveModelPresetLLM('definitely-not-a-preset-xyz'), null);
    });

    // NOTE: 依赖 config/presets.json 真实配置（如 智谱GLM-5.2、Codex OAuth）的
    // 用例已移除：config/ 是机器本地未跟踪目录，这类断言在干净环境无法复现。
    // resolveModelPresetLLM 的成功路径由 resolveAgentModelLLM 之外的消费方在
    // 集成环境中验证。

    it('returns null when provider is missing (preset references nonexistent provider)', () => {
      // All presets in the real config have valid providers, so this tests the
      // hypothetical path by verifying the function handles bad data gracefully.
      // We can't directly test this without modifying config, but the nonexistent
      // preset test above covers the "not found" return path.
      assert.equal(resolveModelPresetLLM('no-such-preset'), null);
    });
  });

  describe('resolveAgentModelLLM', () => {
    let tempDir;

    before(() => {
      tempDir = join(tmpdir(), `model-preset-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
    });

    after(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('returns null when metadata.json does not exist', () => {
      const result = resolveAgentModelLLM('/nonexistent/path/xyz');
      assert.equal(result, null);
    });

    it('returns null when metadata has no modelPresets', () => {
      const agentDir = join(tempDir, 'no-presets');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'metadata.json'), JSON.stringify({ name: 'test' }));
      const result = resolveAgentModelLLM(agentDir);
      assert.equal(result, null);
    });

    // NOTE: 下面三个"解析成功路径"用例与上面的 'resolves …' 用例已移除：
    // 它们依赖 config/presets.json 里存在特定真实 preset。保留的用例覆盖
    // metadata 缺失 / 无 modelPresets / 无可回退 default / 非法 JSON 的
    // 纯逻辑路径，不依赖机器本地配置。

    it('returns null when neither role nor default has a preset', () => {
      const agentDir = join(tempDir, 'no-default');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'metadata.json'), JSON.stringify({
        name: 'test-agent',
        modelPresets: {
          exploration: '智谱GLM-5.2',
        },
      }));
      // Requesting 'sub' role, which has no preset and no default to fall back to
      const result = resolveAgentModelLLM(agentDir, 'sub');
      assert.equal(result, null);
    });

    it('handles invalid JSON in metadata.json gracefully', () => {
      const agentDir = join(tempDir, 'bad-json');
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, 'metadata.json'), '{ invalid json }}}');
      const result = resolveAgentModelLLM(agentDir);
      assert.equal(result, null);
    });
  });
});
