import path from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

import { USER_DATA_ROOT } from '../shared/constants.js';

const SYSTEM_FEATURE_CONFIG_PATH = path.join(USER_DATA_ROOT, 'feature-setup.json');

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

function readSystemFeatureConfigFile() {
  try {
    if (!existsSync(SYSTEM_FEATURE_CONFIG_PATH)) return {};
    const raw = readFileSync(SYSTEM_FEATURE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeSystemFeatureConfigFile(config) {
  const dir = path.dirname(SYSTEM_FEATURE_CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(SYSTEM_FEATURE_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
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

  app.get('/protoclaw/system_feature_manifests', async (_req, res) => {
    try {
      const seen = new Set();
      const features = [];

      const importPaths = ['agentdev'];
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

      res.json({ features });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
