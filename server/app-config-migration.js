import path from 'path';
import { constants as fsConstants, promises as fs } from 'fs';

const LEGACY_CONFIG_FILES = [
  ['config/default.json', 'default.json'],
  ['config/presets.json', 'presets.json'],
  ['.agentdev/qqbot.config.json', 'qqbot.config.json'],
  ['.agentdev/weixin-bot.config.json', 'weixin-bot.config.json'],
  ['.agentdev/feishu-bot.config.json', 'feishu-bot.config.json'],
  ['.agentdev/wecom-bot.config.json', 'wecom-bot.config.json'],
  ['.agentdev/rokid.config.json', 'rokid.config.json'],
  ['.agentdev/im-workspace.config.json', 'im-workspace.config.json'],
  ['.agentdev/mcp-gateway.json', 'mcp-gateway.json'],
  ['.agentdev/remote-claw.json', 'remote-claw.json'],
];

/**
 * Copy legacy app-owned settings into the user data root when the destination
 * does not exist. Existing destination files always win; the source is kept.
 */
export async function migrateLegacyAppConfig({ legacyRoot, userDataRoot }) {
  const result = { migrated: [], skipped: [], errors: [] };

  async function copyIfMissing(source, destination, label) {
    try {
      await fs.access(source);
    } catch (error) {
      if (error.code !== 'ENOENT') result.errors.push({ label, error });
      return;
    }

    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
      result.migrated.push(label);
    } catch (error) {
      if (error.code === 'EEXIST') {
        result.skipped.push(label);
        return;
      }
      result.errors.push({ label, error });
    }
  }

  for (const [legacyRelativePath, destinationName] of LEGACY_CONFIG_FILES) {
    await copyIfMissing(
      path.join(legacyRoot, legacyRelativePath),
      path.join(userDataRoot, destinationName),
      destinationName,
    );
  }

  const legacyAgentConfigDir = path.join(legacyRoot, '.agentdev', 'agent-configs');
  try {
    const entries = await fs.readdir(legacyAgentConfigDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
      await copyIfMissing(
        path.join(legacyAgentConfigDir, entry.name),
        path.join(userDataRoot, 'agent-configs', entry.name),
        path.join('agent-configs', entry.name),
      );
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      result.errors.push({ label: 'agent-configs', error });
    }
  }

  return result;
}
