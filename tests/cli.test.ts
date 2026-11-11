/**
 * What the wrapper prints itself when it hands over to agy.
 * agy has machine-readable modes (--output-format json, stream-json, the acp stdio server), so
 * stdout must carry agy's output and nothing else. agy, the proxy and the patch are replaced here.
 */
const mockLaunched: string[][] = [];

jest.mock('../src/proxy', () => ({
  startProxy: jest.fn(async () => 50998),
  stopProxy: jest.fn(async () => undefined),
  getProxyPort: () => 50998,
}));
jest.mock('../src/agy', () => ({
  readAgyVersion: () => '1.5.6',
  launchAgy: (_binPath: string, args: string[]) => {
    mockLaunched.push(args);
    return { on: () => undefined, kill: () => true };
  },
}));
jest.mock('../src/agyPatch', () => ({
  ensureAgyPatched: () => ({ status: 'patched', backup: 'agy.bak-1.5.6-2026-11-12T00-00-00-000Z' }),
  restoreAgy: () => ({ status: 'not-patched' }),
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
    interruptListeners = process.listeners('SIGINT');
  });

  afterEach(() => {
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
});
