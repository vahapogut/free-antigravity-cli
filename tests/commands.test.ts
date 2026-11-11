/**
 * Which invocations the wrapper handles itself, which it hands to agy, and how agy is started.
 */
import { routeCommand } from '../src/commands';
import { launchAgy, readAgyVersion } from '../src/agy';

describe('command routing', () => {
  test.each([
    [['models', 'list'], { kind: 'models', sub: 'list', rest: [] }],
    [['models', 'add'], { kind: 'models', sub: 'add', rest: [] }],
    [['models', 'remove', 'models/x'], { kind: 'models', sub: 'remove', rest: ['models/x'] }],
    [['models', 'import'], { kind: 'models', sub: 'import', rest: [] }],
    [['custom-models', 'list'], { kind: 'models', sub: 'list', rest: [] }],
    [['custom-models', 'remove', 'models/x'], { kind: 'models', sub: 'remove', rest: ['models/x'] }],
  ])('%j manages the custom models', (args, expected) => {
    expect(routeCommand(args)).toEqual(expected);
  });

  test.each([[['models']], [['models', '--json']], [['models', 'show', 'gemini']]])(
    '%j reaches the official agy models command',
    (args) => {
      expect(routeCommand(args)).toEqual({ kind: 'agy', args });
    },
  );

  test('custom-models without a known subcommand shows its usage instead of starting agy', () => {
    expect(routeCommand(['custom-models'])).toEqual({ kind: 'models-usage' });
    expect(routeCommand(['custom-models', 'nonsense'])).toEqual({ kind: 'models-usage' });
  });

  test('everything after -- goes to agy untouched', () => {
    expect(routeCommand(['--', 'models', 'list'])).toEqual({ kind: 'agy', args: ['models', 'list'] });
    expect(routeCommand(['--', '--help'])).toEqual({ kind: 'agy', args: ['--help'] });
  });

  test.each([
    [['configure'], 'configure'],
    [['restore'], 'restore'],
    [['version'], 'version'],
    [['--version'], 'version'],
    [['-V'], 'version'],
    [['help'], 'help'],
    [['--help'], 'help'],
    [['-h'], 'help'],
  ])('%j is answered by the wrapper', (args, kind) => {
    expect(routeCommand(args)).toEqual({ kind });
  });

  test('chat and unknown arguments start agy', () => {
    expect(routeCommand([])).toEqual({ kind: 'agy', args: [] });
    expect(routeCommand(['chat'])).toEqual({ kind: 'agy', args: [] });
    expect(routeCommand(['chat', '-p', 'hello there'])).toEqual({ kind: 'agy', args: ['-p', 'hello there'] });
    expect(routeCommand(['-p', 'hello there'])).toEqual({ kind: 'agy', args: ['-p', 'hello there'] });
  });
});

describe('starting agy', () => {
  function recorder() {
    const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
    const spawnFake = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return { on: () => undefined, kill: () => true };
    }) as unknown as Parameters<typeof launchAgy>[2];
    return { calls, spawnFake };
  }

  test('hands the arguments over as they are, without a shell', () => {
    const { calls, spawnFake } = recorder();
    const args = ['-p', 'multi word prompt; echo $(id) & "quoted" | more'];

    launchAgy('/opt/agy/bin/agy', args, spawnFake, 'linux');

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/opt/agy/bin/agy');
    expect(calls[0].args).toEqual(args);
    expect(calls[0].options.shell).toBeFalsy();
    expect(calls[0].options.stdio).toBe('inherit');
  });

  test('refuses a batch-file launcher on Windows rather than going through a shell', () => {
    const { calls, spawnFake } = recorder();
    expect(() => launchAgy('C:\\tools\\agy.cmd', [], spawnFake, 'win32')).toThrow(/AGY_BIN/);
    expect(calls).toHaveLength(0);
  });

  test('reads the version by running the binary directly', () => {
    const seen: unknown[][] = [];
    const run = ((file: string, args: string[]) => {
      seen.push([file, args]);
      return Buffer.from('agy version 1.4.12 (build abc)');
    }) as unknown as Parameters<typeof readAgyVersion>[1];

    expect(readAgyVersion('/path with spaces/agy', run)).toBe('1.4.12');
    expect(seen).toEqual([['/path with spaces/agy', ['--version']]]);
  });

  test('waits for the version no longer than it is told to', () => {
    const limits: unknown[] = [];
    const run = ((_file: string, _args: string[], options: { timeout?: number }) => {
      limits.push(options.timeout);
      return Buffer.from('1.4.12');
    }) as unknown as Parameters<typeof readAgyVersion>[1];

    readAgyVersion('/opt/agy/bin/agy', run);
    readAgyVersion('/opt/agy/bin/agy', run, 30_000);

    expect(limits).toEqual([5000, 30_000]);
  });

  test('reports no version when the binary cannot be run', () => {
    const run = (() => {
      throw new Error('spawn failed');
    }) as unknown as Parameters<typeof readAgyVersion>[1];
    expect(readAgyVersion('/missing/agy', run)).toBeNull();
  });
});
