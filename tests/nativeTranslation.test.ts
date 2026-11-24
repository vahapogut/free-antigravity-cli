/**
 * Native translation modes used by pinned agent workers.
 *
 * The pinned worker exchanges complete turns with an OpenAI-compatible endpoint and
 * validates tool calls against the request's own schema. The optional third argument —
 * mapGeminiToOpenAI(..., { nativeInputs: true }) and mapOpenAIToGemini(..., { nativeToolNames: true }) —
 * keeps each turn faithful: full JSON Schemas (parametersJsonSchema) pass through with the numeric
 * keyword fix intact, upstream tool names/args/IDs are never rewritten, reasoning travels with tool
 * turns, and no cross-session globals or local file dereference are involved.
 *
 * Fidelity also covers the call/result pairing and the text beside a call: id-less calls are paired
 * with their id-less results from the same request only (in order for a repeated tool), arguments
 * that are not a JSON object are rejected instead of silently emptied, and the assistant's visible
 * text — including a refusal-only reply — survives both directions of the roundtrip.
 *
 * Two-argument calls (and {} / explicit false) must keep the legacy behaviour exactly.
 */
import { mapGeminiToOpenAI, mapOpenAIToGemini } from '../src/proxy/translators/openai';
import {
  modelToolCallIds,
  modelReasoningContent,
  translatedToolCalls,
  activeStreamContexts,
  stateTimestamps,
} from '../src/proxy/shared';

const MODEL = 'test-worker-model';

beforeEach(() => {
  modelToolCallIds.clear();
  modelReasoningContent.clear();
  translatedToolCalls.clear();
  activeStreamContexts.clear();
  stateTimestamps.toolCallIds.clear();
  stateTimestamps.translatedCalls.clear();
  stateTimestamps.reasoning.clear();
  stateTimestamps.streamCtx.clear();
});

describe('mapGeminiToOpenAI with nativeInputs', () => {
  test('honors parametersJsonSchema and keeps the numeric schema keyword fix', () => {
    const declaration = {
      name: 'fetch_records',
      description: 'Fetch records',
      parametersJsonSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'OBJECT',
        properties: {
          Query: { type: 'STRING', minLength: '1', pattern: '^.+$' },
          Limit: { type: 'INTEGER', minimum: '1', maximum: '50' },
          Tags: { type: 'ARRAY', maxItems: '8', items: { type: 'STRING' } },
        },
        required: ['Query'],
      },
    };
    const geminiBody = {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
      tools: [{ functionDeclarations: [declaration] }],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    const parameters = native.tools![0].function.parameters as any;
    expect(native.tools![0].function.name).toBe('fetch_records');
    expect(parameters.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(parameters.type).toBe('object');
    expect(parameters.properties.Query.minLength).toBe(1);
    expect(parameters.properties.Query.pattern).toBe('^.+$');
    expect(parameters.properties.Limit.minimum).toBe(1);
    expect(parameters.properties.Limit.maximum).toBe(50);
    expect(parameters.properties.Tags.maxItems).toBe(8);
    expect(parameters.properties.Tags.items.type).toBe('string');
    expect(parameters.required).toEqual(['Query']);
    // The request the client sent is not mutated.
    expect(declaration.parametersJsonSchema.properties.Limit.minimum).toBe('1');

    // Legacy path unchanged: parametersJsonSchema is not part of its contract, so
    // the declaration collapses to the empty default it produced before this feature.
    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(legacy.tools![0].function.parameters).toEqual({ type: 'object', properties: {} });
  });

  test('prefers parametersJsonSchema over parameters only in native mode', () => {
    const declaration = {
      name: 'dual_tool',
      parameters: { type: 'OBJECT', properties: { Legacy: { type: 'STRING' } } },
      parametersJsonSchema: { type: 'object', properties: { Native: { type: 'string' } } },
    };
    const geminiBody = {
      contents: [{ role: 'user', parts: [{ text: 'go' }] }],
      tools: [{ functionDeclarations: [declaration] }],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    const nativeParams = native.tools![0].function.parameters as any;
    expect(nativeParams.properties.Native).toBeDefined();
    expect(nativeParams.properties.Legacy).toBeUndefined();

    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    const legacyParams = legacy.tools![0].function.parameters as any;
    expect(legacyParams.properties.Legacy).toBeDefined();
    expect(legacyParams.properties.Native).toBeUndefined();
  });

  test('keeps native tool names, args, and ids even when the legacy translation cache was seeded', () => {
    // Simulates a stale cross-session entry: legacy mode would replay through it, native must not read it.
    translatedToolCalls.set('call_alpha', {
      originalName: 'run_command',
      translatedName: 'view_file',
      cmd: 'cat notes.txt',
      cwd: '/work',
    });
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'read it' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'view_file', args: { AbsolutePath: '/work/notes.txt' }, id: 'call_alpha' } }],
        },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    expect(native.messages[1].tool_calls![0]).toEqual({
      id: 'call_alpha',
      type: 'function',
      function: { name: 'view_file', arguments: JSON.stringify({ AbsolutePath: '/work/notes.txt' }) },
    });

    // The seeded entry demonstrably drives the legacy rewrite.
    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(legacy.messages[1].tool_calls![0].function.name).toBe('run_command');
    expect(legacy.messages[1].tool_calls![0].function.arguments).toBe(
      JSON.stringify({ CommandLine: 'cat notes.txt', Cwd: '/work' }),
    );
  });

  test('carries reasoning_content through tool turns', () => {
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'read it' }] },
        {
          role: 'model',
          parts: [
            { text: 'I should open the file first.', thought: true },
            { functionCall: { name: 'view_file', args: { AbsolutePath: '/a.txt' }, id: 'call_r1' } },
          ],
        },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    expect(native.messages[1].role).toBe('assistant');
    expect(native.messages[1].content).toBeNull();
    expect(native.messages[1].reasoning_content).toBe('I should open the file first.');
    expect(native.messages[1].tool_calls).toHaveLength(1);

    // Legacy mode drops thought parts attached to a functionCall.
    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(legacy.messages[1].reasoning_content).toBe('');
  });

  test('reads no cross-session globals and pairs an id-less call with its id-less result', () => {
    modelToolCallIds.set(MODEL, { grep_search: 'call_stale' });
    modelReasoningContent.set(MODEL, 'stale-global-reasoning');
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'search it' }] },
        { role: 'model', parts: [{ functionCall: { name: 'grep_search', args: { Query: 'todo' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'grep_search', response: { Matches: [] } } }] },
        { role: 'model', parts: [{ text: 'all done' }] },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    // An id-less call gets an id from this request only — never the stale global map.
    const callId = native.messages[1].tool_calls![0].id;
    expect(typeof callId).toBe('string');
    expect(callId).not.toBe('call_stale');
    // Its id-less result is paired with that same call, so the pair round-trips.
    expect(native.messages[2]).toEqual({ role: 'tool', content: '{"Matches":[]}', tool_call_id: callId });
    // Derived from the request alone: re-mapping the identical history yields the identical ids.
    const again = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    expect(again.messages[1].tool_calls![0].id).toBe(callId);
    expect(again.messages[2].tool_call_id).toBe(callId);
    // Reasoning comes from the turn itself, never from the preserved global.
    expect(native.messages[3].reasoning_content).toBe('');
    // Globals are untouched, so a second worker session cannot read or evict them either.
    expect(modelToolCallIds.get(MODEL)).toEqual({ grep_search: 'call_stale' });
    expect(modelReasoningContent.get(MODEL)).toBe('stale-global-reasoning');
    expect(translatedToolCalls.size).toBe(0);

    // Legacy control: same body demonstrably consumes both globals.
    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(legacy.messages[2].tool_call_id).toBe('call_stale');
    expect(legacy.messages[3].reasoning_content).toBe('stale-global-reasoning');
  });

  test('pairs repeated id-less calls with their results in order and preserves explicit ids', () => {
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'read all three' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'view_file', args: { AbsolutePath: '/a.txt' } } },
            { functionCall: { name: 'view_file', args: { AbsolutePath: '/b.txt' } } },
            { functionCall: { name: 'view_file', args: { AbsolutePath: '/c.txt' }, id: 'call_explicit' } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'view_file', response: { output: 'A' } } },
            { functionResponse: { name: 'view_file', response: { output: 'B' } } },
            { functionResponse: { name: 'view_file', response: { output: 'C' }, id: 'call_explicit' } },
          ],
        },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    const ids = native.messages[1].tool_calls!.map((tc) => tc.id);
    // Each call is distinct, and the one id the worker supplied is replayed untouched.
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe('call_explicit');
    // The two id-less results land on the first two calls, in the order they were made.
    expect(native.messages.slice(2).map((m) => m.tool_call_id)).toEqual(ids);
    expect(native.messages.slice(2).map((m) => m.content)).toEqual(['{"output":"A"}', '{"output":"B"}', '{"output":"C"}']);
    // Correlation lives in the request only: no process-wide id bookkeeping.
    expect(modelToolCallIds.size).toBe(0);
    expect(translatedToolCalls.size).toBe(0);
  });

  test('an id-less result still pairs with an explicit-id call from the same request', () => {
    const geminiBody = {
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'list_dir', args: { DirectoryPath: '/srv' }, id: 'call_e1' } }],
        },
        { role: 'user', parts: [{ functionResponse: { name: 'list_dir', response: { files: [] } } }] },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    expect(native.messages[0].tool_calls![0].id).toBe('call_e1');
    expect(native.messages[1]).toEqual({ role: 'tool', content: '{"files":[]}', tool_call_id: 'call_e1' });
  });

  test('fails a native result no call in the request can answer, instead of inventing an id', () => {
    // Documented decision: fabricating an id (or reading a global one) would hand the worker a result it
    // cannot attribute to any call, so the turn is rejected locally and pinnedWorker answers 502.
    const orphan = {
      contents: [
        { role: 'user', parts: [{ text: 'read it' }] },
        { role: 'user', parts: [{ functionResponse: { name: 'view_file', response: { output: 'A' } } }] },
      ],
    };
    expect(() => mapGeminiToOpenAI(orphan, MODEL, { nativeInputs: true })).toThrow(/view_file/);
    expect(() => mapGeminiToOpenAI(orphan, MODEL, { nativeInputs: true })).toThrow(/functionResponse/);

    // The name must match too: a result for another tool is equally unattributable.
    const wrongName = {
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'view_file', args: { AbsolutePath: '/a.txt' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'list_dir', response: { files: [] } } }] },
      ],
    };
    expect(() => mapGeminiToOpenAI(wrongName, MODEL, { nativeInputs: true })).toThrow(/list_dir/);

    // One call cannot answer two results.
    const twice = {
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'view_file', args: { AbsolutePath: '/a.txt' }, id: 'call_once' } }],
        },
        { role: 'user', parts: [{ functionResponse: { name: 'view_file', response: { output: 'A' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'view_file', response: { output: 'B' } } }] },
      ],
    };
    expect(() => mapGeminiToOpenAI(twice, MODEL, { nativeInputs: true })).toThrow(/view_file/);

    // Legacy control: the same malformed bodies still fabricate the name-derived id.
    expect(mapGeminiToOpenAI(orphan, MODEL).messages[1]).toEqual({
      role: 'tool',
      content: '{"output":"A"}',
      tool_call_id: 'call_view_file',
    });
    expect(mapGeminiToOpenAI(wrongName, MODEL).messages[1]).toEqual({
      role: 'tool',
      content: '{"files":[]}',
      tool_call_id: 'call_list_dir',
    });
    expect(modelToolCallIds.size).toBe(0);
  });

  test('replays the visible text that accompanied the worker’s tool call', () => {
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'read it' }] },
        {
          role: 'model',
          parts: [
            { text: 'open it first', thought: true },
            { text: 'I will read it now.' },
            { functionCall: { name: 'view_file', args: { AbsolutePath: '/a.txt' }, id: 'call_v1' } },
          ],
        },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    expect(native.messages[1]).toEqual({
      role: 'assistant',
      content: 'I will read it now.',
      reasoning_content: 'open it first',
      tool_calls: [
        {
          id: 'call_v1',
          type: 'function',
          function: { name: 'view_file', arguments: JSON.stringify({ AbsolutePath: '/a.txt' }) },
        },
      ],
    });

    // Legacy control: content is nulled and the visible text is dropped with the thought.
    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(legacy.messages[1].content).toBeNull();
    expect(legacy.messages[1].reasoning_content).toBe('');
  });

  test('does not dereference local file references', () => {
    // A cwd-relative file URI the legacy path resolves and really reads. Native mode must keep
    // it a pure reference — no filesystem access, no inlined content.
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ fileData: { mimeType: 'application/json', fileUri: 'file:///./package.json' } }] },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    const content = native.messages[0].content as string;
    expect(typeof content).toBe('string');
    expect(content).toContain('[File reference:');
    expect(content).toContain('package.json');
    expect(content).not.toContain('free-antigravity-cli');

    // Legacy control: the same input dereferences the file and inlines its content.
    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(legacy.messages[0].content as string).toContain('[File content from');
    expect(legacy.messages[0].content as string).toContain('free-antigravity-cli');
  });

  test('maps inline images to native image_url content parts', () => {
    const geminiBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }],
        },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    const content = native.messages[0].content as unknown as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'look' });
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } });

    // Legacy collapses everything into one string.
    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(typeof legacy.messages[0].content).toBe('string');
    expect(legacy.messages[0].content as string).toContain('[Image: data:image/png;base64,aGVsbG8=]');
  });

  test('joins plain text parts without an options object present', () => {
    const geminiBody = {
      contents: [{ role: 'user', parts: [{ text: 'a' }, { text: 'b' }] }],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    expect(native.messages[0].content).toBe('a\nb');
  });
});

describe('mapOpenAIToGemini with nativeToolNames', () => {
  test('tool calls embedded in provider text keep the worker’s declared name and arguments', () => {
    const content = '<DSML|tool_calls><DSML|invoke name="run_command"><DSML|parameter name="CommandLine" string="true">ls</DSML|parameter></DSML|invoke></DSML|tool_calls>';
    const completion = { choices: [{ message: { content }, finish_reason: 'stop' }] };
    const native = mapOpenAIToGemini(completion, MODEL, { nativeToolNames: true });
    expect(native.candidates[0].content.parts).toEqual([{ functionCall: { name: 'run_command', args: { CommandLine: 'ls' } } }]);
    const legacy = mapOpenAIToGemini(completion, MODEL);
    expect(legacy.candidates[0].content.parts[0].functionCall?.name).toBe('list_dir');
  });
  test('keeps upstream tool names, args, and ids and writes no shared state', () => {
    const openaiRes = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_up1',
                type: 'function' as const,
                function: { name: 'run_command', arguments: JSON.stringify({ CommandLine: 'ls -la', Cwd: '/srv/app' }) },
              },
              { id: 'call_up2', type: 'function' as const, function: { name: 'noop_tool', arguments: '{"Note":"ok"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };

    const native = mapOpenAIToGemini(openaiRes, MODEL, { nativeToolNames: true });
    expect(native.candidates[0].finishReason).toBe('TOOL_CALL');
    expect(native.usageMetadata).toEqual({ promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 });
    expect(native.candidates[0].content.parts[0].functionCall).toEqual({
      name: 'run_command',
      args: { CommandLine: 'ls -la', Cwd: '/srv/app' },
      id: 'call_up1',
    });
    // Every declared field arrives byte-for-byte, ids included.
    expect(native.candidates[0].content.parts[1].functionCall).toEqual({
      name: 'noop_tool',
      args: { Note: 'ok' },
      id: 'call_up2',
    });
    // No heuristics, no bookkeeping: nothing lands in the process-wide maps.
    expect(translatedToolCalls.size).toBe(0);
    expect(modelToolCallIds.size).toBe(0);
    expect(stateTimestamps.translatedCalls.size).toBe(0);
    expect(stateTimestamps.toolCallIds.size).toBe(0);

    // Legacy control: the same call is rewritten by the command heuristics and cached.
    const legacy = mapOpenAIToGemini(openaiRes, MODEL);
    expect(legacy.candidates[0].content.parts[0].functionCall!.name).toBe('list_dir');
    expect(translatedToolCalls.has('call_up1')).toBe(true);
    expect(modelToolCallIds.get(MODEL)).toBeDefined();
  });

  test('rejects tool arguments that are not a JSON object instead of emptying them', () => {
    // Documented decision: the worker validates arguments against the schema it declared in the same
    // request, so a non-object payload can never run. Silently sending {} would hide a truncated or
    // double-encoded call and produce a misleading schema error downstream, so native mode rejects it.
    const samples: [string, unknown][] = [
      ['malformed JSON', 'not json'],
      ['truncated JSON', '{"Path":"sam'],
      ['double-encoded JSON', '"{\\"Path\\":\\"a.txt\\"}"'],
      ['null', 'null'],
      ['literal null', null],
      ['an array', '[{"Path":"a.txt"}]'],
      ['a string', '"sample.txt"'],
      ['a number', '42'],
      ['a non-object value', 42],
    ];
    for (const [label, raw] of samples) {
      const openaiRes = {
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'call_bad', type: 'function' as const, function: { name: 'view_file', arguments: raw } as any },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      expect(() => mapOpenAIToGemini(openaiRes, MODEL, { nativeToolNames: true })).toThrow(/Pinned tool arguments/);
      // Legacy control: the pre-existing silent degradation is untouched.
      expect(() => mapOpenAIToGemini(openaiRes, MODEL)).not.toThrow();
    }
    // Legacy specifically still degrades unparseable arguments to {}.
    const legacy = mapOpenAIToGemini(
      {
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'call_bad', type: 'function' as const, function: { name: 'noop_tool', arguments: 'not json' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      MODEL,
    );
    expect(legacy.candidates[0].content.parts[0].functionCall).toMatchObject({ name: 'noop_tool', args: {} });
  });

  test('does not expose provider-controlled text in a tool argument error', () => {
    const openaiRes = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_x\n[Fake] injected line',
                type: 'function' as const,
                function: { name: 'view_file\n[Fake] injected line', arguments: 'nope' } as any,
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    let message = '';
    try {
      mapOpenAIToGemini(openaiRes, MODEL, { nativeToolNames: true });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('[Fake]');
    expect(message).toMatch(/valid JSON/);
    expect(message).not.toContain('\n');
  });

  test('keeps zero-argument native calls legal when the provider omits or blanks arguments', () => {
    const openaiRes = {
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'call_a', type: 'function' as const, function: { name: 'ping_tool', arguments: '' } },
              { id: 'call_b', type: 'function' as const, function: { name: 'ping_tool', arguments: '   ' } },
              { id: 'call_c', type: 'function' as const, function: { name: 'ping_tool' } as any },
              // A provider that already sent an object keeps it untouched.
              {
                id: 'call_d',
                type: 'function' as const,
                function: { name: 'ping_tool', arguments: { Note: 'already an object' } } as any,
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const native = mapOpenAIToGemini(openaiRes, MODEL, { nativeToolNames: true });
    expect(native.candidates[0].content.parts.map((p) => p.functionCall!.args)).toEqual([
      {},
      {},
      {},
      { Note: 'already an object' },
    ]);
    expect(native.candidates[0].content.parts.map((p) => p.functionCall!.id)).toEqual([
      'call_a',
      'call_b',
      'call_c',
      'call_d',
    ]);
  });

  test('keeps visible assistant text that arrives beside tool calls', () => {
    const openaiRes = {
      choices: [
        {
          message: {
            content: 'Let me open the file.',
            reasoning_content: 'one step at a time',
            tool_calls: [
              {
                id: 'call_t1',
                type: 'function' as const,
                function: { name: 'view_file', arguments: '{"Path":"a.txt"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const native = mapOpenAIToGemini(openaiRes, MODEL, { nativeToolNames: true });
    // Gemini part order: thought, then the text the user sees, then the calls.
    expect(native.candidates[0].content.parts).toEqual([
      { thought: true, text: 'one step at a time' },
      { text: 'Let me open the file.' },
      { functionCall: { name: 'view_file', args: { Path: 'a.txt' }, id: 'call_t1' } },
    ]);
    expect(native.candidates[0].finishReason).toBe('TOOL_CALL');

    // Legacy control: text attached to a tool turn is still dropped.
    const legacy = mapOpenAIToGemini(openaiRes, MODEL);
    expect(legacy.candidates[0].content.parts.every((p) => !p.text)).toBe(true);
  });

  test('surfaces refusal text when the native reply carries neither content nor tool calls', () => {
    const openaiRes = {
      choices: [{ message: { content: null, refusal: 'I can’t help with that.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    };

    const native = mapOpenAIToGemini(openaiRes, MODEL, { nativeToolNames: true });
    expect(native.candidates[0].content.parts).toEqual([{ text: 'I can’t help with that.' }]);
    expect(native.candidates[0].finishReason).toBe('STOP');

    // A refusal next to tool calls is preserved by the tool-call path, and content still wins.
    const both = {
      choices: [
        {
          message: {
            content: 'First I will read it.',
            refusal: 'ignored',
            tool_calls: [
              { id: 'call_r', type: 'function' as const, function: { name: 'noop_tool', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    expect(mapOpenAIToGemini(both, MODEL, { nativeToolNames: true }).candidates[0].content.parts).toEqual([
      { text: 'First I will read it.' },
      { functionCall: { name: 'noop_tool', args: {}, id: 'call_r' } },
    ]);

    // Legacy control: a refusal-only reply stayed an empty candidate.
    expect(mapOpenAIToGemini(openaiRes, MODEL).candidates[0].content.parts).toEqual([]);
  });

  test('text and reasoning responses match the legacy mapping', () => {
    const openaiRes = {
      choices: [{ message: { content: 'hi there', reasoning_content: 'because reasons' }, finish_reason: 'stop' }],
    };

    const native = mapOpenAIToGemini(openaiRes, MODEL, { nativeToolNames: true });
    const legacy = mapOpenAIToGemini(openaiRes, MODEL);
    expect(native.candidates[0].content.parts).toEqual([
      { text: 'because reasons', thought: true },
      { text: 'hi there' },
    ]);
    expect(native).toEqual(legacy);
  });
});

describe('pin roundtrip fidelity', () => {
  test('an id-less result cannot reuse an earlier call already answered by explicit ID', () => {
    const call = (id: string) => ({ role: 'model', parts: [{ functionCall: { name: 'inspect', args: {}, id } }] });
    const result = (id?: string) => ({ role: 'user', parts: [{ functionResponse: { name: 'inspect', response: {}, id } }] });
    const replay = mapGeminiToOpenAI({ contents: [call('one'), result('one'), call('two'), result()] }, MODEL, { nativeInputs: true });
    expect(replay.messages.filter(m => m.role === 'tool').map(m => m.tool_call_id)).toEqual(['one', 'two']);
  });
  test('request → tool call → replay keeps schema, names, args, ids, and reasoning', () => {
    const schema = { type: 'object', properties: { Path: { type: 'string' } }, required: ['Path'] };
    const turn1 = {
      systemInstruction: { parts: [{ text: 'You are a pinned worker.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Read sample.txt' }] }],
      tools: [{ functionDeclarations: [{ name: 'view_file', description: 'view', parametersJsonSchema: schema }] }],
    };

    const payload1 = mapGeminiToOpenAI(turn1, MODEL, { nativeInputs: true });
    expect(payload1.messages[0]).toEqual({ role: 'system', content: 'You are a pinned worker.' });
    expect(payload1.messages[1]).toEqual({ role: 'user', content: 'Read sample.txt' });
    expect(payload1.tools![0].function.parameters).toEqual(schema);

    const upstream1 = {
      model: MODEL,
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_rt',
                type: 'function' as const,
                function: { name: 'view_file', arguments: '{"Path":"sample.txt"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    };

    const gemini1 = mapOpenAIToGemini(upstream1, MODEL, { nativeToolNames: true });
    expect(gemini1.candidates[0].content.parts[0].functionCall).toEqual({
      name: 'view_file',
      args: { Path: 'sample.txt' },
      id: 'call_rt',
    });

    // The client replays the worker's own call (with its thought) and the matching result.
    const turn2 = {
      ...turn1,
      contents: [
        ...turn1.contents,
        {
          role: 'model',
          parts: [
            { text: 'I will open the file.', thought: true },
            ...gemini1.candidates[0].content.parts,
          ],
        },
        { role: 'user', parts: [{ functionResponse: { name: 'view_file', id: 'call_rt', response: { output: 'sample' } } }] },
      ],
    };

    const payload2 = mapGeminiToOpenAI(turn2, MODEL, { nativeInputs: true });
    expect(payload2.messages[2]).toMatchObject({
      role: 'assistant',
      content: null,
      reasoning_content: 'I will open the file.',
    });
    expect(payload2.messages[2].tool_calls![0]).toEqual({
      id: 'call_rt',
      type: 'function',
      function: { name: 'view_file', arguments: '{"Path":"sample.txt"}' },
    });
    expect(payload2.messages[3]).toEqual({
      role: 'tool',
      content: '{"output":"sample"}',
      tool_call_id: 'call_rt',
    });
    expect(payload2.tools![0].function.parameters).toEqual(schema);

    // The whole roundtrip ran without touching process-wide translator state.
    expect(translatedToolCalls.size).toBe(0);
    expect(modelToolCallIds.size).toBe(0);
    expect(modelReasoningContent.size).toBe(0);
    expect(activeStreamContexts.size).toBe(0);
  });

  test('roundtrip keeps text beside calls and pairs id-less calls without global state', () => {
    const schema = { type: 'object', properties: { Path: { type: 'string' } }, required: ['Path'] };
    const turn1 = {
      contents: [{ role: 'user', parts: [{ text: 'Read a.txt and b.txt' }] }],
      tools: [{ functionDeclarations: [{ name: 'view_file', description: 'view', parametersJsonSchema: schema }] }],
    };

    // A provider that omits ids and shows text next to the calls is still replayable.
    const upstream1 = {
      choices: [
        {
          message: {
            content: 'Reading both.',
            tool_calls: [
              { type: 'function', function: { name: 'view_file', arguments: '{"Path":"a.txt"}' } },
              { type: 'function', function: { name: 'view_file', arguments: '{"Path":"b.txt"}' } },
            ] as any,
          },
          finish_reason: 'tool_calls',
        },
      ],
    };

    const gemini1 = mapOpenAIToGemini(upstream1, MODEL, { nativeToolNames: true });
    expect(gemini1.candidates[0].content.parts).toEqual([
      { text: 'Reading both.' },
      { functionCall: { name: 'view_file', args: { Path: 'a.txt' } } },
      { functionCall: { name: 'view_file', args: { Path: 'b.txt' } } },
    ]);

    // The client replays the turn verbatim and answers both results without ids.
    const turn2 = {
      ...turn1,
      contents: [
        ...turn1.contents,
        { role: 'model', parts: gemini1.candidates[0].content.parts },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'view_file', response: { output: 'A' } } },
            { functionResponse: { name: 'view_file', response: { output: 'B' } } },
          ],
        },
      ],
    };

    const payload2 = mapGeminiToOpenAI(turn2, MODEL, { nativeInputs: true });
    expect(payload2.messages[1]).toMatchObject({ role: 'assistant', content: 'Reading both.' });
    const ids = payload2.messages[1].tool_calls!.map((tc) => tc.id);
    expect(new Set(ids).size).toBe(2);
    expect(payload2.messages.slice(2).map((m) => m.tool_call_id)).toEqual(ids);
    expect(payload2.messages.slice(2).map((m) => m.content)).toEqual(['{"output":"A"}', '{"output":"B"}']);
    expect(payload2.tools![0].function.parameters).toEqual(schema);

    // The worker then refuses: the text still reaches AGY, and its history keeps it as visible text.
    const gemini2 = mapOpenAIToGemini(
      { choices: [{ message: { content: null, refusal: 'I can’t read outside the project.' }, finish_reason: 'stop' }] },
      MODEL,
      { nativeToolNames: true },
    );
    expect(gemini2.candidates[0].content.parts).toEqual([{ text: 'I can’t read outside the project.' }]);
    const turn3 = {
      ...turn2,
      contents: [...turn2.contents, { role: 'model', parts: gemini2.candidates[0].content.parts }],
    };
    const payload3 = mapGeminiToOpenAI(turn3, MODEL, { nativeInputs: true });
    expect(payload3.messages.at(-1)).toEqual({ role: 'assistant', content: 'I can’t read outside the project.', reasoning_content: '' });

    expect(translatedToolCalls.size).toBe(0);
    expect(modelToolCallIds.size).toBe(0);
    expect(modelReasoningContent.size).toBe(0);
    expect(activeStreamContexts.size).toBe(0);
  });
});

describe('backwards compatibility', () => {
  test('omitted options, {}, and explicit false all keep legacy behaviour', () => {
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'done' }] },
      ],
    };
    const plain = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(mapGeminiToOpenAI(geminiBody, MODEL, {})).toEqual(plain);
    expect(mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: false })).toEqual(plain);
    // Legacy still stamps reasoning_content on assistant messages (global map empty → '').
    expect(plain.messages[1].reasoning_content).toBe('');

    const openaiRes = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                id: 'call_compat',
                type: 'function' as const,
                function: { name: 'run_command', arguments: JSON.stringify({ CommandLine: 'ls', Cwd: '/srv' }) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    expect(mapOpenAIToGemini(openaiRes, MODEL, {})).toEqual(mapOpenAIToGemini(openaiRes, MODEL));
    expect(mapOpenAIToGemini(openaiRes, MODEL, { nativeToolNames: false })).toEqual(mapOpenAIToGemini(openaiRes, MODEL));
    expect(mapOpenAIToGemini(openaiRes, MODEL).candidates[0].content.parts[0].functionCall!.name).toBe('list_dir');
  });
});
