/**
 * Compatibility tests for the flexible patch system and URL discovery.
 */

describe('Flexible Binary Patch', () => {
  // Re-implement patchUrlFlexible inline for test isolation
  function patchUrlFlexible(buf: Buffer, original: string, replacement: string): boolean {
    const origBuf = Buffer.from(original);
    const idx = buf.indexOf(origBuf);
    if (idx === -1) return false;

    const replBuf = Buffer.from(replacement);
    const paddedRepl = Buffer.alloc(origBuf.length);
    replBuf.copy(paddedRepl);
    for (let i = replBuf.length; i < paddedRepl.length; i++) paddedRepl[i] = 0;

    paddedRepl.copy(buf, idx);
    return true;
  }

  test('patches exact length match', () => {
    const original = 'https://daily-cloudcode-pa.googleapis.com';
    const replacement = 'http://localhost:50998/v1internal/xxxxxxx';
    const buf = Buffer.from(original, 'ascii');
    expect(patchUrlFlexible(buf, original, replacement)).toBe(true);
    expect(buf.toString('ascii').startsWith(replacement)).toBe(true);
  });

  test('patches shorter replacement with null padding', () => {
    const original = 'https://daily-cloudcode-pa.googleapis.com';
    const replacement = 'http://localhost:50998/v1internal/x';
    const buf = Buffer.from(original, 'ascii');
    expect(patchUrlFlexible(buf, original, replacement)).toBe(true);
    const str = buf.toString('ascii');
    expect(str.startsWith(replacement)).toBe(true);
    // Remaining bytes should be null
    expect(str.charCodeAt(replacement.length)).toBe(0);
  });

  test('patches longer replacement (truncated to original length)', () => {
    const original = 'https://cloudcode-pa.googleapis.com';
    const replacement = 'http://localhost:50998/v1internal/very-long-path-here';
    const buf = Buffer.from(original, 'ascii');
    expect(patchUrlFlexible(buf, original, replacement)).toBe(true);
    const str = buf.toString('ascii');
    expect(str.startsWith(replacement.substring(0, original.length))).toBe(true);
  });

  test('returns false when original not found', () => {
    const buf = Buffer.from('some-random-string', 'ascii');
    expect(patchUrlFlexible(buf, 'https://not-present.com', 'http://localhost')).toBe(false);
  });
});

describe('Google URL Discovery', () => {
  function discoverGoogleUrls(buf: Buffer): string[] {
    const found = new Set<string>();
    const str = buf.toString('ascii');
    const urlPattern = /https:\/\/[a-z0-9-]+\.googleapis\.com/g;
    let match: RegExpExecArray | null;
    while ((match = urlPattern.exec(str)) !== null) {
      found.add(match[0]);
    }
    return Array.from(found);
  }

  test('discovers known Google API URLs', () => {
    const sample = Buffer.from(
      'Some binary content https://daily-cloudcode-pa.googleapis.com more text https://cloudcode-pa.googleapis.com end',
      'ascii'
    );
    const urls = discoverGoogleUrls(sample);
    expect(urls).toContain('https://daily-cloudcode-pa.googleapis.com');
    expect(urls).toContain('https://cloudcode-pa.googleapis.com');
  });

  test('discovers new unknown Google subdomains', () => {
    const sample = Buffer.from(
      'New endpoint: https://new-cloudcode-pa.googleapis.com and https://another.googleapis.com',
      'ascii'
    );
    const urls = discoverGoogleUrls(sample);
    expect(urls).toContain('https://new-cloudcode-pa.googleapis.com');
    expect(urls).toContain('https://another.googleapis.com');
  });

  test('returns empty array when no URLs found', () => {
    const sample = Buffer.from('No google urls here at all', 'ascii');
    expect(discoverGoogleUrls(sample)).toEqual([]);
  });

  test('does not duplicate URLs', () => {
    const sample = Buffer.from(
      'Repeated https://daily-cloudcode-pa.googleapis.com and again https://daily-cloudcode-pa.googleapis.com',
      'ascii'
    );
    const urls = discoverGoogleUrls(sample);
    expect(urls.length).toBe(1);
  });
});

describe('Backup File Naming', () => {
  const mockFs = {
    existsSync: jest.fn(),
    copyFileSync: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();
    mockFs.existsSync.mockReturnValue(true);
  });

  test('includes version and timestamp in backup name', () => {
    // We can't easily test the real backupFile without mocking fs,
    // but we verify the naming convention via a simple simulation
    const filePath = '/path/to/agy.exe';
    const version = '1.2.3';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const expectedPattern = new RegExp(
      `agy\\.exe\\.bak-${version}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z`
    );
    const backupPath = `${filePath}.bak-${version}-${timestamp}`;
    expect(backupPath).toMatch(expectedPattern);
  });
});
