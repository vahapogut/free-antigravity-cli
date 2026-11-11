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

/**
 * How long the patched binary may take to answer. Its first start is slow because the virus
 * scanner reads the rewritten file first: measured at up to 3 s for the 150 MB agy on a fast disk.
 */
const PATCHED_START_TIMEOUT_MS = 30_000;

/** A refused write is tried again this often, this far apart: a little over a second in total. */
const OVERWRITE_ATTEMPTS = 10;
const OVERWRITE_PAUSE_MS = 150;
/**
 * "In use": Windows reports a running executable as EBUSY and one that has only just exited as an
 * error Node has no name for; Linux reports a running one as ETXTBSY.
 */
const IN_USE = new Set(['EBUSY', 'ETXTBSY', 'UNKNOWN']);

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

type Pause = (ms: number) => void;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replaces the executable. Windows refuses for a moment after the program has run (seen with the
 * real agy: refused, then accepted 50 ms later), so a refusal is not final until it has lasted.
 */
function overwrite(action: () => void, pause: Pause): void {
  for (let attempt = 1; ; attempt++) {
    try {
      action();
      return;
    } catch (error) {
      if (attempt >= OVERWRITE_ATTEMPTS || !IN_USE.has((error as NodeJS.ErrnoException).code || '')) throw error;
      pause(OVERWRITE_PAUSE_MS);
    }
  }
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // A leftover copy costs disk space and nothing else.
  }
}

/** The end of a backup name written by backupFile. */
const BACKUP_TIMESTAMP = /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function backupFile(filePath: string, version?: string): string {
  if (!fs.existsSync(filePath)) return '';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak-${version || 'unknown'}-${timestamp}`;
  try {
    fs.copyFileSync(filePath, backupPath);
  } catch (error) {
    removeFile(backupPath);
    throw error;
  }
  return backupPath;
}

/**
 * Removes the backups this CLI made of builds that are no longer installed. agy is about 150 MB
 * and updates itself often, so one copy per update would add up. Files with any other name,
 * such as the "agy.bak" of a 1.0.x release, are not touched.
 */
function removeOlderBackups(binPath: string, keep: string): void {
  try {
    const directory = path.dirname(binPath);
    const prefix = path.basename(binPath) + '.bak-';
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(prefix) && BACKUP_TIMESTAMP.test(name) && name !== path.basename(keep)) {
        removeFile(path.join(directory, name));
      }
    }
  } catch {
    // Tidying up is not worth failing a patch that worked.
  }
}

/**
 * Makes the binary the original again and removes the backup, which is then only a second copy.
 * Returns false when the original could not be put back; the backup is kept in that case.
 */
function putBack(binPath: string, backup: string, original: Buffer, pause: Pause): boolean {
  try {
    if (!fs.readFileSync(binPath).equals(original)) overwrite(() => fs.copyFileSync(backup, binPath), pause);
    removeFile(backup);
    return true;
  } catch {
    return false;
  }
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
  /** `timeoutMs` is passed for the check after patching, which needs longer than a normal start. */
  readVersion: (binPath: string, timeoutMs?: number) => string | null;
  sign: (binPath: string) => void;
  /** Waits between attempts to replace a file that is in use. */
  pause?: Pause;
}

export interface PatchResult {
  status: 'patched' | 'already-patched' | 'unsupported' | 'failed';
  message?: string;
  /** The saved original: after a patch, or after a failure that could not be undone. */
  backup?: string;
}

const defaultSteps: PatchSteps = {
  readVersion: (binPath, timeoutMs) => readAgyVersion(binPath, execFileSync, timeoutMs),
  sign: signOnMac,
};

/**
 * Patches agy if it is not patched yet. The original is saved first, and if the patched binary
 * no longer runs the original is put back. Never throws; a problem is returned as a message.
 */
export function ensureAgyPatched(binPath: string, steps: PatchSteps = defaultSteps): PatchResult {
  const pause = steps.pause ?? sleep;
  let original: Buffer | undefined;
  let backup = '';
  try {
    original = fs.readFileSync(binPath);
    const plan = planAgyPatch(original);
    if (plan.state === 'already-patched') return { status: 'already-patched' };
    if (plan.state === 'unsupported' || !plan.buffer) {
      return {
        status: 'unsupported',
        message:
          'This agy build does not contain a Cloud Code endpoint that this version can redirect, so it was left unchanged. Custom models will not appear.',
      };
    }

    const patched = plan.buffer;
    const version = steps.readVersion(binPath);
    backup = backupFile(binPath, version || undefined);
    overwrite(() => fs.writeFileSync(binPath, patched), pause);
    steps.sign(binPath);

    // A binary that answered before the patch must still answer after it.
    if (version !== null && steps.readVersion(binPath, PATCHED_START_TIMEOUT_MS) === null) {
      if (putBack(binPath, backup, original, pause)) {
        return {
          status: 'failed',
          message: 'The patched agy did not start, so the original was restored. Custom models will not appear.',
        };
      }
      return {
        status: 'failed',
        backup,
        message: `The patched agy did not start and the original could not be put back. It is saved at ${backup}. Close other agy windows and run "antigravity restore".`,
      };
    }

    // A binary that an earlier release had patched is not an original, so its copy is not kept.
    if (isPatched(original)) {
      removeFile(backup);
      return { status: 'patched' };
    }
    removeOlderBackups(binPath, backup);
    return { status: 'patched', backup };
  } catch (error) {
    const detail = (error as Error).message;
    if (!original || !backup) {
      return { status: 'failed', message: `Could not patch agy (${detail}). Close other agy windows and try again.` };
    }
    if (putBack(binPath, backup, original, pause)) {
      return {
        status: 'failed',
        message: `Could not patch agy (${detail}). agy was left unchanged. Close other agy windows and try again.`,
      };
    }
    return {
      status: 'failed',
      backup,
      message: `Could not patch agy (${detail}). The original is saved at ${backup}. Close other agy windows and run "antigravity restore".`,
    };
  }
}

export interface RestoreResult {
  status: 'restored' | 'not-patched' | 'no-backup' | 'failed';
  message?: string;
  backup?: string;
}

/** Puts the newest unpatched backup back in place of a patched agy. */
export function restoreAgy(binPath: string, pause: Pause = sleep): RestoreResult {
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
        overwrite(() => fs.copyFileSync(file, binPath), pause);
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
