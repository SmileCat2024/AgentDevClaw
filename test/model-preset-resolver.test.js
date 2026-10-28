import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// 数据隔离：AGENTDEV_DATA_DIR 指向临时目录，必须在任何 server 模块 import
// 之前设置（constants 在模块加载期解析 USER_DATA_ROOT / MODEL_CONNECTIONS_PATH；
// codex 账号簿查找链会读 connections 文件与 oauth-tokens 目录）。
const DATA_DIR = mkdtempSync(join(tmpdir(), 'claw-resolver-fixture-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;

const {
  resolveModelPresetLLM,
  resolveAgentModelLLM,
  resolveGlobalDefaultLLM,
  modelPresetResolver,
  GLOBAL_DEFAULT_PRESET_NAME,
  ensureOpenCodeSessionHeader,
} = await import('../server/model-preset-resolver.js');

after(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

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
          { name: 'OpenCode Go', apiKey: 'expired-inline-key', endpoints: { openai: 'https://opencode.ai/zen/go/v1' } },
        ],
        presets: [
          { name: 'fixture-anthropic', providerName: 'Fixture Anthropic', protocol: 'anthropic', model: 'fixture-model-a' },
          { name: 'fixture-openai-chat', providerName: 'Fixture OpenAI', protocol: 'openai', apiSurface: 'chat', model: 'fixture-model-b' },
          { name: 'fixture-openai-default-surface', providerName: 'Fixture OpenAI', protocol: 'openai', model: 'fixture-model-b2' },
          { name: 'fixture-thinking', providerName: 'Fixture Anthropic', protocol: 'anthropic', model: 'fixture-model-t', thinkingEffort: 'medium' },
          { name: 'fixture-oauth', providerName: 'Fixture OAuth', protocol: 'openai', model: 'fixture-model-o' },
          { name: 'fixture-codex-catalog', providerName: 'Fixture OAuth', catalogProvider: 'codex', protocol: 'openai', model: 'fixture-model-codex', providerOptions: { service_tier: 'priority', prompt_cache_retention: '24h' } },
          { name: 'fixture-orphan', providerName: 'No Such Provider', protocol: 'anthropic', model: 'fixture-model-x' },
          { name: 'fixture-incomplete', providerName: 'Fixture Anthropic', protocol: 'anthropic' },
          // OpenCode 存量形态：目录功能引入 catalogProvider 标记前创建，
          // 凭证内联在 providers 数组（过期旧 key），登录新 key 只更新 connections。
          { name: 'fixture-opencode-legacy-go', providerName: 'OpenCode Go', protocol: 'openai', apiSurface: 'chat', model: 'fixture-model-oc-go' },
          { name: 'fixture-opencode-legacy-zen', providerName: 'OpenCode Zen', protocol: 'openai', apiSurface: 'chat', model: 'fixture-model-oc-zen' },
          { name: 'fixture-opencode-catalog', providerName: 'OpenCode Go', catalogProvider: 'opencode', protocol: 'openai', apiSurface: 'chat', model: 'fixture-model-oc-cat' },
          { name: 'fixture-opencode-manual-session', providerName: 'OpenCode Go', protocol: 'openai', apiSurface: 'chat', model: 'fixture-model-oc-manual', customHeaders: [{ key: 'x-opencode-session', value: 'manual-session-id', valueMode: 'static' }] },
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

      it('uses the catalog preset provider token before the shared Codex connection token', () => {
        const seen = [];
        const result = resolveModelPresetLLM('fixture-codex-catalog', undefined, {
          configPath,
          resolveActiveProvider: () => null,
          resolveAccessToken: (providerName) => { seen.push(providerName); return providerName === 'Fixture OAuth' ? 'fixture-access-token' : null; },
        });
        assert.ok(result);
        assert.deepEqual(seen, ['Fixture OAuth']);
      });

      it('prefers the active codex account token over the preset static provider reference', () => {
        // 多账号：账号簿 active 槽位优先——全局切换账号后同一 preset 换 token 来源
        const seen = [];
        const result = resolveModelPresetLLM('fixture-codex-catalog', undefined, {
          configPath,
          resolveActiveProvider: () => 'codex-account-2',
          resolveAccessToken: (providerName) => { seen.push(providerName); return providerName === 'codex-account-2' ? 'active-account-token' : null; },
        });
        assert.ok(result);
        assert.deepEqual(seen, ['codex-account-2'], 'active 命中时不得再试静态引用');
        assert.equal(result.providerName, 'codex-account-2', '返回值透传实际命中的槽位名（UI 显示当前账号）');
      });

      it('falls back to the static lookup chain when the active account has no token', () => {
        const seen = [];
        const result = resolveModelPresetLLM('fixture-codex-catalog', undefined, {
          configPath,
          resolveActiveProvider: () => 'logged-out-slot',
          resolveAccessToken: (providerName) => { seen.push(providerName); return providerName === 'Fixture OAuth' ? 'legacy-token' : null; },
        });
        assert.ok(result);
        assert.deepEqual(seen, ['logged-out-slot', 'Fixture OAuth']);
        assert.equal(result.providerName, 'Fixture OAuth');
      });

      it('resolves a Codex catalog preset through the legacy OAuth provider token name', () => {
        const result = resolveModelPresetLLM('fixture-codex-catalog', undefined, {
          configPath,
          resolveAccessToken: (providerName) => providerName === 'Fixture OAuth' ? 'legacy-token' : null,
        });
        assert.ok(result);
        assert.equal(result.modelName, 'fixture-model-codex');
        assert.equal(result.baseUrl, 'https://chatgpt.com/backend-api/codex');
        assert.equal(result.apiSurface, 'responses');
        assert.deepEqual(result.llm.providerOptions, { service_tier: 'priority', prompt_cache_retention: '24h' });
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

    describe('OpenCode connections (legacy normalization + session header)', () => {
      let connectionsPath;
      let noCredentialConnectionsPath;

      before(() => {
        connectionsPath = join(fixtureDir, 'connections-fixture.json');
        writeFileSync(connectionsPath, JSON.stringify({
          opencode: { apiKey: 'fresh-login-key', tier: 'go' },
        }));
        noCredentialConnectionsPath = join(fixtureDir, 'connections-empty.json');
        writeFileSync(noCredentialConnectionsPath, JSON.stringify({}));
      });

      it('normalizes a legacy OpenCode Go preset onto the login credential and tier baseUrl', () => {
        const result = resolveModelPresetLLM('fixture-opencode-legacy-go', undefined, { configPath, connectionsPath });
        assert.ok(result, 'legacy preset must resolve via connections credential');
        assert.equal(result.baseUrl, 'https://opencode.ai/zen/go/v1', 'baseUrl must follow the login tier, not the inline provider endpoint');
        assert.equal(result.providerName, 'OpenCode');
        assert.equal(result.authType, '');
      });

      it('normalizes a legacy OpenCode Zen preset when the connection has no tier', () => {
        const zenConnectionsPath = join(fixtureDir, 'connections-zen.json');
        writeFileSync(zenConnectionsPath, JSON.stringify({ opencode: { apiKey: 'fresh-login-key' } }));
        const result = resolveModelPresetLLM('fixture-opencode-legacy-zen', undefined, { configPath, connectionsPath: zenConnectionsPath });
        assert.ok(result);
        assert.equal(result.baseUrl, 'https://opencode.ai/zen/v1');
      });

      it('resolves a catalog OpenCode preset through the login credential', () => {
        const result = resolveModelPresetLLM('fixture-opencode-catalog', undefined, { configPath, connectionsPath });
        assert.ok(result);
        assert.equal(result.baseUrl, 'https://opencode.ai/zen/go/v1');
      });

      it('fails (no fallback) when the login credential is absent, even if the inline provider key exists', () => {
        const result = resolveModelPresetLLM('fixture-opencode-legacy-go', undefined, { configPath, connectionsPath: noCredentialConnectionsPath });
        assert.equal(result, null, 'must not fall back to the stale inline provider key');
      });

      it('keeps resolving a legacy preset with a manual session header', () => {
        const result = resolveModelPresetLLM('fixture-opencode-manual-session', undefined, { configPath, connectionsPath });
        assert.ok(result);
      });

      it('non-OpenCode custom providers are untouched by the normalization', () => {
        const result = resolveModelPresetLLM('fixture-anthropic', undefined, { configPath, connectionsPath });
        assert.ok(result);
        assert.equal(result.baseUrl, 'https://fixture-anthropic.example/api');
        assert.equal(result.providerName, 'Fixture Anthropic');
      });
    });

    describe('ensureOpenCodeSessionHeader', () => {
      it('injects a deterministic UUID-shaped session header for absent headers', () => {
        const injected = ensureOpenCodeSessionHeader([], 'preset-a');
        assert.equal(injected.length, 1);
        assert.equal(injected[0].key, 'x-opencode-session');
        assert.match(injected[0].value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      });

      it('is idempotent: the same preset name yields the same session id', () => {
        const a = ensureOpenCodeSessionHeader(undefined, 'preset-a');
        const b = ensureOpenCodeSessionHeader([], 'preset-a');
        assert.equal(a[0].value, b[0].value);
        const c = ensureOpenCodeSessionHeader([], 'preset-b');
        assert.notEqual(a[0].value, c[0].value, 'different presets get different session ids');
      });

      it('never overrides a user-configured session header (case-insensitive)', () => {
        const manual = [{ key: 'X-OpenCode-Session', value: 'manual-session-id', valueMode: 'static' }];
        const result = ensureOpenCodeSessionHeader(manual, 'preset-a');
        assert.equal(result.length, 1);
        assert.equal(result[0].value, 'manual-session-id');
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

      it('applies the primary slot thinking effort without changing the model preset', () => {
        const agentDir = writeAgentMetadata('object-preset-effort', {
          default: {
            primary: 'fixture-thinking',
            secondary: 'fixture-anthropic',
            thinkingEffort: { primary: 'high', secondary: 'low' },
          },
        });
        const result = resolveAgentModelLLM(agentDir, 'default', { configPath });
        assert.ok(result);
        assert.equal(result.thinkingEffort, 'high');
        const secondary = resolveModelPresetLLM('fixture-thinking', { thinkingEffort: 'low' }, { configPath });
        assert.ok(secondary);
        assert.equal(secondary.thinkingEffort, 'low');
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

    describe('resolveGlobalDefaultLLM / modelPresetResolver (__default__ alias)', () => {
      let defaultConfigPath;

      before(() => {
        defaultConfigPath = join(fixtureDir, 'default.json');
        writeFileSync(defaultConfigPath, JSON.stringify({
          defaultModel: {
            provider: 'anthropic',
            apiSurface: 'chat',
            model: 'fixture-default-model',
            baseUrl: 'https://fixture-default.example/api',
            apiKey: 'fixture-key',
            thinkingEffort: 'medium',
            providerOptions: { service_tier: 'priority', prompt_cache_retention: '24h' },
          },
        }));
      });

      it('inline defaultModel resolves with the synthetic __default__ preset name and full meta', () => {
        const result = resolveGlobalDefaultLLM(undefined, { configPath: defaultConfigPath });
        assert.ok(result);
        assert.ok(result.llm);
        assert.equal(result.modelName, 'fixture-default-model');
        assert.equal(result.presetName, GLOBAL_DEFAULT_PRESET_NAME);
        assert.equal(result.thinkingEffort, 'medium');
        assert.equal(result.protocol, 'anthropic');
        assert.deepEqual(result.llm.providerOptions, { service_tier: 'priority', prompt_cache_retention: '24h' });
      });

      it('resolves the selected preset by name when the same model has Normal and Fast presets', () => {
        const namedPresetsPath = join(fixtureDir, 'named-default-presets.json');
        const namedDefaultPath = join(fixtureDir, 'named-default.json');
        writeFileSync(namedPresetsPath, JSON.stringify({
          providers: [{ name: 'fixture', apiKey: 'test', endpoints: { openai: 'https://example.com/v1' } }],
          presets: [
            { name: 'Normal', providerName: 'fixture', protocol: 'openai', model: 'same-model' },
            { name: 'Fast', providerName: 'fixture', protocol: 'openai', model: 'same-model', providerOptions: { service_tier: 'priority' } },
          ],
        }));
        writeFileSync(namedDefaultPath, JSON.stringify({ defaultModel: { model: 'same-model', provider: 'openai', presetName: 'Fast' } }));
        const result = resolveGlobalDefaultLLM(undefined, { configPath: namedDefaultPath, presetsPath: namedPresetsPath });
        assert.ok(result);
        assert.deepEqual(result.llm.providerOptions, { service_tier: 'priority' });
      });

      it('thinkingEffort override applies to the inline default (re-resolve for setThinkingEffort)', () => {
        const result = resolveGlobalDefaultLLM({ thinkingEffort: 'high' }, { configPath: defaultConfigPath });
        assert.ok(result);
        assert.equal(result.thinkingEffort, 'high');
        const cleared = resolveGlobalDefaultLLM({ thinkingEffort: null }, { configPath: defaultConfigPath });
        assert.ok(cleared);
        assert.equal(cleared.thinkingEffort, null);
      });

      it('modelPresetResolver.resolve maps __default__ through resolveGlobalDefaultLLM and returns contract shape', () => {
        const resolved = modelPresetResolver.resolve(GLOBAL_DEFAULT_PRESET_NAME, undefined, { configPath: defaultConfigPath });
        assert.ok(resolved);
        assert.ok(resolved.llm);
        assert.equal(resolved.meta.presetName, GLOBAL_DEFAULT_PRESET_NAME);
        assert.equal(resolved.meta.modelName, 'fixture-default-model');
        assert.equal(resolved.meta.thinkingEffort, 'medium');
        assert.equal(resolved.meta.provider, 'anthropic');
      });

      it('modelPresetResolver.resolve maps unknown names to null (contract: no throw)', () => {
        assert.equal(modelPresetResolver.resolve('definitely-not-a-preset-xyz'), null);
      });

      it('inline defaultModel without contextLength backfills window meta from presets.json by model name', () => {
        const presetsFixturePath = join(fixtureDir, 'default-window-presets.json');
        writeFileSync(presetsFixturePath, JSON.stringify({
          presets: [
            { name: 'Fixture Default (window)', model: 'fixture-default-model', contextLength: 999000, compressRatio: 60 },
          ],
        }));
        const result = resolveGlobalDefaultLLM(undefined, { configPath: defaultConfigPath, presetsPath: presetsFixturePath });
        assert.ok(result);
        assert.equal(result.contextLength, 999000);
        assert.equal(result.compressRatio, 60);
      });

      it('inline window meta stays null when no presets entry matches the model', () => {
        const emptyPresetsPath = join(fixtureDir, 'default-empty-presets.json');
        writeFileSync(emptyPresetsPath, JSON.stringify({ presets: [] }));
        const result = resolveGlobalDefaultLLM(undefined, { configPath: defaultConfigPath, presetsPath: emptyPresetsPath });
        assert.ok(result);
        assert.equal(result.contextLength, null);
        assert.equal(result.compressRatio, 80);
      });
    });
  });
});
