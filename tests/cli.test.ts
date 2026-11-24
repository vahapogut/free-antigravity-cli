/**
 * What the wrapper prints itself when it hands over to agy.
 * agy has machine-readable modes (--output-format json, stream-json, the acp stdio server), so
 * stdout must carry agy's output and nothing else. agy, the proxy and the patch are replaced here.
 */
const mockLaunched: string[][] = [];
const mockTouched: string[] = [];

jest.mock('../src/proxy', () => ({
  startProxy: jest.fn(async () => 50998),
  stopProxy: jest.fn(async () => undefined),
  getProxyPort: () => 50998,
}));
jest.mock('../src/agy', () => ({
  locateAgy: jest.requireActual('../src/agy').locateAgy,
  readAgyVersion: () => '1.5.6',
  launchAgy: (_binPath: string, args: string[]) => {
    mockLaunched.push(args);
    return { on: () => undefined, kill: () => true };
  },
}));
jest.mock('../src/agyPatch', () => ({
  ensureAgyPatched: (binPath: string) => {
    mockTouched.push(`patch ${binPath}`);
    return { status: 'patched', backup: 'agy.bak-1.5.6-2026-11-12T00-00-00-000Z' };
  },
  restoreAgy: (binPath: string) => {
    mockTouched.push(`restore ${binPath}`);
    return { status: 'not-patched' };
  },
}));
jest.mock('../src/manifest', () => ({ checkAgyCompatibility: async () => undefined }));

async function waitFor(condition: () => boolean, limitMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > limitMs) throw new Error('timed out waiting for the wrapper to start agy');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('handing over to agy', () => {
  const previousArgv = process.argv;
  const previousBin = process.env.AGY_BIN;
  let interruptListeners: unknown[] = [];

  beforeEach(() => {
    mockLaunched.length = 0;
    mockTouched.length = 0;
    interruptListeners = process.listeners('SIGINT');
  });

  afterEach(() => {
    process.exitCode = undefined;
    process.argv = previousArgv;
    if (previousBin === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = previousBin;
    for (const listener of process.listeners('SIGINT')) {
      if (!interruptListeners.includes(listener)) process.removeListener('SIGINT', listener);
    }
    jest.restoreAllMocks();
  });

  test('prints its own status on stderr and leaves stdout to agy', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    jest.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void stdout.push(args.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void stderr.push(args.join(' ')));
    // Any existing file will do: agy itself is replaced by the mocks above.
    process.env.AGY_BIN = process.execPath;
    process.argv = ['node', 'cli.js', '-p', 'hello', '--output-format', 'json'];

    jest.isolateModules(() => {
      require('../src/cli');
    });
    await waitFor(() => mockLaunched.length > 0);

    expect(mockLaunched).toEqual([['-p', 'hello', '--output-format', 'json']]);
    expect(stdout.join('')).toBe('');
    // The status lines are still there for a person to read.
    expect(stderr.join('\n')).toMatch(/patched/);
    expect(stderr.join('\n')).toMatch(/proxy.*50998/i);
  });

  // A typo in AGY_BIN must not make the wrapper patch, restore or start a different agy.
  test.each([
    ['starting agy', ['-p', 'hello']],
    ['restore', ['restore']],
  ])('stops before %s when AGY_BIN names a missing file', async (_name, args) => {
    const stderr: string[] = [];
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => void stderr.push(parts.join(' ')));
    const missing = process.execPath + '.does-not-exist';
    process.env.AGY_BIN = missing;
    process.argv = ['node', 'cli.js', ...args];

    jest.isolateModules(() => {
      require('../src/cli');
    });
    await waitFor(() => stderr.length > 0 || process.exitCode !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockTouched).toEqual([]);
    expect(mockLaunched).toEqual([]);
    expect(stderr.join('\n')).toContain('AGY_BIN');
    expect(stderr.join('\n')).toContain(missing);
    expect(process.exitCode).toBe(1);
  });

  test('configure names the problem instead of another agy', async () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => void lines.push(parts.join(' ')));
    jest.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => void lines.push(parts.join(' ')));
    const missing = process.execPath + '.does-not-exist';
    process.env.AGY_BIN = missing;
    process.argv = ['node', 'cli.js', 'configure'];

    jest.isolateModules(() => {
      require('../src/cli');
    });
    await waitFor(() => lines.some((line) => line.startsWith('agy binary')));

    const line = lines.find((entry) => entry.startsWith('agy binary'))!;
    expect(line).toContain('AGY_BIN');
    expect(line).toContain(missing);
  });

  test('an explicitly pinned session does not start agy if its proxy could not start', async () => {
    const prev = process.env.ANTIGRAVITY_AGENT_PINS;
    try {
      process.env.ANTIGRAVITY_AGENT_PINS = 'worker-pins.json';
      process.env.AGY_BIN = process.execPath;
      process.argv = ['node', 'cli.js', '-p', 'test'];
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      jest.isolateModules(() => {
        require('../src/proxy').startProxy.mockRejectedValueOnce(new Error('proxy port busy'));
        require('../src/cli');
      });
      await waitFor(() => process.exitCode !== undefined || mockLaunched.length > 0);
      expect(process.exitCode).toBe(1);
      expect(mockLaunched).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.ANTIGRAVITY_AGENT_PINS;
      else process.env.ANTIGRAVITY_AGENT_PINS = prev;
    }
  });
});
