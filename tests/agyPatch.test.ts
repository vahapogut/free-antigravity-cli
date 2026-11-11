/**
 * Patching the agy binary: what is replaced, how a bad patch is undone, and how the original is restored.
 * The "binaries" here are small synthetic buffers and temporary files; agy itself is never run.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planAgyPatch, ensureAgyPatched, restoreAgy, PATCH_PORT } from '../src/agyPatch';

const DAILY = 'https://daily-cloudcode-pa.googleapis.com';
const PROD = 'https://cloudcode-pa.googleapis.com';
const OAUTH = 'https://oauth2.googleapis.com';
const WWW = 'https://www.googleapis.com';
const PATCHED_DAILY = `http://localhost:${PATCH_PORT}/v1internal/xxxxxxx`;
const PATCHED_PROD = `http://localhost:${PATCH_PORT}/v1internal/x`;

/** A fake binary: text separated by NUL bytes, like string data inside an executable. */
function binary(...strings: string[]): Buffer {
  return Buffer.from(['MZ-header', ...strings, 'trailer'].join('\0'), 'latin1');
}
const text = (buffer: Buffer) => buffer.toString('latin1');

describe('patch plan', () => {
  test('redirects the daily Cloud Code host and nothing else', () => {
    const original = binary(DAILY, PROD, OAUTH, WWW);
    const plan = planAgyPatch(original, PATCH_PORT);

    expect(plan.state).toBe('patch');
    const patched = text(plan.buffer!);
    expect(patched).toContain(PATCHED_DAILY);
    expect(patched).not.toContain(DAILY);
    // Same size, and every other endpoint is byte-for-byte untouched.
    expect(plan.buffer!.length).toBe(original.length);
    for (const untouched of [PROD, OAUTH, WWW]) expect(patched).toContain(untouched);
    expect(patched.replace(PATCHED_DAILY, DAILY)).toBe(text(original));
  });

  test('does not change the caller\'s buffer', () => {
    const original = binary(DAILY);
    const copy = Buffer.from(original);
    planAgyPatch(original, PATCH_PORT);
    expect(original.equals(copy)).toBe(true);
  });

  test('replaces every occurrence of the daily host', () => {
    const plan = planAgyPatch(binary(DAILY, 'middle', DAILY), PATCH_PORT);
    expect(text(plan.buffer!).split(PATCHED_DAILY)).toHaveLength(3);
    expect(text(plan.buffer!)).not.toContain(DAILY);
  });

  test('falls back to the production host only when the daily host is absent', () => {
    const plan = planAgyPatch(binary(PROD, OAUTH), PATCH_PORT);
    expect(plan.state).toBe('patch');
    expect(text(plan.buffer!)).toContain(PATCHED_PROD);
    expect(text(plan.buffer!)).not.toContain(PROD);
    expect(text(plan.buffer!)).toContain(OAUTH);
  });

  test('recognises a binary that is already patched', () => {
    const patched = planAgyPatch(binary(DAILY, PROD), PATCH_PORT).buffer!;
    expect(planAgyPatch(patched, PATCH_PORT)).toEqual({ state: 'already-patched' });
  });

  test('moves a patch made for the old port to the current one', () => {
    const old = binary('http://localhost:50999/v1internal/xxxxxxx', PROD);
    const plan = planAgyPatch(old, PATCH_PORT);
    expect(plan.state).toBe('patch');
    expect(text(plan.buffer!)).toContain(PATCHED_DAILY);
    expect(text(plan.buffer!)).not.toContain('localhost:50999');
    expect(plan.buffer!.length).toBe(old.length);
  });

  test('leaves a binary without a known endpoint alone', () => {
    expect(planAgyPatch(binary(OAUTH, WWW, 'https://new-endpoint.googleapis.com'), PATCH_PORT)).toEqual({
      state: 'unsupported',
    });
  });
});

describe('applying and undoing the patch', () => {
  const directories: string[] = [];
  function install(contents: Buffer): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free-agy-bin-'));
    directories.push(directory);
    const file = path.join(directory, 'agy');
    fs.writeFileSync(file, contents);
    return file;
  }
  const backups = (file: string) =>
    fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(path.basename(file) + '.bak-'));

  afterAll(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  test('patches the file and keeps the original as a backup', () => {
    const original = binary(DAILY, PROD);
    const file = install(original);

    const result = ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined });

    expect(result.status).toBe('patched');
    expect(text(fs.readFileSync(file))).toContain(PATCHED_DAILY);
    expect(backups(file)).toHaveLength(1);
    expect(backups(file)[0]).toContain('1.4.12');
    expect(fs.readFileSync(path.join(path.dirname(file), backups(file)[0])).equals(original)).toBe(true);
  });

  test('does nothing to a binary that is already patched', () => {
    const file = install(planAgyPatch(binary(DAILY), PATCH_PORT).buffer!);
    const before = fs.readFileSync(file);

    expect(ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined }).status).toBe('already-patched');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(backups(file)).toHaveLength(0);
  });

  test('puts the original back when the patched binary no longer runs', () => {
    const original = binary(DAILY, PROD);
    const file = install(original);
    // The binary answers before the patch and stops answering after it.
    const readVersion = () => (fs.readFileSync(file).equals(original) ? '1.4.12' : null);

    const result = ensureAgyPatched(file, { readVersion, sign: () => undefined });

    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/restored/i);
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    // The binary is the original again, so a second copy of it would only use disk space.
    expect(backups(file)).toHaveLength(0);
    expect(result.backup).toBeUndefined();
  });

  // agy is about 150 MB and updates itself often; every patch must not leave another copy behind.
  test('keeps only the backup of the build that is installed', () => {
    const file = install(binary(DAILY, PROD));
    fs.writeFileSync(`${file}.bak-1.4.11-2026-10-01T08-00-00-000Z`, binary(DAILY, 'an earlier build'));
    const fromOlderRelease = `${file}.bak`;
    fs.writeFileSync(fromOlderRelease, binary(DAILY, 'saved by a 1.0.x release'));

    const result = ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined });

    expect(result.status).toBe('patched');
    expect(backups(file)).toEqual([path.basename(result.backup!)]);
    expect(backups(file)[0]).toContain('1.4.12');
    // A file this version did not name is not this version's to delete.
    expect(fs.existsSync(fromOlderRelease)).toBe(true);
  });

  test('keeps no backup of a binary that an earlier release had already patched', () => {
    const file = install(binary('http://localhost:50999/v1internal/xxxxxxx', PROD));
    const realOriginal = `${file}.bak-1.0.3-2026-05-30T00-30-00-000Z`;
    fs.writeFileSync(realOriginal, binary(DAILY, PROD));

    const result = ensureAgyPatched(file, { readVersion: () => '1.0.3', sign: () => undefined });

    expect(result.status).toBe('patched');
    expect(text(fs.readFileSync(file))).toContain(PATCHED_DAILY);
    expect(result.backup).toBeUndefined();
    // The copy of the patched file is gone; the real original from before is still there.
    expect(backups(file)).toEqual([path.basename(realOriginal)]);
  });

  // The first start of a rewritten executable is slow: the virus scanner has to read it first.
  test('gives the patched binary longer to answer than a normal start', () => {
    const file = install(binary(DAILY));
    const limits: (number | undefined)[] = [];

    ensureAgyPatched(file, {
      readVersion: (_binPath, timeoutMs) => {
        limits.push(timeoutMs);
        return '1.4.12';
      },
      sign: () => undefined,
    });

    expect(limits).toHaveLength(2);
    expect(limits[0]).toBeUndefined();
    expect(limits[1]).toBeGreaterThanOrEqual(30_000);
  });

  test('reports an unsupported binary and leaves it untouched', () => {
    const original = binary(OAUTH);
    const file = install(original);

    const result = ensureAgyPatched(file, { readVersion: () => '9.9.9', sign: () => undefined });

    expect(result.status).toBe('unsupported');
    expect(result.message).toBeTruthy();
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    expect(backups(file)).toHaveLength(0);
  });

  test('reports a failure it cannot handle instead of hiding it', () => {
    const missing = path.join(os.tmpdir(), 'free-agy-bin-missing', 'agy');
    const result = ensureAgyPatched(missing, { readVersion: () => null, sign: () => undefined });
    expect(result.status).toBe('failed');
    expect(result.message).toBeTruthy();
  });

  test('restore brings back the newest unpatched backup', () => {
    const original = binary(DAILY, PROD);
    const file = install(original);
    ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined });
    // An older backup that is itself patched must never be chosen.
    const patchedBackup = `${file}.bak-1.0.0-2026-01-01T00-00-00-000Z`;
    fs.writeFileSync(patchedBackup, fs.readFileSync(file));
    fs.utimesSync(patchedBackup, new Date(), new Date(Date.now() + 60_000));

    const result = restoreAgy(file);

    expect(result.status).toBe('restored');
    expect(fs.readFileSync(file).equals(original)).toBe(true);
  });

  test('restore reports when the binary is not patched or no clean backup exists', () => {
    const clean = install(binary(DAILY));
    expect(restoreAgy(clean).status).toBe('not-patched');

    const patchedOnly = install(planAgyPatch(binary(DAILY), PATCH_PORT).buffer!);
    const before = fs.readFileSync(patchedOnly);
    const result = restoreAgy(patchedOnly);
    expect(result.status).toBe('no-backup');
    expect(fs.readFileSync(patchedOnly).equals(before)).toBe(true);
  });

  /**
   * Windows refuses to replace an executable for a moment after it has run, and for as long as it
   * is running. Seen with the real agy: the same write succeeded 50 ms later.
   */
  describe('while the binary is in use', () => {
    const realFs = jest.requireActual('fs') as Record<string, (...args: unknown[]) => unknown>;

    /** Makes the next `times` attempts to replace `file` fail the way a file in use does. */
    function refuse(method: 'writeFileSync' | 'copyFileSync', file: string, times: number, code = 'UNKNOWN'): void {
      const real = realFs[method];
      let left = times;
      jest.spyOn(realFs, method).mockImplementation((...args: unknown[]) => {
        const target = method === 'copyFileSync' ? args[1] : args[0];
        if (target === file && left > 0) {
          left--;
          throw Object.assign(new Error(`${code}: the file is in use, ${method} '${file}'`), { code });
        }
        return real.apply(realFs, args);
      });
    }

    function waits() {
      const pauses: number[] = [];
      return { pauses, pause: (ms: number) => void pauses.push(ms), total: () => pauses.reduce((sum, ms) => sum + ms, 0) };
    }

    afterEach(() => jest.restoreAllMocks());

    test('tries the write again instead of giving up', () => {
      const file = install(binary(DAILY, PROD));
      const { pauses, pause } = waits();
      refuse('writeFileSync', file, 2);

      const result = ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined, pause });

      expect(result.status).toBe('patched');
      expect(text(fs.readFileSync(file))).toContain(PATCHED_DAILY);
      expect(pauses).toHaveLength(2);
    });

    test('gives up after about a second and leaves agy and its folder as they were', () => {
      const original = binary(DAILY, PROD);
      const file = install(original);
      const { pauses, pause, total } = waits();
      refuse('writeFileSync', file, Infinity, 'EBUSY');

      const result = ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined, pause });

      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/EBUSY/);
      expect(result.message).toMatch(/unchanged/i);
      expect(fs.readFileSync(file).equals(original)).toBe(true);
      expect(backups(file)).toHaveLength(0);
      expect(pauses.length).toBeGreaterThan(0);
      expect(total()).toBeLessThanOrEqual(2000);
    });

    test('does not wait for an error that waiting cannot fix', () => {
      const original = binary(DAILY, PROD);
      const file = install(original);
      const { pauses, pause } = waits();
      refuse('writeFileSync', file, Infinity, 'EACCES');

      const result = ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined, pause });

      expect(result.status).toBe('failed');
      expect(pauses).toHaveLength(0);
      expect(fs.readFileSync(file).equals(original)).toBe(true);
      expect(backups(file)).toHaveLength(0);
    });

    test('puts the original back even when the first attempt to do so is refused', () => {
      const original = binary(DAILY, PROD);
      const file = install(original);
      const { pauses, pause } = waits();
      // The patched binary was just run to check it, so this is the moment Windows refuses.
      refuse('copyFileSync', file, 1);
      const readVersion = () => (fs.readFileSync(file).equals(original) ? '1.4.12' : null);

      const result = ensureAgyPatched(file, { readVersion, sign: () => undefined, pause });

      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/restored/i);
      expect(fs.readFileSync(file).equals(original)).toBe(true);
      expect(backups(file)).toHaveLength(0);
      expect(pauses).toHaveLength(1);
    });

    test('keeps the backup and names it when the original cannot be put back', () => {
      const original = binary(DAILY, PROD);
      const file = install(original);
      const { pause } = waits();
      refuse('copyFileSync', file, Infinity, 'EBUSY');
      const readVersion = () => (fs.readFileSync(file).equals(original) ? '1.4.12' : null);

      const result = ensureAgyPatched(file, { readVersion, sign: () => undefined, pause });

      expect(result.status).toBe('failed');
      expect(backups(file)).toHaveLength(1);
      expect(result.backup).toBe(path.join(path.dirname(file), backups(file)[0]));
      expect(result.message).toContain(result.backup!);
      expect(result.message).toMatch(/antigravity restore/);
      expect(fs.readFileSync(result.backup!).equals(original)).toBe(true);

      // Once the file is free again, the restore command finishes the job.
      jest.restoreAllMocks();
      expect(restoreAgy(file).status).toBe('restored');
      expect(fs.readFileSync(file).equals(original)).toBe(true);
    });

    test('leaves no half-written backup behind when the disk is full', () => {
      const original = binary(DAILY, PROD);
      const file = install(original);
      const real = realFs.copyFileSync;
      jest.spyOn(realFs, 'copyFileSync').mockImplementation((...args: unknown[]) => {
        if (args[0] !== file) return real.apply(realFs, args);
        (realFs.writeFileSync as (...a: unknown[]) => unknown)(args[1], 'half');
        throw Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC' });
      });

      const result = ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined });

      expect(result.status).toBe('failed');
      expect(result.message).toMatch(/ENOSPC/);
      expect(fs.readFileSync(file).equals(original)).toBe(true);
      expect(backups(file)).toHaveLength(0);
    });

    test('restore waits for the file too', () => {
      const original = binary(DAILY, PROD);
      const file = install(original);
      ensureAgyPatched(file, { readVersion: () => '1.4.12', sign: () => undefined });
      const { pauses, pause } = waits();
      refuse('copyFileSync', file, 1);

      const result = restoreAgy(file, pause);

      expect(result.status).toBe('restored');
      expect(fs.readFileSync(file).equals(original)).toBe(true);
      expect(pauses).toHaveLength(1);
    });
  });
});
