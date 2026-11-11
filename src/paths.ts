/**
 * Where the CLI keeps its own files.
 * FREE_ANTIGRAVITY_HOME overrides the default location (~/.free-antigravity); tests use it so that
 * they never touch a real configuration.
 */
import * as os from 'os';
import * as path from 'path';

export function getConfigDir(): string {
  const override = process.env.FREE_ANTIGRAVITY_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.free-antigravity');
}

export function getModelsPath(): string {
  return path.join(getConfigDir(), 'models.json');
}
