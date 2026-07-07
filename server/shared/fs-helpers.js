import { promises as fs } from 'fs';

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function readJsonSafe(filePath, fallback = null) {
  try {
    return await readJson(filePath);
  } catch {
    return fallback;
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Resolve the actual filesystem casing of a directory path.
 *
 * On Windows the directory picker may return a lowercased path (e.g.
 * "d:\\code\\test" instead of "D:\\code\\Test").  `fs.realpath` queries
 * the OS for the real on-disk casing so that stored paths match what
 * the user sees in Explorer.
 *
 * Returns the original `dirPath` unchanged when:
 *  - `dirPath` is empty
 *  - the platform is not Windows (case-sensitive filesystems)
 *  - `fs.realpath` fails (directory doesn't exist, permission denied, …)
 */
export async function normalizePathCasing(dirPath) {
  if (!dirPath || process.platform !== 'win32') return dirPath;
  try {
    return (await fs.realpath(dirPath)).replace(/^\\\\\?\\/, '');
  } catch {
    return dirPath;
  }
}
