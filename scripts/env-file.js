import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claw user data root shared by the server and desktop launchers. */
export function resolveClawDataRoot(env = process.env) {
  const override = String(env.AGENTDEV_DATA_DIR || '').trim();
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), '.agentdev', 'AgentDevClaw');
}

/** Explicit CLAW_ENV_FILE wins; otherwise use the user data root .env. */
export function resolveClawEnvFile(env = process.env) {
  const explicit = String(env.CLAW_ENV_FILE || '').trim();
  const candidates = [
    ...(explicit ? [path.resolve(explicit)] : []),
    path.join(resolveClawDataRoot(env), '.env'),
  ];
  return [...new Set(candidates)].find((candidate) => existsSync(candidate)) || null;
}

/** Parse the desktop-shell .env subset: KEY=VALUE, optional export and quotes. */
export function parseClawEnvFile(text) {
  const pairs = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z0-9_]+$/.test(key)) continue;
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    pairs.push([key, value]);
  }
  return pairs;
}

/** Merge file values only when the real process environment has no value. */
export function loadClawEnv(baseEnv = process.env, { logger = console } = {}) {
  const env = { ...baseEnv };
  const envFile = resolveClawEnvFile(env);
  if (!envFile) return env;
  try {
    const pairs = parseClawEnvFile(readFileSync(envFile, 'utf8'));
    for (const [key, value] of pairs) {
      if (env[key] === undefined) env[key] = value;
    }
    if (pairs.length) logger.log?.(`[claw-env] loaded configuration from ${envFile}`);
  } catch (error) {
    logger.warn?.(`[claw-env] failed to read ${envFile}: ${error.message}`);
  }
  return env;
}
