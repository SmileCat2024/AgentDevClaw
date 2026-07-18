import { spawn as nodeSpawn } from 'child_process';

function hasDesktopSession(env) {
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY || env.MIR_SOCKET);
}

export function resolveDirectoryOpener(
  dirPath,
  { platform = process.platform, env = process.env } = {},
) {
  if (platform === 'linux' && !hasDesktopSession(env)) {
    return { available: false, reason: 'desktop_unavailable' };
  }

  if (platform === 'win32') {
    return {
      available: true,
      command: env.ComSpec || 'cmd.exe',
      args: ['/c', 'start', '""', dirPath],
    };
  }

  if (platform === 'darwin') {
    return { available: true, command: 'open', args: [dirPath] };
  }

  return { available: true, command: 'xdg-open', args: [dirPath] };
}

function openerFailure(error) {
  return {
    opened: false,
    reason: error?.code === 'ENOENT' ? 'opener_not_found' : 'opener_failed',
  };
}

/**
 * Best-effort request to reveal a directory in the host desktop environment.
 * This operation must never bring down the web server: remote/headless hosts
 * commonly have neither a desktop session nor xdg-open installed.
 */
export function openDirectoryInSystem(
  dirPath,
  {
    platform = process.platform,
    env = process.env,
    spawnImpl = nodeSpawn,
  } = {},
) {
  const opener = resolveDirectoryOpener(dirPath, { platform, env });
  if (!opener.available) {
    return Promise.resolve({ opened: false, reason: opener.reason });
  }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(opener.command, opener.args, {
        stdio: 'ignore',
        detached: true,
      });
    } catch (error) {
      resolve(openerFailure(error));
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // A failed spawn emits asynchronously, so the route's try/catch cannot
    // catch it. Keep this listener attached even after the spawn event.
    child.once('error', (error) => finish(openerFailure(error)));
    child.once('spawn', () => {
      try {
        child.unref();
        finish({ opened: true });
      } catch (error) {
        finish(openerFailure(error));
      }
    });
  });
}
