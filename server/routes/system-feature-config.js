import path from 'path';
import os from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { execSync } from 'child_process';

import { USER_DATA_ROOT } from '../shared/constants.js';

const SYSTEM_FEATURE_CONFIG_PATH = path.join(USER_DATA_ROOT, 'feature-setup.json');

const CONTEXT_GUARD_MANIFEST = {
  settings: {
    sections: [{
      id: 'context-guard',
      title: '上下文保护',
      properties: ['enabled'],
    }],
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        title: '上下文保护',
      },
    },
  },
};

/**
 * Detect whether a shell executable is available on this system.
 * Mirrors the logic in ShellFeature's findGitBashPath / findPowerShellPath.
 */
function detectShellPath(type, configuredPath) {
  // 0. User-configured path
  if (configuredPath && configuredPath.trim()) {
    const p = configuredPath.trim();
    if (existsSync(p)) return { available: true, path: p, source: 'configured' };
  }

  const isWin = process.platform === 'win32';

  if (type === 'bash') {
    // 1. Env var
    if (process.env.AGENTDEV_GIT_BASH_PATH && existsSync(process.env.AGENTDEV_GIT_BASH_PATH)) {
      return { available: true, path: process.env.AGENTDEV_GIT_BASH_PATH, source: 'env' };
    }
    if (!isWin) {
      const shellPath = process.env.SHELL || '/bin/bash';
      return { available: true, path: shellPath, source: 'env' };
    }
    // 2. Common Windows locations
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    // 3. `where bash`
    try {
      const result = execSync('where bash', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of result.split('\n').map(l => l.trim()).filter(Boolean)) {
        if (line.toLowerCase().includes('git')) candidates.push(line);
      }
    } catch { /* where not available or bash not found */ }
    // 4. Derive from git path
    try {
      const gitPath = execSync('where git', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')[0]?.trim();
      if (gitPath) candidates.push(path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe'));
    } catch { /* git not in PATH */ }

    for (const c of candidates) {
      if (c && existsSync(c)) return { available: true, path: c, source: 'auto-detected' };
    }
    return { available: false, path: null, source: null };
  }

  if (type === 'powershell') {
    // 1. Env var
    if (process.env.AGENTDEV_POWERSHELL_PATH && existsSync(process.env.AGENTDEV_POWERSHELL_PATH)) {
      return { available: true, path: process.env.AGENTDEV_POWERSHELL_PATH, source: 'env' };
    }
    const whereCmd = isWin ? 'where' : 'which';
    // 2. pwsh (PS 7+)
    try {
      const result = execSync(`${whereCmd} pwsh`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const p = result.split('\n').map(l => l.trim()).filter(Boolean)[0];
      if (p && existsSync(p)) return { available: true, path: p, source: 'auto-detected' };
    } catch { /* pwsh not installed */ }
    // 3. powershell (5.1, Windows only)
    if (isWin) {
      try {
        const result = execSync(`${whereCmd} powershell`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const p = result.split('\n').map(l => l.trim()).filter(Boolean)[0];
        if (p && existsSync(p)) return { available: true, path: p, source: 'auto-detected' };
      } catch { /* not in PATH */ }
      // 4. System default path
      const sysPath = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      if (existsSync(sysPath)) return { available: true, path: sysPath, source: 'auto-detected' };
    }
    return { available: false, path: null, source: null };
  }

  return { available: false, path: null, source: null };
}

export function readSystemFeatureConfigFile(configPath = SYSTEM_FEATURE_CONFIG_PATH) {
  try {
    if (!existsSync(configPath)) return {};
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSystemFeatureConfigFile(config, configPath = SYSTEM_FEATURE_CONFIG_PATH) {
  const dir = path.dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Extract LSP server config from system feature config.
 * Input:  { lsp: { typescript: { mode, runtime, binary, package, uvPackage, args } } }
 * Output: { typescript: { mode, runtime, binary, package, uvPackage, args } }
 */
export function extractLspServerConfig(systemConfig) {
  const lspSection = systemConfig?.lsp;
  if (!lspSection || typeof lspSection !== 'object') return {};
  const result = {};
  for (const [serverId, entry] of Object.entries(lspSection)) {
    if (entry && typeof entry === 'object') {
      const serverConfig = {};
      if (typeof entry.mode === 'string') serverConfig.mode = entry.mode;
      if (typeof entry.runtime === 'string') serverConfig.runtime = entry.runtime;
      if (typeof entry.binary === 'string' && entry.binary.trim()) serverConfig.binary = entry.binary.trim();
      if (typeof entry.package === 'string' && entry.package.trim()) serverConfig.package = entry.package.trim();
      if (typeof entry.uvPackage === 'string' && entry.uvPackage.trim()) serverConfig.uvPackage = entry.uvPackage.trim();
      if (typeof entry.args === 'string' && entry.args.trim()) serverConfig.args = entry.args.trim().split(/\s+/);
      if (Object.keys(serverConfig).length) result[serverId] = serverConfig;
    }
  }
  return result;
}

export function setupSystemFeatureConfigRoutes(app, express) {
  app.get('/protoclaw/system_feature_config', (_req, res) => {
    res.json(readSystemFeatureConfigFile());
  });

  app.put('/protoclaw/system_feature_config', express.json(), (req, res) => {
    const config = req.body;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return res.status(400).json({ error: 'Config must be a non-null object' });
    }

    // ── Validate shell config: strip enabled-but-unavailable shells ──
    if (config.shell && typeof config.shell === 'object') {
      const bashAvail = detectShellPath('bash', config.shell.bashPath);
      const psAvail = detectShellPath('powershell', config.shell.powershellPath);
      const changes = [];

      if (config.shell.bashEnabled && !bashAvail.available) {
        config.shell.bashEnabled = false;
        changes.push('bash');
      }
      if (config.shell.powershellEnabled && !psAvail.available) {
        config.shell.powershellEnabled = false;
        changes.push('powershell');
      }
    }

    writeSystemFeatureConfigFile(config);
    res.json({ ok: true });
  });

  app.get('/protoclaw/shell_availability', (req, res) => {
    const config = readSystemFeatureConfigFile();
    const shellConfig = config.shell || {};
    res.json({
      bash: detectShellPath('bash', shellConfig.bashPath),
      powershell: detectShellPath('powershell', shellConfig.powershellPath),
    });
  });

  // ── Directory browser for feature-setup UI ──────────────────
  app.get('/protoclaw/browse_dirs', (req, res) => {
    try {
      const targetPath = req.query.path || os.homedir();
      const includeFiles = req.query.includeFiles === 'true';
      const resolved = path.resolve(targetPath);

      const rawEntries = readdirSync(resolved, { withFileTypes: true });

      const dirs = rawEntries
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, path: path.join(resolved, e.name), isDirectory: true }));

      const files = includeFiles
        ? rawEntries
            .filter(e => e.isFile())
            .map(e => ({ name: e.name, path: path.join(resolved, e.name), isDirectory: false }))
        : [];

      const entries = [...dirs, ...files].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      // Detect available drive letters on Windows
      let drives = [];
      if (process.platform === 'win32') {
        for (let i = 65; i <= 90; i++) {
          const letter = String.fromCharCode(i);
          const drivePath = `${letter}:\\`;
          if (existsSync(drivePath)) {
            drives.push({ label: `${letter}:`, path: drivePath });
          }
        }
      }

      const parent = path.dirname(resolved);
      const hasParent = parent !== resolved && parent.length > 0;

      res.json({
        currentPath: resolved,
        parent: hasParent ? parent : null,
        entries,
        drives,
        platform: process.platform,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/protoclaw/system_feature_manifests', async (_req, res) => {
    try {
      const seen = new Set();
      const features = [];

      const importPaths = [
        'agentdev',
        '../../local-features/dist/index.js',
      ];
      for (const importPath of importPaths) {
        try {
          const mod = await import(importPath);
          const featureClasses = Object.entries(mod).filter(
            ([, val]) => typeof val === 'function' && /Feature$/.test(val.name || '')
          );
          for (const [, FeatureClass] of featureClasses) {
            try {
              const instance = new FeatureClass();
              const fname = instance.name || FeatureClass.name;
              if (seen.has(fname)) continue;
              if (typeof instance.getFeatureManifest === 'function') {
                const manifest = instance.getFeatureManifest();
                if (manifest?.settings?.properties) {
                  seen.add(fname);
                  features.push({ featureName: fname, manifest });
                }
              }
            } catch {}
          }
        } catch {}
      }

      if (!seen.has('contextGuard')) {
        features.push({ featureName: 'contextGuard', manifest: CONTEXT_GUARD_MANIFEST });
      }

      res.json({ features });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
