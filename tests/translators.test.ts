import * as path from 'path';
import { mapGeminiToOpenAI, mapOpenAIToGemini } from '../src/proxy/translators/openai';
import {
  mapGeminiToAnthropic,
  mapAnthropicToGemini,
  fixNumericSchemaKeywords,
  applyAnthropicPromptCaching,
} from '../src/proxy/translators/anthropic';
import { translateToolCallToNative, normalizeToolArgs } from '../src/proxy/translators/utils';
import { stopCleanupInterval } from '../src/proxy/shared';

describe('OpenAI Translator', () => {
  test('mapGeminiToOpenAI converts simple chat request', () => {
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'Hello' }] }
      ]
    };
    const result = mapGeminiToOpenAI(geminiBody, 'gpt-4o');
    expect(result.model).toBe('gpt-4o');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  test('mapOpenAIToGemini converts simple chat response', () => {
    const openaiRes = {
      choices: [
        {
          message: { content: 'Hi there!' },
          finish_reason: 'stop'
        }
      ],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
    };
    const result = mapOpenAIToGemini(openaiRes, 'gpt-4o');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].content.parts[0].text).toBe('Hi there!');
    expect(result.candidates[0].finishReason).toBe('STOP');
    expect(result.usageMetadata?.totalTokenCount).toBe(10);
  });
});

describe('Anthropic Translator', () => {
  test('mapGeminiToAnthropic converts simple chat request', () => {
    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: 'Hello Claude' }] }
      ],
      generationConfig: { maxOutputTokens: 100 }
    };
    const result = mapGeminiToAnthropic(geminiBody, 'claude-3-5-sonnet');
    expect(result.model).toBe('claude-3-5-sonnet');
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[0].content).toBe('Hello Claude');
    expect(result.max_tokens).toBe(100);
  });

  test('mapAnthropicToGemini converts simple chat response', () => {
    const anthRes = {
      content: [{ type: 'text', text: 'Hello human!' } as any],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10 }
    };
    const result = mapAnthropicToGemini(anthRes, 'claude-3-5-sonnet');
    expect(result.candidates[0].content.parts[0].text).toBe('Hello human!');
    expect(result.candidates[0].finishReason).toBe('STOP');
  });
});

describe('Tool & Args Utilities', () => {
  test('normalizeToolArgs maps snake_case parameters to PascalCase', () => {
    const rawArgs = { absolute_path: '/some/file.txt' };
    const normalized = normalizeToolArgs('view_file', rawArgs);
    expect(normalized).toEqual({ AbsolutePath: '/some/file.txt' });
  });

  test('translateToolCallToNative maps bash commands to native tools', () => {
    const resultCat = translateToolCallToNative('run_command', { CommandLine: 'cat memo.txt', Cwd: '/home' });
    expect(resultCat.name).toBe('view_file');
    expect(resultCat.args).toEqual({ AbsolutePath: path.resolve('/home', 'memo.txt') });

    const resultLs = translateToolCallToNative('run_command', { CommandLine: 'ls subdir', Cwd: '/home' });
    expect(resultLs.name).toBe('list_dir');
    expect(resultLs.args).toEqual({ DirectoryPath: path.resolve('/home', 'subdir') });
  });

  afterAll(() => {
    stopCleanupInterval();
  });
});

describe('Anthropic schema keywords', () => {
  test('fixNumericSchemaKeywords converts stringified int64 keywords to numbers', () => {
    const schema = {
      type: 'object',
      properties: {
        Message: { type: 'string', minLength: '1' },
        Items: { type: 'array', minItems: '2', items: { type: 'string', maxLength: '10' } },
        minLength: { type: 'string', description: 'a property literally named minLength' },
      },
    };
    fixNumericSchemaKeywords(schema);
    expect(schema.properties.Message.minLength).toBe(1);
    expect(schema.properties.Items.minItems).toBe(2);
    expect(schema.properties.Items.items.maxLength).toBe(10);
    expect(schema.properties.minLength).toEqual({ type: 'string', description: 'a property literally named minLength' });
  });
});

describe('Anthropic tool calls', () => {
  test('mapAnthropicToGemini passes tool_use input through unchanged', () => {
    const res = mapAnthropicToGemini({
      id: 'msg_1',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { Path: '/tmp/a.txt' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as any, 'models/test');
    const call = res.candidates[0].content.parts[0].functionCall;
    expect(call).toEqual({ name: 'read_file', args: { Path: '/tmp/a.txt' }, id: 'toolu_1' });
  });
});

describe('Anthropic prompt caching', () => {
  test('applyAnthropicPromptCaching marks the system prompt and enables automatic caching', () => {
    const body = mapGeminiToAnthropic({
      systemInstruction: { parts: [{ text: 'You are a coding agent.' }] },
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
    } as any, 'claude-opus-5-5');
    applyAnthropicPromptCaching(body);
    expect(body.system).toEqual([{ type: 'text', text: 'You are a coding agent.', cache_control: { type: 'ephemeral' } }]);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
  });

  test('applyAnthropicPromptCaching leaves an absent system prompt absent', () => {
    const body = mapGeminiToAnthropic({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] } as any, 'claude-opus-5-5');
    applyAnthropicPromptCaching(body);
    expect(body.system).toBeUndefined();
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('Anthropic sampling parameters', () => {
  const request = (model: string) =>
    mapGeminiToAnthropic(
      { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { temperature: 0.2 } } as any,
      model,
    );

  // Current Claude models reject sampling parameters with a 400.
  test.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-opus-4-8', 'claude-sonnet-4-6'])(
    'does not forward temperature to %s',
    (model) => {
      expect(request(model).temperature).toBeUndefined();
    },
  );

  test.each(['deepseek-chat', 'kimi-k2', 'claude-haiku-4-5'])('still forwards temperature to %s', (model) => {
    expect(request(model).temperature).toBe(0.2);
  });
});

