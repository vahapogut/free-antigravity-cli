/**
 * Redirecting the agy binary to the local proxy.
 *
 * agy has its Cloud Code endpoint compiled in. The patch replaces that URL with a local one of the
 * same length, so nothing else in the file moves. Exactly one endpoint is redirected: the daily
 * Cloud Code host, or the production host in a build that does not contain the daily one. Every
 * other googleapis.com URL in the binary (sign-in, telemetry, ...) is left alone.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { readAgyVersion } from './agy';

/** The proxy port written into the binary. */
export const PATCH_PORT = 50998;
/** Ports that earlier releases wrote; such a patch is moved to PATCH_PORT. */
const EARLIER_PORTS = [50999];
/** In order of preference; only the first one found is redirected. */
const ENDPOINTS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];

const bytes = (text: string) => Buffer.from(text, 'latin1');
const localPrefix = (port: number) => `http://localhost:${port}/v1internal/x`;

function isPatched(binary: Buffer): boolean {
  return [PATCH_PORT, ...EARLIER_PORTS].some((port) => binary.includes(bytes(localPrefix(port))));
}

/** Replaces every occurrence in place. Both values must have the same length. */
function replaceAll(buffer: Buffer, from: Buffer, to: Buffer): number {
  if (from.length !== to.length) return 0;
  let count = 0;
  for (let offset = buffer.indexOf(from); offset !== -1; offset = buffer.indexOf(from, offset + to.length)) {
    to.copy(buffer, offset);
    count++;
  }
  return count;
}

export interface PatchPlan {
  state: 'patch' | 'already-patched' | 'unsupported';
  /** The bytes to write; present only for state 'patch'. The input buffer is never modified. */
  buffer?: Buffer;
}

export function planAgyPatch(binary: Buffer, port: number = PATCH_PORT): PatchPlan {
  if (binary.includes(bytes(localPrefix(port)))) return { state: 'already-patched' };

  const buffer = Buffer.from(binary);
  for (const earlier of EARLIER_PORTS) {
    if (replaceAll(buffer, bytes(localPrefix(earlier)), bytes(localPrefix(port))) > 0) return { state: 'patch', buffer };
  }
  for (const endpoint of ENDPOINTS) {
    const base = `http://localhost:${port}/v1internal/`;
    if (endpoint.length <= base.length) continue;
    // The path is padded with "x" to the endpoint's length; the proxy strips the padding.
    const replacement = base + 'x'.repeat(endpoint.length - base.length);
    if (replaceAll(buffer, bytes(endpoint), bytes(replacement)) > 0) return { state: 'patch', buffer };
  }
  return { state: 'unsupported' };
}

export function backupFile(filePath: string, version?: string): string {
  if (!fs.existsSync(filePath)) return '';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak-${version || 'unknown'}-${timestamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/** macOS refuses to run a modified binary until it is signed again. */
function signOnMac(binPath: string): void {
  if (os.platform() !== 'darwin') return;
  try {
    execFileSync('codesign', ['--force', '--sign', '-', binPath], { stdio: 'ignore' });
    execFileSync('xattr', ['-d', 'com.apple.quarantine', binPath], { stdio: 'ignore' });
  } catch {
    // Signing tools are unavailable or the attribute is absent; the check below decides.
  }
}

export interface PatchSteps {
  readVersion: (binPath: string) => string | null;
  sign: (binPath: string) => void;
}

export interface PatchResult {
  status: 'patched' | 'already-patched' | 'unsupported' | 'failed';
  message?: string;
  backup?: string;
}

/**
 * Patches agy if it is not patched yet. The original is saved first, and if the patched binary
 * no longer runs the original is put back. Never throws; a problem is returned as a message.
 */
export function ensureAgyPatched(
  binPath: string,
  steps: PatchSteps = { readVersion: readAgyVersion, sign: signOnMac },
): PatchResult {
  let backup = '';
  try {
    const plan = planAgyPatch(fs.readFileSync(binPath));
    if (plan.state === 'already-patched') return { status: 'already-patched' };
    if (plan.state === 'unsupported' || !plan.buffer) {
      return {
        status: 'unsupported',
        message:
          'This agy build does not contain a Cloud Code endpoint that this version can redirect, so it was left unchanged. Custom models will not appear.',
      };
    }

    const version = steps.readVersion(binPath);
    backup = backupFile(binPath, version || undefined);
    fs.writeFileSync(binPath, plan.buffer);
    steps.sign(binPath);

    // A binary that answered before the patch must still answer after it.
    if (version !== null && steps.readVersion(binPath) === null) {
      fs.copyFileSync(backup, binPath);
      return {
        status: 'failed',
        backup,
        message: 'The patched agy did not start, so the original was restored. Custom models will not appear.',
      };
    }
    return { status: 'patched', backup };
  } catch (error) {
    if (backup) {
      try {
        fs.copyFileSync(backup, binPath);
      } catch {
        // The message below names the backup so it can be restored by hand.
      }
    }
    const detail = (error as Error).message;
    return {
      status: 'failed',
      backup: backup || undefined,
      message: backup
        ? `Could not patch agy (${detail}). The original is saved at ${backup}.`
        : `Could not patch agy (${detail}). Close other agy windows and try again.`,
    };
  }
}

export interface RestoreResult {
  status: 'restored' | 'not-patched' | 'no-backup' | 'failed';
  message?: string;
  backup?: string;
}

/** Puts the newest unpatched backup back in place of a patched agy. */
export function restoreAgy(binPath: string): RestoreResult {
  try {
    if (!isPatched(fs.readFileSync(binPath))) return { status: 'not-patched' };

    const directory = path.dirname(binPath);
    const prefix = path.basename(binPath) + '.bak';
    const backups = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(directory, name))
      .map((file) => ({ file, modified: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);

    for (const { file } of backups) {
      const contents = fs.readFileSync(file);
      if (!isPatched(contents) && ENDPOINTS.some((endpoint) => contents.includes(bytes(endpoint)))) {
        fs.copyFileSync(file, binPath);
        return { status: 'restored', backup: file };
      }
    }
    return {
      status: 'no-backup',
      message: 'No unpatched backup was found next to agy. Reinstall the official Antigravity CLI to get the original back.',
    };
  } catch (error) {
    return { status: 'failed', message: `Could not restore agy (${(error as Error).message}). Close other agy windows and try again.` };
  }
}
