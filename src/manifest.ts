/**
 * The patch manifest records which agy version this CLI was last reported to work with.
 * It is published in the repository so the answer can change without a new npm release.
 * The patch itself does not depend on it (see agyPatch.ts); it only drives the version notice.
 */
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { getConfigDir } from './paths';

export interface PatchStrategy {
  agyVersionRange?: string;
  urls: { orig: string; repl: string }[];
  notes?: string;
}

export interface PatchManifest {
  lastUpdated: string;
  latestKnownAgyVersion?: string;
  strategies: PatchStrategy[];
}

/** The repository's default branch is "master". */
export const MANIFEST_URL =
  'https://raw.githubusercontent.com/vahapogut/free-antigravity-cli/master/patch-manifest.json';

/** How long a downloaded manifest is used before asking again. */
const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Starting agy must not wait long for this. */
const FETCH_TIMEOUT_MS = 3000;

export interface ManifestOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function getCachePath(): string {
  return path.join(getConfigDir(), 'patch-manifest.json');
}

function getBundledPath(): string {
  return path.join(__dirname, '..', 'patch-manifest.json');
}

function isManifest(value: unknown): value is PatchManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Record<string, unknown>;
  return (
    typeof manifest.lastUpdated === 'string' &&
    (manifest.latestKnownAgyVersion === undefined || typeof manifest.latestKnownAgyVersion === 'string')
  );
}

async function fetchRemoteManifest(fetchImpl: typeof fetch): Promise<PatchManifest | null> {
  try {
    const res = await fetchImpl(MANIFEST_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return isManifest(data) ? data : null;
  } catch (e) {
    log.debug('[Manifest] Remote fetch failed:', (e as Error).message);
    return null;
  }
}

function loadLocalManifest(filePath: string): PatchManifest | null {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isManifest(data) ? data : null;
  } catch {
    return null;
  }
}

function cacheAge(now: number): number {
  try {
    return now - fs.statSync(getCachePath()).mtimeMs;
  } catch {
    return Infinity;
  }
}

function saveCache(manifest: PatchManifest): void {
  try {
    fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(getCachePath(), JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (e) {
    log.debug('[Manifest] Cache save failed:', (e as Error).message);
  }
}

/**
 * Returns the best available manifest:
 * 1. the cached copy while it is less than a day old,
 * 2. otherwise the one published in the repository (which is then cached),
 * 3. otherwise an older cached copy,
 * 4. otherwise the one shipped with the package.
 */
export async function loadPatchManifest(options: ManifestOptions = {}): Promise<PatchManifest | null> {
  const now = (options.now ?? Date.now)();
  const cached = loadLocalManifest(getCachePath());
  if (cached && cacheAge(now) < CACHE_LIFETIME_MS) return cached;

  const remote = await fetchRemoteManifest(options.fetchImpl ?? fetch);
  if (remote) {
    saveCache(remote);
    log.info('[Manifest] Loaded remote patch manifest.');
    return remote;
  }
  return cached ?? loadLocalManifest(getBundledPath());
}

/** Compares dotted version numbers; a missing part counts as 0. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Tells the user when the installed agy is newer than the last version reported to work.
 * Older and equal versions are known cases and produce no output.
 */
export async function checkAgyCompatibility(currentVersion: string, options: ManifestOptions = {}): Promise<void> {
  const manifest = await loadPatchManifest(options);
  const tested = manifest?.latestKnownAgyVersion;
  if (!tested || compareVersions(currentVersion, tested) <= 0) return;

  console.warn(
    `[Note] agy ${currentVersion} is newer than the last version reported to work with free-antigravity-cli (${tested}). ` +
      `It usually keeps working. If custom models do not appear, please report it at https://github.com/vahapogut/free-antigravity-cli/issues`
  );
}
