import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The user-facing workspace is independent of the (read-only) application tree.
export function resolveDesktopWorkspace({ platform = process.platform, home = os.homedir(), env = process.env, stat = statSync, read = readFileSync, run = spawnSync } = {}) {
  let desktop = '';
  if (platform === 'win32') {
    try {
      const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("DesktopDirectory")'], {
        encoding: 'utf8', windowsHide: true,
      });
      desktop = result.status === 0 ? result.stdout.trim() : '';
    } catch { /* A desktop is not guaranteed in unattended environments. */ }
  } else if (platform === 'linux') {
    const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME : path.join(home, '.config');
    try {
      const config = read(path.join(configHome, 'user-dirs.dirs'), 'utf8');
      const match = config.match(/^XDG_DESKTOP_DIR="([^"]*)"/m);
      if (match) desktop = match[1].replace(/^\$HOME(?=\/|$)/, home);
    } catch { /* Some Linux users have no XDG desktop configuration. */ }
    if (!desktop) desktop = path.join(home, 'Desktop');
  } else if (platform === 'darwin') {
    desktop = path.join(home, 'Desktop');
  }
  if (desktop && path.isAbsolute(desktop)) {
    try {
      if (stat(desktop).isDirectory()) return desktop;
    } catch { /* The desktop folder may have been removed since discovery. */ }
  }
  return home;
}
