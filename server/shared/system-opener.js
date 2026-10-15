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
 * Resolve the platform command that opens a URL in the system default
 * browser. Windows deliberately avoids `cmd /c start`: its shell parsing
 * would reinterpret `&` / `%` meta-characters that OAuth authorize URLs
 * always carry, while rundll32 passes the argument straight to
 * ShellExecute (the default-browser resolver) untouched.
 */
export function resolveUrlOpener(
  url,
  { platform = process.platform, env = process.env } = {},
) {
  if (platform === 'linux' && !hasDesktopSession(env)) {
    return { available: false, reason: 'desktop_unavailable' };
  }

  if (platform === 'win32') {
    return {
      available: true,
      command: 'rundll32',
      args: ['url.dll,FileProtocolHandler', url],
    };
  }

  if (platform === 'darwin') {
    return { available: true, command: 'open', args: [url] };
  }

  return { available: true, command: 'xdg-open', args: [url] };
}

/**
 * Shared spawn/settle plumbing for the openers below. Best-effort by
 * contract: a failed spawn (remote/headless hosts, missing command) resolves
 * to `{ opened: false, reason }` and must never throw or keep the server
 * alive waiting on the child.
 */
function runOpener(opener, spawnImpl) {
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
  return runOpener(resolveDirectoryOpener(dirPath, { platform, env }), spawnImpl);
}

/**
 * Best-effort request to open a URL in the system default browser. Used for
 * OAuth authorize URLs whose loopback callback only completes when opened on
 * the machine running this server (desktop webview hosts cannot pop system
 * browser windows themselves). Same never-throw contract as the directory
 * opener: the caller keeps a manual fallback link.
 */
export function openUrlInSystem(
  url,
  {
    platform = process.platform,
    env = process.env,
    spawnImpl = nodeSpawn,
  } = {},
) {
  return runOpener(resolveUrlOpener(url, { platform, env }), spawnImpl);
}
