/**
 * Codex OAuth 存量槽位名迁移（server/codex-account-migration.js）测试
 *
 * 覆盖契约（每条对应一个伤害场景）：
 * - 完整迁移：token 文件 / 账号簿（含 activeProvider）/ model-config 引用
 *   三处一致换名，displayName 保留——半迁移会让 resolver 断链或账号"消失"
 * - 幂等：迁移后再跑跳过，数据不再变化
 * - 干净环境：无旧 token 且无旧条目时不动任何文件
 * - 无 token 残留条目：账号簿旧条目换名、token 步骤跳过
 *
 * 数据隔离：AGENTDEV_DATA_DIR 指向临时目录，必须在任何 server 模块 import
 * 之前设置（constants 在模块加载期解析 USER_DATA_ROOT）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'path';

const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'claw-codex-slot-migration-'));
process.env.AGENTDEV_DATA_DIR = DATA_DIR;
const TOKENS_DIR = path.join(DATA_DIR, 'oauth-tokens');
const CONNECTIONS_PATH = path.join(DATA_DIR, 'model-connections.json');
const PRESETS_PATH = path.join(DATA_DIR, 'presets.json');

const { migrateLegacyCodexSlotName } = await import('../server/codex-account-migration.js');
const { listCodexAccounts } = await import('../server/codex-accounts.js');

function resetState() {
  rmSync(TOKENS_DIR, { recursive: true, force: true });
  rmSync(CONNECTIONS_PATH, { force: true });
  rmSync(PRESETS_PATH, { force: true });
}

function seedLegacyState({ withToken = true, withBook = true, withPresets = true } = {}) {
  if (withToken) {
    mkdirSync(TOKENS_DIR, { recursive: true });
    writeFileSync(
      path.join(TOKENS_DIR, 'OpenAI_Auth.json'),
      JSON.stringify({ access_token: 'tok-legacy', refresh_token: 'rt', client_id: 'cid' }),
      'utf8',
    );
  }
  if (withBook) {
    writeFileSync(CONNECTIONS_PATH, JSON.stringify({
      codex: {
        accounts: [{ providerName: 'OpenAI Auth', displayName: '主号' }],
        activeProvider: 'OpenAI Auth',
      },
    }, null, 2), 'utf8');
  }
  if (withPresets) {
    writeFileSync(PRESETS_PATH, JSON.stringify({
      providers: [{ name: 'OpenAI Auth', authType: 'oauth-codex', endpoints: { openai: 'https://chatgpt.com/backend-api/codex' } }],
      presets: [{ providerName: 'OpenAI Auth', protocol: 'openai', apiSurface: 'chat', model: 'gpt-5-codex' }],
    }, null, 2), 'utf8');
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('codex slot name migration', () => {
  before(() => resetState());
  after(() => resetState());

  it('migrates token file, account book and model-config references consistently', async () => {
    seedLegacyState();
    const result = await migrateLegacyCodexSlotName();
    assert.equal(result.skipped, false);
    assert.equal(result.newName, 'codex-account-1');
    assert.equal(result.tokenRenamed, true);

    // token：旧文件消失，新文件内容原样
    assert.equal(existsSync(path.join(TOKENS_DIR, 'OpenAI_Auth.json')), false);
    const tokenFile = path.join(TOKENS_DIR, 'codex-account-1.json');
    assert.equal(existsSync(tokenFile), true);
    assert.equal(readJson(tokenFile).access_token, 'tok-legacy');

    // 账号簿：槽位换名、displayName 保留、active 同步
    const book = readJson(CONNECTIONS_PATH).codex;
    assert.deepEqual(book.accounts, [{ providerName: 'codex-account-1', displayName: '主号' }]);
    assert.equal(book.activeProvider, 'codex-account-1');

    // model-config：providers 与 presets 引用同步换名
    const presets = readJson(PRESETS_PATH);
    assert.equal(presets.providers[0].name, 'codex-account-1');
    assert.equal(presets.presets[0].providerName, 'codex-account-1');

    // 合并视图：新槽位有 token 且仍是当前账号（不丢可用性）
    const view = listCodexAccounts();
    assert.equal(view.activeProvider, 'codex-account-1');
    assert.equal(view.accounts.find((a) => a.providerName === 'codex-account-1')?.hasToken, true);
  });

  it('is idempotent: second run skips and leaves data untouched', async () => {
    const before = readFileSync(path.join(TOKENS_DIR, 'codex-account-1.json'), 'utf8');
    const result = await migrateLegacyCodexSlotName();
    assert.equal(result.skipped, true);
    assert.equal(readFileSync(path.join(TOKENS_DIR, 'codex-account-1.json'), 'utf8'), before);
    assert.equal(readJson(CONNECTIONS_PATH).codex.activeProvider, 'codex-account-1');
  });

  it('skips entirely on a clean install', async () => {
    resetState();
    const result = await migrateLegacyCodexSlotName();
    assert.equal(result.skipped, true);
    assert.equal(existsSync(CONNECTIONS_PATH), false);
    assert.equal(existsSync(PRESETS_PATH), false);
  });

  it('renames a book-only legacy entry without touching tokens', async () => {
    resetState();
    seedLegacyState({ withToken: false });
    const result = await migrateLegacyCodexSlotName();
    assert.equal(result.skipped, false);
    assert.equal(result.tokenRenamed, false);
    const book = readJson(CONNECTIONS_PATH).codex;
    assert.deepEqual(book.accounts, [{ providerName: 'codex-account-1', displayName: '主号' }]);
    assert.equal(book.activeProvider, 'codex-account-1');
    assert.equal(readJson(PRESETS_PATH).presets[0].providerName, 'codex-account-1');
  });
});
