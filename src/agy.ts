/**
 * Running the official agy binary.
 */
import { spawn, execFileSync, ChildProcess } from 'child_process';

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

/** The version agy reports, or null when the binary cannot be run. */
export function readAgyVersion(binPath: string, run: typeof execFileSync = execFileSync): string | null {
  try {
    const output = run(binPath, ['--version'], { stdio: 'pipe', timeout: 5000 }).toString().trim();
    const match = output.match(/(\d+\.\d+\.?\d*)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
