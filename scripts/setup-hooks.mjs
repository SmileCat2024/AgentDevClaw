/**
 * Configure git to use the project's .githooks directory.
 * Runs automatically via `npm prepare` (triggered by npm install).
 * Silently skips if not in a git repo.
 */
import { execSync } from 'child_process';

try {
  execSync('git rev-parse --git-dir', { stdio: 'ignore' });
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' });
  console.log('[hooks] core.hooksPath set to .githooks');
} catch {
  // Not a git repo or git not available — skip silently.
}
