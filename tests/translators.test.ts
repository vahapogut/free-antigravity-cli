import * as path from 'path';
import { mapGeminiToOpenAI, mapOpenAIToGemini } from '../src/proxy/translators/openai';
import { mapGeminiToAnthropic, mapAnthropicToGemini } from '../src/proxy/translators/anthropic';
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
