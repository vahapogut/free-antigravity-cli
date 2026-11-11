/**
 * The patch manifest: where it is fetched from, how it is cached, and when the version notice appears.
 * The network is replaced by a fake fetch; the cache lives in the temporary configuration directory.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadPatchManifest, checkAgyCompatibility, MANIFEST_URL, PatchManifest } from '../src/manifest';

const cacheFile = () => path.join(process.env.FREE_ANTIGRAVITY_HOME!, 'patch-manifest.json');
const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'patch-manifest.json'), 'utf-8')) as PatchManifest;
const remote: PatchManifest = { lastUpdated: '2099-01-01T00:00:00Z', latestKnownAgyVersion: '9.9.9', strategies: [] };

function fakeFetch(reply: () => Promise<unknown>) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const body = await reply();
    return { ok: true, json: async () => body };
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

beforeEach(() => {
  fs.rmSync(cacheFile(), { force: true });
});

describe('loading the manifest', () => {
  test('asks the default branch of this repository', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    const repository = String(pkg.repository.url).replace(/^git\+/, '').replace(/\.git$/, '').replace('https://github.com/', '');
    const { urls, fetchImpl } = fakeFetch(async () => remote);

    await loadPatchManifest({ fetchImpl });

    expect(MANIFEST_URL).toBe(`https://raw.githubusercontent.com/${repository}/master/patch-manifest.json`);
    expect(urls).toEqual([MANIFEST_URL]);
  });

  test('uses the remote manifest and does not ask again while the copy is fresh', async () => {
    const { urls, fetchImpl } = fakeFetch(async () => remote);

    expect(await loadPatchManifest({ fetchImpl })).toEqual(remote);
    expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf-8'))).toEqual(remote);
    expect(await loadPatchManifest({ fetchImpl })).toEqual(remote);
    expect(urls).toHaveLength(1);
  });

  test('asks again once the cached copy is a day old', async () => {
    const { urls, fetchImpl } = fakeFetch(async () => remote);
    await loadPatchManifest({ fetchImpl });
    const twoDaysLater = Date.now() + 2 * 24 * 60 * 60 * 1000;

    await loadPatchManifest({ fetchImpl, now: () => twoDaysLater });

    expect(urls).toHaveLength(2);
  });

  test('falls back to the bundled manifest when the network fails', async () => {
    const { fetchImpl } = fakeFetch(async () => {
      throw new Error('offline');
    });
    expect(await loadPatchManifest({ fetchImpl })).toEqual(bundled);
  });

  test.each([[{}], ['<html>not json</html>'], [{ lastUpdated: 5 }], [null]])(
    'ignores a remote reply that is not a manifest (%j)',
    async (reply) => {
      const { fetchImpl } = fakeFetch(async () => reply);
      expect(await loadPatchManifest({ fetchImpl })).toEqual(bundled);
      expect(fs.existsSync(cacheFile())).toBe(false);
    },
  );
});

describe('bundled manifest', () => {
  test('names an agy version that has actually been reported working', () => {
    expect(bundled.latestKnownAgyVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bundled.latestKnownAgyVersion).not.toBe('1.0.0');
    expect(Date.parse(bundled.lastUpdated)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
  });
});

describe('version notice', () => {
  const manifest: PatchManifest = { lastUpdated: '2026-11-11T00:00:00Z', latestKnownAgyVersion: '1.4.12', strategies: [] };

  async function noticesFor(version: string): Promise<string[]> {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
    try {
      fs.rmSync(cacheFile(), { force: true });
      await checkAgyCompatibility(version, fakeFetch(async () => manifest));
    } finally {
      spy.mockRestore();
    }
    return lines;
  }

  test.each(['1.4.12', '1.4.2', '1.3.4', '1.0.0', '0.9.99'])('says nothing for agy %s, which is not newer than the tested one', async (version) => {
    expect(await noticesFor(version)).toEqual([]);
  });

  test.each(['1.4.13', '1.5.0', '1.10.0', '2.0.0'])('mentions that agy %s is newer than the tested one', async (version) => {
    const lines = await noticesFor(version);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(version);
    expect(lines[0]).toContain('1.4.12');
  });
});
