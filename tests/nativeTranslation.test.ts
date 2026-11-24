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

  test('reads no cross-session globals and writes none', () => {
    modelToolCallIds.set(MODEL, { grep_search: 'call_stale' });
    modelReasoningContent.set(MODEL, 'stale-global-reasoning');
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'search it' }] },
        { role: 'user', parts: [{ functionResponse: { name: 'grep_search', response: { Matches: [] } } }] },
        { role: 'model', parts: [{ text: 'all done' }] },
      ],
    };

    const native = mapGeminiToOpenAI(geminiBody, MODEL, { nativeInputs: true });
    // A response part without an id falls back to the name-derived id, never the global map.
    expect(native.messages[1]).toEqual({ role: 'tool', content: '{"Matches":[]}', tool_call_id: 'call_grep_search' });
    // Reasoning comes from the turn itself, never from the preserved global.
    expect(native.messages[2].reasoning_content).toBe('');
    // Globals are untouched, so a second worker session cannot read or evict them either.
    expect(modelToolCallIds.get(MODEL)).toEqual({ grep_search: 'call_stale' });
    expect(modelReasoningContent.get(MODEL)).toBe('stale-global-reasoning');
    expect(translatedToolCalls.size).toBe(0);

    // Legacy control: same body demonstrably consumes both globals.
    const legacy = mapGeminiToOpenAI(geminiBody, MODEL);
    expect(legacy.messages[1].tool_call_id).toBe('call_stale');
    expect(legacy.messages[2].reasoning_content).toBe('stale-global-reasoning');
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
              { id: 'call_up2', type: 'function' as const, function: { name: 'noop_tool', arguments: 'not json' } },
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
    // Unparseable args degrade to {} but the id still round-trips for the tool result.
    expect(native.candidates[0].content.parts[1].functionCall).toEqual({
      name: 'noop_tool',
      args: {},
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
