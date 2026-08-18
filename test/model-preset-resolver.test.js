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
    // 成功路径改由下方 fixture-based success paths 用例（options 测试缝）覆盖。

    it('returns null when provider is missing (preset references nonexistent provider)', () => {
      // 通过不存在的 preset 名锁定 "not found" 返回路径；provider 真正缺失的
      // 路径由下方 fixture-orphan 用例覆盖。
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
    // 纯逻辑路径；成功路径由下方 fixture-based success paths 用例覆盖。

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

  // ── Fixture-based success paths ────────────────────────────
  // 通过 options 测试缝（configPath / userConfigPath / resolveAccessToken）
  // 注入 fixture 配置，恢复成功路径覆盖，不依赖机器本地 config/presets.json。

  describe('fixture-based success paths', () => {
    let fixtureDir;
    let configPath;

    before(() => {
      fixtureDir = join(tmpdir(), `model-preset-fixture-${Date.now()}`);
      mkdirSync(fixtureDir, { recursive: true });
      configPath = join(fixtureDir, 'presets-fixture.json');
      writeFileSync(configPath, JSON.stringify({
        providers: [
          { name: 'Fixture Anthropic', apiKey: 'test-key-a', endpoints: { anthropic: 'https://fixture-anthropic.example/api' } },
          { name: 'Fixture OpenAI', apiKey: 'test-key-b', endpoints: { openai: 'https://fixture-openai.example/v1' } },
          { name: 'Fixture OAuth', authType: 'oauth-codex', clientId: 'test-client-id', endpoints: { openai: 'https://fixture-oauth.example/v1' } },
        ],
        presets: [
          { name: 'fixture-anthropic', providerName: 'Fixture Anthropic', protocol: 'anthropic', model: 'fixture-model-a' },
          { name: 'fixture-openai-chat', providerName: 'Fixture OpenAI', protocol: 'openai', apiSurface: 'chat', model: 'fixture-model-b' },
          { name: 'fixture-openai-default-surface', providerName: 'Fixture OpenAI', protocol: 'openai', model: 'fixture-model-b2' },
          { name: 'fixture-thinking', providerName: 'Fixture Anthropic', protocol: 'anthropic', model: 'fixture-model-t', thinkingEffort: 'medium' },
          { name: 'fixture-oauth', providerName: 'Fixture OAuth', protocol: 'openai', model: 'fixture-model-o' },
          { name: 'fixture-orphan', providerName: 'No Such Provider', protocol: 'anthropic', model: 'fixture-model-x' },
          { name: 'fixture-incomplete', providerName: 'Fixture Anthropic', protocol: 'anthropic' },
        ],
      }));
    });

    after(() => {
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    describe('resolveModelPresetLLM (options.configPath)', () => {
      it('resolves an anthropic-protocol preset to an LLM client with model info', () => {
        const result = resolveModelPresetLLM('fixture-anthropic', undefined, { configPath });
        assert.ok(result, 'should resolve fixture preset');
        assert.ok(result.llm, 'should have llm client');
        assert.equal(result.modelName, 'fixture-model-a');
        assert.equal(result.presetName, 'fixture-anthropic');
        assert.equal(result.providerName, 'Fixture Anthropic');
        assert.equal(result.protocol, 'anthropic');
        assert.equal(result.baseUrl, 'https://fixture-anthropic.example/api');
        assert.equal(result.authType, '');
      });

      it('resolves an openai-protocol preset with apiSurface chat', () => {
        const result = resolveModelPresetLLM('fixture-openai-chat', undefined, { configPath });
        assert.ok(result);
        assert.equal(result.protocol, 'openai');
        assert.equal(result.apiSurface, 'chat');
      });

      it('defaults openai apiSurface to chat when the preset omits it', () => {
        const result = resolveModelPresetLLM('fixture-openai-default-surface', undefined, { configPath });
        assert.ok(result);
        assert.equal(result.apiSurface, 'chat');
      });

      it('forces oauth-codex providers onto the responses transport', () => {
        const result = resolveModelPresetLLM('fixture-oauth', undefined, {
          configPath,
          resolveAccessToken: () => 'fixture-access-token',
        });
        assert.ok(result);
        assert.equal(result.authType, 'oauth-codex');
        assert.equal(result.apiSurface, 'responses');
        assert.equal(result.llm.constructor.name, 'OpenAIResponsesLLM');
      });

      it('returns null for an oauth provider without a stored token', () => {
        const result = resolveModelPresetLLM('fixture-oauth', undefined, {
          configPath,
          resolveAccessToken: () => null,
        });
        assert.equal(result, null);
      });

      it('returns null when the preset references a nonexistent provider', () => {
        const result = resolveModelPresetLLM('fixture-orphan', undefined, { configPath });
        assert.equal(result, null);
      });

      it('returns null when the preset config is incomplete (missing model)', () => {
        const result = resolveModelPresetLLM('fixture-incomplete', undefined, { configPath });
        assert.equal(result, null);
      });

      it('returns preset default thinkingEffort without overrides', () => {
        const result = resolveModelPresetLLM('fixture-thinking', undefined, { configPath });
        assert.ok(result);
        assert.ok('thinkingEffort' in result, 'result must always carry the thinkingEffort key');
        assert.equal(result.thinkingEffort, 'medium');
      });

      it('runtime override beats preset default thinkingEffort', () => {
        const result = resolveModelPresetLLM('fixture-thinking', { thinkingEffort: 'high' }, { configPath });
        assert.ok(result);
        assert.equal(result.thinkingEffort, 'high');
      });

      it('null override clears preset default thinkingEffort', () => {
        const result = resolveModelPresetLLM('fixture-thinking', { thinkingEffort: null }, { configPath });
        assert.ok(result);
        assert.equal(result.thinkingEffort, null);
      });

      it('empty overrides object falls back to preset default thinkingEffort', () => {
        const result = resolveModelPresetLLM('fixture-thinking', {}, { configPath });
        assert.ok(result);
        assert.equal(result.thinkingEffort, 'medium');
      });
    });

    describe('resolveAgentModelLLM (options.configPath / options.userConfigPath)', () => {
      function writeAgentMetadata(name, modelPresets) {
        const agentDir = join(fixtureDir, name);
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(join(agentDir, 'metadata.json'), JSON.stringify({ name: 'fixture-agent', modelPresets }));
        return agentDir;
      }

      it('resolves a string preset for the default role', () => {
        const agentDir = writeAgentMetadata('string-preset', { default: 'fixture-anthropic' });
        const result = resolveAgentModelLLM(agentDir, 'default', { configPath });
        assert.ok(result);
        assert.equal(result.presetRole, 'default');
        assert.equal(result.modelName, 'fixture-model-a');
      });

      it('resolves the primary slot of an object preset', () => {
        const agentDir = writeAgentMetadata('object-preset', {
          default: { primary: 'fixture-openai-chat', secondary: 'fixture-anthropic' },
        });
        const result = resolveAgentModelLLM(agentDir, 'default', { configPath });
        assert.ok(result);
        assert.equal(result.modelName, 'fixture-model-b', 'primary slot must win over secondary');
      });

      it('falls back to the default role when the requested role has no preset', () => {
        const agentDir = writeAgentMetadata('fallback', { default: 'fixture-anthropic' });
        const result = resolveAgentModelLLM(agentDir, 'exploration', { configPath });
        assert.ok(result);
        assert.equal(result.presetRole, 'exploration');
        assert.equal(result.modelName, 'fixture-model-a');
      });

      it('user config presets override metadata presets', () => {
        const agentDir = writeAgentMetadata('user-config-merge', { default: 'fixture-anthropic' });
        const userConfigPath = join(fixtureDir, 'user-config-merge.json');
        writeFileSync(userConfigPath, JSON.stringify({ modelPresets: { default: 'fixture-openai-chat' } }));
        const result = resolveAgentModelLLM(agentDir, 'default', { configPath, userConfigPath });
        assert.ok(result);
        assert.equal(result.modelName, 'fixture-model-b', 'user config preset must win over metadata');
      });

      it('invalid user config falls back to metadata presets', () => {
        const agentDir = writeAgentMetadata('user-config-bad-json', { default: 'fixture-anthropic' });
        const userConfigPath = join(fixtureDir, 'user-config-bad.json');
        writeFileSync(userConfigPath, '{ invalid json');
        const result = resolveAgentModelLLM(agentDir, 'default', { configPath, userConfigPath });
        assert.ok(result);
        assert.equal(result.modelName, 'fixture-model-a');
      });
    });
  });
});
