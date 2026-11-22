/**
 * Finding and running the official agy binary.
 */
import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface AgyLookup {
  env?: NodeJS.ProcessEnv;
  exists?: (file: string) => boolean;
  /** The agy found on PATH, or null. */
  searchPath?: () => string | null;
  platform?: NodeJS.Platform;
  home?: string;
}

export type AgyLocation = { path: string } | { error: string };

function searchPath(platform: NodeJS.Platform): string | null {
  try {
    const output = execFileSync(platform === 'win32' ? 'where' : 'which', ['agy'], { stdio: 'pipe' }).toString();
    const first = output.split(/\r?\n/)[0].trim();
    return first && fs.existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * The agy binary to patch and start. AGY_BIN is the user's explicit choice, so when it names a
 * file that does not exist the answer is an error, never another agy found elsewhere: the wrapper
 * would otherwise patch and run a binary the user did not pick. Without AGY_BIN: PATH, then the
 * usual install locations, then the default location (which may not exist yet).
 */
export function locateAgy(lookup: AgyLookup = {}): AgyLocation {
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? fs.existsSync;
  const platform = lookup.platform ?? process.platform;
  const home = lookup.home ?? os.homedir();

  const chosen = env.AGY_BIN;
  if (chosen) {
    if (exists(chosen)) return { path: chosen };
    return { error: `AGY_BIN is set to "${chosen}", but that file does not exist. Correct AGY_BIN or unset it to use the agy on PATH.` };
  }

  const onPath = (lookup.searchPath ?? (() => searchPath(platform)))();
  if (onPath) return { path: onPath };

  const binName = platform === 'win32' ? 'agy.exe' : 'agy';
  const locations = [
    path.join(home, 'AppData', 'Local', 'agy', 'bin', binName),
    path.join(home, 'Library', 'Application Support', 'agy', 'bin', binName),
    path.join(home, '.local', 'share', 'agy', 'bin', binName),
    path.join(home, '.local', 'bin', binName),
  ];
  const found = locations.find((location) => exists(location));
  if (found) return { path: found };
  return { path: platform === 'win32' ? locations[0] : locations[2] };
}

/**
 * Starts agy with the user's arguments exactly as given: an argument array and no shell, so spaces
 * and shell metacharacters reach agy unchanged.
 */
export function launchAgy(
  binPath: string,
  args: string[],
  spawnImpl: typeof spawn = spawn,
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(binPath)) {
    throw new Error(`"${binPath}" is a batch file. Set AGY_BIN to the agy executable itself (agy.exe).`);
  }
  return spawnImpl(binPath, args, { stdio: 'inherit' });
}

/** The version agy reports, or null when the binary cannot be run or does not answer in time. */
export function readAgyVersion(
  binPath: string,
  run: typeof execFileSync = execFileSync,
  timeoutMs = 5000,
): string | null {
  try {
    const output = run(binPath, ['--version'], { stdio: 'pipe', timeout: timeoutMs }).toString().trim();
    const match = output.match(/(\d+\.\d+\.?\d*)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
