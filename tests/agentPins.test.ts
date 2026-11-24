/**
 * Agent pins: an opt-in file of role → model pins, selection by the exact "Agent-Pin: <role>"
 * marker line in a system instruction, and the context reserve applied to usage counters.
 * Fixtures are written into a throwaway temporary directory; nothing here touches the network,
 * a real provider key, or any other setup identifier.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentPin, applyContextReserve, loadAgentPins, selectAgentPin } from '../src/proxy/agentPins';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pins-test-'));
let fixtureId = 0;
function pinsFile(content: string): string {
  const file = path.join(tempDir, `pins-${fixtureId++}.json`);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

/** A systemInstruction carrying exactly the given text parts. */
function instruction(...text: string[]): { parts: { text: string }[] } {
  return { parts: text.map((t) => ({ text: t })) };
}

/** Must never reappear in a rejection message: pin files live next to saved provider keys. */
const SENTINEL = 'sentinelfilevalueDONOT_ECHO';

const reviewer: AgentPin = { model: 'models/local-reviewer', contextReserve: 112_000 };
const planner: AgentPin = { model: 'models/local-planner', contextReserve: 0 };
const configured = new Map<string, AgentPin>([
  ['reviewer', reviewer],
  ['planner', planner],
]);

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('loadAgentPins', () => {
  test('stays disabled without a pins file', () => {
    expect(loadAgentPins()).toEqual(new Map());
    expect(loadAgentPins('')).toEqual(new Map());
  });

  test('loads the documented pins', () => {
    const file = pinsFile(JSON.stringify({ reviewer: { model: 'models/local-reviewer', contextReserve: 112_000 } }));
    const pins = loadAgentPins(file);
    expect(pins.size).toBe(1);
    expect(pins.get('reviewer')).toEqual({ model: 'models/local-reviewer', contextReserve: 112_000 });
  });

  test('defaults a missing contextReserve to 0', () => {
    const file = pinsFile(JSON.stringify({ planner: { model: 'models/local-planner' } }));
    expect(loadAgentPins(file).get('planner')).toEqual({ model: 'models/local-planner', contextReserve: 0 });
  });

  test('loads several roles with several identifier shapes', () => {
    const file = pinsFile(
      JSON.stringify({
        reviewer: { model: 'models/local-reviewer', contextReserve: 112_000 },
        planner: { model: 'openai/gpt-fixture' },
        'fast-helper-2': { model: 'llama3.2:latest', contextReserve: 0 },
      }),
    );
    expect([...loadAgentPins(file).keys()]).toEqual(['reviewer', 'planner', 'fast-helper-2']);
  });

  test('rejects a pins file that cannot be read', () => {
    expect(() => loadAgentPins(path.join(tempDir, 'never-written.json'))).toThrow(/never-written\.json/);
  });

  const rejected: [string, string][] = [
    ['JSON that does not parse', `{ "reviewer": { "model": "${SENTINEL}"`],
    ['a root that is an array', `[{"model":"${SENTINEL}"}]`],
    ['a root that is a string', `"${SENTINEL}"`],
    ['a root that is null', 'null'],
    ['a root that is a number', '42'],
    ['an empty object with a bad role name', `{ "Reviewer": { "model": "${SENTINEL}" } }`],
    ['an empty role name', `{ "": { "model": "${SENTINEL}" } }`],
    ['a role name with an underscore', `{ "local_reviewer": { "model": "${SENTINEL}" } }`],
    ['a role name with a double hyphen', `{ "a--b": { "model": "${SENTINEL}" } }`],
    ['a role name with a space', `{ "a b": { "model": "${SENTINEL}" } }`],
    ['a pin that is null', `{ "reviewer": null }`],
    ['a pin that is a string', `{ "reviewer": "${SENTINEL}" }`],
    ['a pin that is an array', `{ "reviewer": ["${SENTINEL}"] }`],
    ['a pin without a model', `{ "reviewer": { "contextReserve": 10 } }`],
    ['a model that is not a string', `{ "reviewer": { "model": 7 } }`],
    ['an empty model', `{ "reviewer": { "model": "" } }`],
    ['a model with a space', `{ "reviewer": { "model": "${SENTINEL} model" } }`],
    ['a model with a newline', `{ "reviewer": { "model": "model\\n${SENTINEL}" } }`],
    ['a credential field on a pin', `{ "reviewer": { "model": "models/m", "apiKey": "${SENTINEL}" } }`],
    ['any other extra field on a pin', `{ "reviewer": { "model": "models/m", "timeout": 5 } }`],
    ['a negative reserve', `{ "reviewer": { "model": "models/m", "contextReserve": -1 } }`],
    ['a fractional reserve', `{ "reviewer": { "model": "models/m", "contextReserve": 1.5 } }`],
    ['a reserve past the safe integer range', `{ "reviewer": { "model": "models/m", "contextReserve": 9007199254740992 } }`],
    ['a reserve as a string', `{ "reviewer": { "model": "models/m", "contextReserve": "1000" } }`],
    ['a reserve that is null', `{ "reviewer": { "model": "models/m", "contextReserve": null } }`],
  ];

  test.each(rejected)('rejects %s without echoing file content', (_case, content) => {
    const file = pinsFile(content);
    expect(() => loadAgentPins(file)).toThrow(/agentPins/);
    let message = 'nothing was thrown';
    try {
      loadAgentPins(file);
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).not.toContain(SENTINEL);
    expect(message).toContain(file);
  });
});

describe('selectAgentPin', () => {
  test('selects the pin named by the exact marker line', () => {
    expect(selectAgentPin(configured, instruction('You are the review worker.\nAgent-Pin: reviewer\nBe brief.'))).toBe(reviewer);
  });

  test('accepts a marker alone in a part, between other parts, and on CRLF lines', () => {
    expect(selectAgentPin(configured, instruction('Agent-Pin: reviewer'))).toBe(reviewer);
    expect(selectAgentPin(configured, instruction('preamble', 'Agent-Pin: planner', 'tail'))).toBe(planner);
    expect(selectAgentPin(configured, instruction('A\r\nAgent-Pin: reviewer\r\nB'))).toBe(reviewer);
  });

  test('leaves a request without a marker unpinned', () => {
    expect(selectAgentPin(configured, instruction('Lead'))).toBeUndefined();
    expect(selectAgentPin(configured, { parts: [{ inlineData: { mimeType: 'image/png' } }] })).toBeUndefined();
    expect(selectAgentPin(configured, { parts: 'Agent-Pin: reviewer' })).toBeUndefined();
    expect(selectAgentPin(configured, {})).toBeUndefined();
    expect(selectAgentPin(configured, 'Agent-Pin: reviewer')).toBeUndefined();
    expect(selectAgentPin(configured, undefined)).toBeUndefined();
    expect(selectAgentPin(configured, null)).toBeUndefined();
  });

  test('rejects an explicit marker that is missing from the configured pins', () => {
    expect(() => selectAgentPin(configured, instruction('Agent-Pin: driver'))).toThrow();
    expect(() => selectAgentPin(new Map<string, AgentPin>(), instruction('Agent-Pin: reviewer'))).toThrow();
  });

  test('refuses repeated and competing markers instead of guessing', () => {
    for (const text of ['Agent-Pin: reviewer\nAgent-Pin: reviewer','Agent-Pin: reviewer\nAgent-Pin: planner','Agent-Pin: reviewer\nAgent-Pin: not-configured']) {
      expect(() => selectAgentPin(configured, instruction(text))).toThrow();
    }
    expect(() => selectAgentPin(configured, instruction('Agent-Pin: reviewer', 'Agent-Pin: reviewer'))).toThrow();
  });

  const notMarkers = [
    ' Agent-Pin: reviewer',
    'Agent-Pin: reviewer ',
    'Agent-Pin:  reviewer',
    'Agent-Pin:reviewer',
    'agent-pin: reviewer',
    'AGENT-PIN: reviewer',
    'Agent-pin: reviewer',
    'Please Agent-Pin: reviewer now',
    'Agent-Pin: reviewer extra',
    'Agent-Pin: review er',
    '## Agent-Pin: reviewer',
  ];
  test.each(notMarkers)('treats %j as prose, not as a marker', (line) => {
    expect(selectAgentPin(configured, instruction(line))).toBeUndefined();
    expect(selectAgentPin(configured, instruction(`preamble\n${line}\ntail`))).toBeUndefined();
  });

  test('prose that merely mentions the marker does not compete with the real one', () => {
    expect(selectAgentPin(configured, instruction('Set Agent-Pin: reviewer later.\nAgent-Pin: planner'))).toBe(planner);
  });

  test('never reads user contents of a whole request body', () => {
    const body = {
      model: 'models/lead',
      contents: [
        { role: 'user', parts: [{ text: 'Agent-Pin: reviewer' }] },
        { role: 'user', parts: [{ text: 'Agent-Pin: planner\nAgent-Pin: reviewer' }] },
      ],
      systemInstruction: instruction('Lead'),
    };
    expect(selectAgentPin(configured, body)).toBeUndefined();
    expect(selectAgentPin(configured, { ...body, systemInstruction: instruction('Agent-Pin: reviewer') })).toBe(reviewer);
  });

  test('AGY labels its systemInstruction as user on the signed-in wire', () => {
    expect(selectAgentPin(configured, { role: 'user', parts: [{ text: 'Agent-Pin: reviewer' }] })).toBe(reviewer);
  });
});

interface Usage {
  promptTokenCount: number;
  totalTokenCount: number;
  candidatesTokenCount: number;
}

function usageWith(field: keyof Usage, value: unknown): Usage {
  return { promptTokenCount: 400_000, totalTokenCount: 400_010, candidatesTokenCount: 10, [field]: value } as unknown as Usage;
}

describe('applyContextReserve', () => {
  test('adds the reserve to prompt and total and leaves the output count alone', () => {
    const usage: Usage = { promptTokenCount: 400_000, totalTokenCount: 400_010, candidatesTokenCount: 10 };
    expect(applyContextReserve(usage, 112_000)).toBeUndefined();
    expect(usage).toEqual({ promptTokenCount: 512_000, totalTokenCount: 512_010, candidatesTokenCount: 10 });
  });

  test('zero input is not a usable provider measurement', () => {
    const usage: Usage = { promptTokenCount: 0, totalTokenCount: 0, candidatesTokenCount: 0 };
    applyContextReserve(usage, 5);
    expect(usage).toEqual({ promptTokenCount: 0, totalTokenCount: 0, candidatesTokenCount: 0 });
  });

  test('a zero reserve is a no-op', () => {
    const usage: Usage = { promptTokenCount: 7, totalTokenCount: 9, candidatesTokenCount: 2 };
    applyContextReserve(usage, 0);
    expect(usage).toEqual({ promptTokenCount: 7, totalTokenCount: 9, candidatesTokenCount: 2 });
  });

  test.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['past the safe integer range', Number.MAX_SAFE_INTEGER + 1],
  ])('ignores a %s reserve', (_case, reserve) => {
    const usage: Usage = { promptTokenCount: 7, totalTokenCount: 9, candidatesTokenCount: 2 };
    applyContextReserve(usage, reserve as number);
    expect(usage).toEqual({ promptTokenCount: 7, totalTokenCount: 9, candidatesTokenCount: 2 });
  });

  test.each([
    ['null', null],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['negative', -1],
    ['fractional', 10.5],
    ['a string', '400000'],
    ['undefined', undefined],
  ])('synthesizes nothing around a %s counter', (_case, value) => {
    for (const field of ['promptTokenCount', 'totalTokenCount', 'candidatesTokenCount'] as const) {
      const usage = usageWith(field, value);
      const before = { ...usage };
      applyContextReserve(usage, 112_000);
      expect({ ...usage }).toEqual(before);
    }
  });

  test('never invents a counter the provider did not report', () => {
    const usage = { promptTokenCount: 400_000, candidatesTokenCount: 10 } as unknown as Usage;
    applyContextReserve(usage, 112_000);
    expect('totalTokenCount' in usage).toBe(false);
    expect(usage).toEqual({ promptTokenCount: 400_000, candidatesTokenCount: 10 } as unknown as Usage);
  });

  test('leaves every counter alone when an adjusted counter would leave the safe integer range', () => {
    const atLimit: Usage = { promptTokenCount: Number.MAX_SAFE_INTEGER, totalTokenCount: Number.MAX_SAFE_INTEGER, candidatesTokenCount: 0 };
    applyContextReserve(atLimit, 1);
    expect(atLimit).toEqual({ promptTokenCount: Number.MAX_SAFE_INTEGER, totalTokenCount: Number.MAX_SAFE_INTEGER, candidatesTokenCount: 0 });

    const totalOnlyFails: Usage = { promptTokenCount: 10, totalTokenCount: Number.MAX_SAFE_INTEGER, candidatesTokenCount: 10 };
    applyContextReserve(totalOnlyFails, 1);
    expect(totalOnlyFails).toEqual({ promptTokenCount: 10, totalTokenCount: Number.MAX_SAFE_INTEGER, candidatesTokenCount: 10 });
  });

  test('the loaded file drives the reserve end to end', () => {
    const file = pinsFile(JSON.stringify({ reviewer: { model: 'models/local-reviewer', contextReserve: 112_000 } }));
    const pin = selectAgentPin(loadAgentPins(file), instruction('Agent-Pin: reviewer'));
    expect(pin).toBeDefined();
    const usage: Usage = { promptTokenCount: 400_000, totalTokenCount: 400_010, candidatesTokenCount: 10 };
    applyContextReserve(usage, pin!.contextReserve);
    expect(usage).toEqual({ promptTokenCount: 512_000, totalTokenCount: 512_010, candidatesTokenCount: 10 });
  });
});
