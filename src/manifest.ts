/**
 * Remote and local patch manifest loader.
 * Fetches known patch strategies from GitHub (or local cache) so the CLI
 * can stay up-to-date without a new npm release every time agy changes.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';

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

const MANIFEST_URL =
  'https://raw.githubusercontent.com/vahapogut/free-antigravity-cli/main/patch-manifest.json';

function getCachePath(): string {
  return path.join(os.homedir(), '.free-antigravity', 'patch-manifest.json');
}

function getBundledPath(): string {
  return path.join(__dirname, '..', 'patch-manifest.json');
}

function isOnline(): boolean {
  // Simple heuristic: if we can resolve the URL hostname
  try {
    const { hostname } = new URL(MANIFEST_URL);
    require('dns').lookupSync(hostname);
    return true;
  } catch {
    return false;
  }
}

async function fetchRemoteManifest(): Promise<PatchManifest | null> {
  try {
    const res = await fetch(MANIFEST_URL, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as PatchManifest;
    return data;
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      log.debug('[Manifest] Remote fetch failed:', e);
    }
    return null;
  }
}

function loadLocalManifest(filePath: string): PatchManifest | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as PatchManifest;
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      log.debug('[Manifest] Local load failed:', e);
    }
    return null;
  }
}

function saveCache(manifest: PatchManifest): void {
  try {
    const cachePath = getCachePath();
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2), 'utf-8');
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      log.debug('[Manifest] Cache save failed:', e);
    }
  }
}

/**
 * Load the best available patch manifest:
 * 1. Try remote (GitHub raw) if online
 * 2. Fall back to local cache
 * 3. Fall back to bundled manifest in package
 */
export async function loadPatchManifest(): Promise<PatchManifest | null> {
  let manifest: PatchManifest | null = null;

  if (isOnline()) {
    manifest = await fetchRemoteManifest();
    if (manifest) {
      saveCache(manifest);
      log.info('[Manifest] Loaded remote patch manifest.');
      return manifest;
    }
  }

  // Try user cache
  manifest = loadLocalManifest(getCachePath());
  if (manifest) {
    log.info('[Manifest] Loaded cached patch manifest.');
    return manifest;
  }

  // Try bundled fallback (shipped with npm package)
  manifest = loadLocalManifest(getBundledPath());
  if (manifest) {
    log.info('[Manifest] Loaded bundled patch manifest.');
    return manifest;
  }

  log.warn('[Manifest] No patch manifest found. Using built-in defaults.');
  return null;
}

/**
 * Check whether the currently installed agy version is known/tested.
 * Warns the user if it is newer than the latest known version.
 */
export async function checkAgyCompatibility(currentVersion: string): Promise<void> {
  const manifest = await loadPatchManifest();
  if (!manifest || !manifest.latestKnownAgyVersion) return;

  if (currentVersion !== manifest.latestKnownAgyVersion) {
    console.warn(
      `[Warn] agy ${currentVersion} has not been tested with free-antigravity-cli. ` +
        `Latest tested: ${manifest.latestKnownAgyVersion}. ` +
        `If you encounter issues, please report at https://github.com/vahapogut/free-antigravity-cli/issues`
    );
  }
}
