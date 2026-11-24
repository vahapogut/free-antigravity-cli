/**
 * OpenAI/Ollama provider translator.
 * Handles Gemini ↔ OpenAI/Ollama request/response mapping and streaming chunks.
 */
import * as path from 'path';

import { log } from '../../logger';
import {
  fixParamTypes,
  fixNumericSchemaKeywords,
  translateToolCallToNative,
  formatTranslatedResponse,
  normalizeToolArgs,
  ToolCallArgs,
  TranslatedCallInfo,
} from './utils';
import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  translatedToolCalls,
  stateTimestamps,
  touchStateTimestamp,
  StreamContext,
} from '../shared';

// ─── Types ────────────────────────────────────────────────────────────────

interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: GeminiParameters;
  /** Full JSON Schema alternative to `parameters`; honored in native mode. */
  parametersJsonSchema?: Record<string, unknown>;
}

interface GeminiParameters {
  type: string;
  properties?: Record<string, unknown>;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  fileData?: { mimeType: string; fileUri: string };
  inlineData?: { mimeType: string; data: string };
}

interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

interface GeminiFunctionResponse {
  name: string;
  response: unknown;
  id?: string;
}

interface GeminiRequestBody {
  systemInstruction?: { parts: GeminiPart[] };
  contents?: GeminiContent[];
  tools?: GeminiTool[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

type OpenAIContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  tools?: OpenAITool[];
  stream?: boolean;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIChoice {
  message?: {
    // Providers omit or null this on tool-call-only replies.
    content?: string | null;
    // Refusal-only replies carry the visible text here instead of in `content`.
    refusal?: string | null;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
  delta?: {
    content?: string;
    reasoning_content?: string;
    reasoning?: string;
    tool_calls?: OpenAIToolCallDelta[];
  };
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface GeminiGenerateContentResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[];
    role: string;
  };
  finishReason: string;
  index: number;
}

interface GeminiUsageMetadata {
  promptTokenCount: number;
  candidatesTokenCount: number;
  totalTokenCount: number;
}

interface DSMLParsedResult {
  functionCalls: { name: string; args: Record<string, unknown> }[];
  cleanText: string;
}

/**
 * Request-side native mode for pinned agent workers. The worker's own turn is forwarded
 * faithfully: `parametersJsonSchema` is honored, thought parts travel with tool calls, and
 * no cross-session state or local file dereference is involved. Defaults keep legacy behavior.
 */
export interface OpenAINativeInputOptions {
  nativeInputs?: boolean;
}

/**
 * Response-side native mode for pinned agent workers. Upstream tool names, arguments, and IDs
 * pass through untouched — the worker validates calls against the request's own schema, so the
 * name/argument heuristics would rewrite valid calls. Defaults keep legacy behavior.
 */
export interface OpenAINativeToolOptions {
  nativeToolNames?: boolean;
}

// ─── REQUEST: Gemini → OpenAI ──────────────────────────────────────────────

function mapGeminiToolsToOpenAI(
  geminiTools: GeminiTool[],
  { nativeInputs = false }: OpenAINativeInputOptions = {},
): OpenAITool[] {
  if (!geminiTools || !Array.isArray(geminiTools)) return [];
  const openaiTools: OpenAITool[] = [];
  for (const toolGroup of geminiTools) {
    if (toolGroup.functionDeclarations && Array.isArray(toolGroup.functionDeclarations)) {
      for (const func of toolGroup.functionDeclarations) {
        // Native mode takes a declaration's full JSON Schema when present; legacy mode only knows `parameters`.
        const source = nativeInputs && func.parametersJsonSchema ? func.parametersJsonSchema : func.parameters;
        const params = source
          ? (JSON.parse(JSON.stringify(source)) as Record<string, unknown>)
          : { type: 'object', properties: {} };
        if (params.type && typeof params.type === 'string') {
          (params as Record<string, string>).type = (params.type as string).toLowerCase();
        }
        if (params.properties) {
          fixParamTypes(params.properties as Record<string, unknown>);
        }
        fixNumericSchemaKeywords(params);
        openaiTools.push({
          type: 'function',
          function: {
            name: func.name,
            description: func.description || '',
            parameters: params,
          },
        });
      }
    }
  }
  return openaiTools;
}

export function mapGeminiToOpenAI(
  geminiBody: GeminiRequestBody,
  modelName: string,
  { nativeInputs = false }: OpenAINativeInputOptions = {},
): OpenAIRequestBody {
  const messages: OpenAIMessage[] = [];

  // Native mode pairs tool calls with their results using this request's own history only: the pending
  // ids live in this local map and die with the call. Decision (integrated review): an id-less result
  // that no earlier call in the same request can answer is a protocol violation and fails the turn.
  // Fabricating an id (the legacy name-derived fallback) or reading a process-wide map would hand the
  // worker a result it cannot attribute to a call — the cross-session leak native mode exists to avoid.
  // Legacy mode keeps its random call ids, global lookup, and name-derived fallback untouched.
  const pendingCalls = new Map<string, { synthetic: string[]; explicit: string[] }>();
  let syntheticSeq = 0;

  if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
    const systemText = geminiBody.systemInstruction.parts.map((p) => p.text || '').join('');
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  if (geminiBody.contents) {
    for (const item of geminiBody.contents) {
      if (item.parts) {
        const hasFunctionCall = item.parts.some((p) => p.functionCall);
        const hasFunctionResponse = item.parts.some((p) => p.functionResponse);

        if (hasFunctionCall && item.role === 'model') {
          const toolCalls: OpenAIToolCall[] = [];
          for (const p of item.parts) {
            if (p.functionCall) {
              const explicitId = p.functionCall.id || '';
              const callId =
                explicitId ||
                (nativeInputs
                  ? `call_${p.functionCall.name}_${++syntheticSeq}`
                  : 'call_' + Math.random().toString(36).slice(2, 10));
              if (nativeInputs) {
                // Remember the call by name, in arrival order, so a later id-less result can find it.
                const pending = pendingCalls.get(p.functionCall.name) || { synthetic: [], explicit: [] };
                (explicitId ? pending.explicit : pending.synthetic).push(callId);
                pendingCalls.set(p.functionCall.name, pending);
              }
              let originalName = p.functionCall.name;
              let originalArgs = p.functionCall.args;
              const translatedInfo = nativeInputs ? undefined : translatedToolCalls.get(callId);
              if (translatedInfo) {
                originalName = translatedInfo.originalName;
                originalArgs = { CommandLine: translatedInfo.cmd, Cwd: translatedInfo.cwd };
              }
              toolCalls.push({
                id: callId,
                type: 'function',
                function: {
                  name: originalName,
                  arguments: typeof originalArgs === 'string' ? originalArgs : JSON.stringify(originalArgs || {}),
                },
              });
            }
          }
          // Native mode replays the worker's own call, so its reasoning travels with the tool turn.
          const thoughts = nativeInputs
            ? item.parts
                .filter((p) => p.thought)
                .map((p) => p.text || '')
                .join('')
            : '';
          // ...and so does the text AGY showed the user beside that call; legacy still nulls content.
          const visibleText = nativeInputs
            ? item.parts
                .filter((p) => !p.thought)
                .map((p) => p.text || '')
                .join('')
            : '';
          messages.push({
            role: 'assistant',
            content: visibleText || null,
            tool_calls: toolCalls,
            ...(thoughts ? { reasoning_content: thoughts } : {}),
          });
        } else if (hasFunctionResponse) {
          for (const p of item.parts) {
            if (p.functionResponse) {
              const funcName = p.functionResponse.name || '';
              let toolCallId = p.functionResponse.id || '';
              if (toolCallId && nativeInputs) {
                const pending = pendingCalls.get(funcName);
                if (pending) {
                  for (const queue of [pending.explicit, pending.synthetic]) {
                    const index = queue.indexOf(toolCallId);
                    if (index >= 0) { queue.splice(index, 1); break; }
                  }
                }
              } else if (nativeInputs) {
                // Pair with this request's own call: prefer one that also lacked an id, so a mixed
                // history cannot steal an explicit id that its own result still carries.
                const pending = pendingCalls.get(funcName);
                const queue = pending && (pending.synthetic.length ? pending.synthetic : pending.explicit);
                const paired = queue && queue.shift();
                if (!paired) {
                  throw new Error(
                    `Native worker history has a functionResponse for "${funcName}" with no id and no matching tool call in the same request`,
                  );
                }
                toolCallId = paired;
              }
              if (!toolCallId) {
                // Legacy fallbacks: the process-wide id map, then the name-derived id.
                const modelTCIds = modelToolCallIds.get(modelName) || {};
                toolCallId = modelTCIds[funcName] || 'call_' + funcName;
              }
              const responseData = p.functionResponse.response;
              let contentStr = '';
              const translatedInfo = nativeInputs ? undefined : translatedToolCalls.get(toolCallId);
              if (translatedInfo) {
                contentStr = formatTranslatedResponse(translatedInfo, responseData);
              } else {
                contentStr = typeof responseData === 'string' ? responseData : JSON.stringify(responseData || {});
              }
              messages.push({ role: 'tool', content: contentStr, tool_call_id: toolCallId });
            }
          }
        } else {
          const role = item.role === 'model' ? 'assistant' : item.role || 'user';
          let content: string | OpenAIContentPart[] = '';
          let reasoning_content = '';
          if (role === 'assistant') {
            const regularParts = (item.parts || []).filter((p) => !p.thought);
            const thoughtParts = (item.parts || []).filter((p) => p.thought);
            content = regularParts.map((p) => p.text || '').join('');
            reasoning_content = thoughtParts.map((p) => p.text || '').join('');
          } else if (nativeInputs) {
            // Faithful parts, and never a filesystem read: a file reference stays a reference.
            const parts: OpenAIContentPart[] = [];
            for (const p of item.parts) {
              if (p.text) {
                parts.push({ type: 'text', text: p.text });
              } else if (p.fileData) {
                parts.push({
                  type: 'text',
                  text: `[File reference: ${p.fileData.fileUri} (${p.fileData.mimeType})]`,
                });
              } else if (p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.startsWith('image/')) {
                parts.push({
                  type: 'image_url',
                  image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` },
                });
              } else if (p.inlineData) {
                parts.push({ type: 'text', text: `[Inline data: ${p.inlineData.mimeType}]` });
              }
            }
            content = parts.every((pt) => pt.type === 'text')
              ? parts.map((pt) => (pt.type === 'text' ? pt.text : '')).join('\n')
              : parts;
          } else {
            const parts = item.parts || [];
            const partsContent: string[] = [];
            for (const p of parts) {
              if (p.text) {
                partsContent.push(p.text);
              } else if (p.fileData) {
                const fd = p.fileData as { mimeType: string; fileUri: string };
                // Try to read local files directly
                try {
                  const url = new URL(fd.fileUri);
                  if (url.protocol === 'file:') {
                    const fs = require('fs');
                    const fileContent = fs.readFileSync(url.pathname.replace(/^\//, '').replace(/\//g, path.sep), 'utf-8');
                    partsContent.push(`[File content from ${fd.fileUri}]:\n${fileContent}`);
                  } else {
                    partsContent.push(`[File reference: ${fd.fileUri} (${fd.mimeType})]`);
                  }
                } catch {
                  partsContent.push(`[File reference: ${fd.fileUri} (${fd.mimeType})]`);
                }
              } else if (p.inlineData) {
                const id = p.inlineData as { mimeType: string; data: string };
                if (id.mimeType && id.mimeType.startsWith('image/')) {
                  partsContent.push(`[Image: data:${id.mimeType};base64,${id.data}]`);
                } else {
                  partsContent.push(`[Inline data: ${id.mimeType}, length: ${(id.data || '').length} chars]`);
                }
              }
            }
            content = partsContent.join('\n');
          }
          const msg: OpenAIMessage = { role, content };
          if (reasoning_content) msg.reasoning_content = reasoning_content;
          messages.push(msg);
        }
      }
    }
  }

  // Inject reasoning_content into assistant messages missing it
  let lastAssistantIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant') lastAssistantIdx = i;
  }
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && !(messages[i] as OpenAIMessage).reasoning_content) {
      // Native mode takes reasoning from the turn itself, never from the cross-session map.
      const preservedReasoning = nativeInputs ? '' : modelReasoningContent.get(modelName) || '';
      messages[i].reasoning_content = i === lastAssistantIdx && preservedReasoning ? preservedReasoning : '';
    }
  }

  // Models requiring max_completion_tokens instead of max_tokens:
  // - Legacy o-series: o1, o3, o4-mini (any format: o1, o1-mini, openai/o3, etc.)
  // - Legacy gpt-4.1 series: gpt-4.1, 4.1-mini, gpt-4.1-nano (any prefix)
  // - GPT-5.x thinking/pro: gpt-5.4-thinking, gpt-5.5-pro, etc.
  //   (OpenAI unified under GPT-5.x in Feb 2026, deprecated all previous models)
  const lowerName = modelName.toLowerCase();
  const isThinkingModel = /thinking|reasoning/i.test(lowerName);
  const isReasoningModel = /(^|\/|^openai\/)(o1|o3|o4)(-|$|mini|pro)/i.test(lowerName);
  const is41Model = /(^|\/|^openai\/)(gpt-)?4\.1(-|mini|nano)/i.test(lowerName);
  const is5Pro = /(^|\/|^openai\/)(gpt-)?5\.5-pro/i.test(lowerName);
  const is5Thinking = /(^|\/|^openai\/)(gpt-)?5\.4/i.test(lowerName);
  const needsCompletionTokens = isThinkingModel || isReasoningModel || is41Model || is5Pro || is5Thinking;
  const needsNoTemperature = isThinkingModel || isReasoningModel;

  const maxTokens = geminiBody.generationConfig?.maxOutputTokens ?? 4000;
  const payload: OpenAIRequestBody = {
    model: modelName,
    messages,
    ...(needsNoTemperature ? {} : { temperature: geminiBody.generationConfig?.temperature ?? 0.7 }),
    ...(needsCompletionTokens ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
  };

  if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
    const openaiTools = mapGeminiToolsToOpenAI(geminiBody.tools, { nativeInputs });
    if (openaiTools.length > 0) payload.tools = openaiTools;
  }

  return payload;
}

// ─── RESPONSE: OpenAI → Gemini ─────────────────────────────────────────────

function parseDSMLToolCalls(text: string): DSMLParsedResult | null {
  try {
    const invokeRegex = /<DSML\|invoke name="([^"]+)">([\s\S]*?)<\/DSML\|invoke>/g;
    const functionCalls: { name: string; args: Record<string, unknown> }[] = [];
    let invokeMatch: RegExpExecArray | null;
    while ((invokeMatch = invokeRegex.exec(text)) !== null) {
      const funcName = invokeMatch[1];
      const paramsBlock = invokeMatch[2];
      const args: Record<string, unknown> = {};
      const paramRegex = /<DSML\|parameter name="([^"]+)"(?: string="([^"]+)")?>([\s\S]*?)<\/DSML\|parameter>/g;
      let paramMatch: RegExpExecArray | null;
      while ((paramMatch = paramRegex.exec(paramsBlock)) !== null) {
        const paramName = paramMatch[1];
        let paramValue: unknown = paramMatch[3].trim();
        const isString = paramMatch[2] === 'true';
        if (!isString) {
          try {
            paramValue = JSON.parse(paramValue as string);
          } catch (e) {
            log.debug('[OpenAI] DSML param parse fallback:', (e as Error).message); /* keep as string */
          }
        }
        args[paramName] = paramValue;
      }
      functionCalls.push({ name: funcName, args });
    }
    if (functionCalls.length === 0) return null;
    log.info(
      `[Proxy] Detected ${functionCalls.length} DSML tool call(s): ${functionCalls.map((f) => f.name).join(', ')}`,
    );
    let cleanText = text;
    cleanText = cleanText.replace(/<DSML\|tool_calls>[\s\S]*?<\/DSML\|tool_calls>/g, '');
    cleanText = cleanText.replace(/<DSML\|invoke name="[^"]+">[\s\S]*?<\/DSML\|invoke>/g, '');
    cleanText = cleanText.trim();
    return { functionCalls, cleanText };
  } catch (e) {
    log.error('[Proxy] Failed to parse DSML tool calls:', e);
    return null;
  }
}

/** True only for a JSON object, the sole shape tool arguments may take. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Native-mode argument decoding (integrated review): the pinned worker validates arguments against the
 * schema it declared in the same request, so a payload that is not a JSON object can never run. Emptying
 * it to `{}` would hide a truncated or double-encoded call and replace the real failure with a misleading
 * schema error, so the turn is rejected instead — pinnedWorker.ts turns the throw into its own 502 and
 * never echoes the payload. Absent or blank arguments stay `{}` because providers legitimately omit them
 * for zero-argument tools, and a provider that already sent an object is passed through untouched.
 */
function parseNativeToolArgs(tc: OpenAIToolCall): Record<string, unknown> {
  const raw: unknown = tc.function?.arguments;
  if (raw === undefined) return {};
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) return {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Pinned tool arguments must be valid JSON.');
    }
  }
  if (!isJsonObject(parsed)) throw new Error('Pinned tool arguments must be a JSON object.');
  return parsed;
}

/**
 * Text the user is meant to see: the provider's `content`, or the `refusal` some models send in its place
 * when they decline. Whitespace-only text counts as none so it never becomes an empty part.
 */
function nativeVisibleText(message: OpenAIChoice['message']): string {
  if (typeof message?.content === 'string' && message.content.trim()) return message.content;
  return typeof message?.refusal === 'string' ? message.refusal : '';
}

export function mapOpenAIToGemini(
  openAiRes: OpenAIResponse,
  modelName: string,
  { nativeToolNames = false }: OpenAINativeToolOptions = {},
): GeminiGenerateContentResponse {
  const choice = openAiRes.choices?.[0];

  if (choice?.message?.tool_calls && choice.message.tool_calls.length > 0) {
    const parts: GeminiPart[] = choice.message.tool_calls.map((tc) => {
      if (nativeToolNames) {
        // The pinned-worker path validates against the request's own schema; the
        // name/command heuristics below would rewrite valid calls and leak shared state.
        return { functionCall: { name: tc.function.name, args: parseNativeToolArgs(tc), id: tc.id } };
      }
      let args: ToolCallArgs;
      try {
        args =
          typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as unknown as ToolCallArgs);
      } catch (e) {
        log.debug('[OpenAI] Tool call args parse fallback:', (e as Error).message);
        args = {};
      }
      args = normalizeToolArgs(tc.function.name, args) as ToolCallArgs;
      const modelTCIds = modelToolCallIds.get(modelName) || {};
      modelTCIds[tc.function.name] = tc.id;
      modelToolCallIds.set(modelName, modelTCIds);
      touchStateTimestamp(stateTimestamps.toolCallIds, modelName);
      const translated = translateToolCallToNative(tc.function.name, args);
      if (translated.name !== tc.function.name) {
        translated.args = normalizeToolArgs(translated.name, translated.args) as Record<string, unknown>;
        translatedToolCalls.set(tc.id, {
          originalName: tc.function.name,
          translatedName: translated.name,
          cmd: args.CommandLine || '',
          cwd: args.Cwd || '',
        });
        touchStateTimestamp(stateTimestamps.translatedCalls, tc.id);
      }
      return { functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: tc.id } };
    });
    if (nativeToolNames) {
      // Gemini part order is thought → visible text → calls, so the worker's own text travels with its
      // tool turn and the client can replay it (legacy drops it).
      const visible = nativeVisibleText(choice.message);
      if (visible) parts.unshift({ text: visible });
      const thought = choice.message.reasoning_content || choice.message.reasoning;
      if (thought) parts.unshift({ thought: true, text: thought });
    }
    return {
      candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
      usageMetadata: {
        promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
        candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
        totalTokenCount: openAiRes.usage?.total_tokens || 0,
      },
    };
  }

  const contentText = choice?.message?.content || '';
  // Native mode also surfaces a refusal-only reply, whose visible text arrives in `refusal` while
  // `content` stays null (legacy keeps the empty candidate it always produced).
  const text = nativeToolNames && !contentText ? nativeVisibleText(choice?.message) : contentText;
  const dsml = parseDSMLToolCalls(contentText);
  if (dsml && dsml.functionCalls.length > 0) {
    const parts: GeminiPart[] = dsml.functionCalls.map((fc) => {
      if (nativeToolNames) return { functionCall: { name: fc.name, args: fc.args } };
      const na = normalizeToolArgs(fc.name, fc.args);
      const tr = translateToolCallToNative(fc.name, na);
      return { functionCall: { name: tr.name, args: tr.args as Record<string, unknown> } };
    });
    if (dsml.cleanText) parts.unshift({ text: dsml.cleanText });
    return {
      candidates: [{ content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 }],
      usageMetadata: {
        promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
        candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
        totalTokenCount: openAiRes.usage?.total_tokens || 0,
      },
    };
  }

  const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
  const parts: GeminiPart[] = [];
  if (reasoning) parts.push({ text: reasoning, thought: true });
  if (text) parts.push({ text });
  const finishReason = choice?.finish_reason === 'stop' ? 'STOP' : 'OTHER';
  return {
    candidates: [{ content: { parts, role: 'model' }, finishReason, index: 0 }],
    usageMetadata: {
      promptTokenCount: openAiRes.usage?.prompt_tokens || 0,
      candidatesTokenCount: openAiRes.usage?.completion_tokens || 0,
      totalTokenCount: openAiRes.usage?.total_tokens || 0,
    },
  };
}

// ─── STREAM CHUNK: OpenAI → Gemini ────────────────────────────────────────

export function mapOpenAIChunkToGemini(chunk: OpenAIResponse, modelName: string): GeminiCandidate | null {
  const choice = chunk.choices?.[0];
  if (!choice) return null;
  const delta = choice.delta;
  const streamId = ((chunk as Record<string, unknown>).id as string) || 'default_stream';

  if (!activeStreamContexts.has(streamId)) {
    activeStreamContexts.set(streamId, { accumulatedText: '', accumulatedReasoning: '', toolCalls: {} });
    touchStateTimestamp(stateTimestamps.streamCtx, streamId);
  }
  const context = activeStreamContexts.get(streamId)!;

  if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      if (!context.toolCalls[idx]) context.toolCalls[idx] = { id: '', name: '', arguments: '' };
      if (tc.id) context.toolCalls[idx].id = tc.id;
      if (tc.function?.name) context.toolCalls[idx].name += tc.function.name;
      if (tc.function?.arguments) context.toolCalls[idx].arguments += tc.function.arguments;
    }
  }

  let text = delta?.content || '';
  const reasoning = delta?.reasoning_content || delta?.reasoning || '';
  if (reasoning) {
    context.accumulatedReasoning += reasoning;
    return { content: { parts: [{ text: reasoning, thought: true }], role: 'model' }, finishReason: 'OTHER', index: 0 };
  }
  if (text) context.accumulatedText += text;

  const dsml = parseDSMLToolCalls(context.accumulatedText);
  if (dsml && dsml.functionCalls.length > 0) {
    const parts: GeminiPart[] = dsml.functionCalls.map((fc) => {
      const na = normalizeToolArgs(fc.name, fc.args);
      const tr = translateToolCallToNative(fc.name, na);
      return { functionCall: { name: tr.name, args: tr.args as Record<string, unknown> } };
    });
    context.accumulatedText = '';
    return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
  }

  const finishReason = choice.finish_reason;
  if (finishReason === 'stop' || finishReason === 'length') {
    // Check for pending native tool_calls before closing stream
    const pendingToolCalls = Object.values(context.toolCalls).filter((tc) => tc.name && tc.arguments);
    if (pendingToolCalls.length > 0) {
      const parts: GeminiPart[] = pendingToolCalls.map((tc) => {
        let args: ToolCallArgs = {};
        try {
          args = JSON.parse(tc.arguments);
        } catch (_e) {
          args = {};
        }
        args = normalizeToolArgs(tc.name, args) as ToolCallArgs;
        const modelTCIds = modelToolCallIds.get(modelName) || {};
        modelTCIds[tc.name] = tc.id;
        modelToolCallIds.set(modelName, modelTCIds);
        touchStateTimestamp(stateTimestamps.toolCallIds, modelName);
        const translated = translateToolCallToNative(tc.name, args);
        if (translated.name !== tc.name) {
          translatedToolCalls.set(tc.id, {
            originalName: tc.name,
            translatedName: translated.name,
            cmd: args.CommandLine || '',
            cwd: args.Cwd || '',
          });
          touchStateTimestamp(stateTimestamps.translatedCalls, tc.id);
        }
        return { functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: tc.id } };
      });
      activeStreamContexts.delete(streamId);
      return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
    }
    // Check for accumulated DSML tool calls
    if (context.accumulatedText) {
      const dsml2 = parseDSMLToolCalls(context.accumulatedText);
      if (dsml2 && dsml2.functionCalls.length > 0) {
        const parts: GeminiPart[] = dsml2.functionCalls.map((fc) => {
          const na = normalizeToolArgs(fc.name, fc.args);
          const tr = translateToolCallToNative(fc.name, na);
          return { functionCall: { name: tr.name, args: tr.args as Record<string, unknown> } };
        });
        if (dsml2.cleanText) parts.unshift({ text: dsml2.cleanText });
        activeStreamContexts.delete(streamId);
        return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
      }
    }
    activeStreamContexts.delete(streamId);
    return { content: { parts: text ? [{ text }] : [], role: 'model' }, finishReason: 'STOP', index: 0 };
  }

  // Only emit tool calls when finishReason signals completion (args are fully accumulated)
  if (finishReason === 'tool_calls') {
    const parts: GeminiPart[] = Object.values(context.toolCalls).map((tc) => {
      let args: ToolCallArgs = {};
      try {
        args = JSON.parse(tc.arguments);
      } catch (e) {
        log.debug('[OpenAI] Stream tool args parse fallback:', (e as Error).message);
        args = {};
      }
      args = normalizeToolArgs(tc.name, args) as ToolCallArgs;
      const modelTCIds = modelToolCallIds.get(modelName) || {};
      modelTCIds[tc.name] = tc.id;
      modelToolCallIds.set(modelName, modelTCIds);
      touchStateTimestamp(stateTimestamps.toolCallIds, modelName);
      const translated = translateToolCallToNative(tc.name, args);
      if (translated.name !== tc.name) {
        translated.args = normalizeToolArgs(translated.name, translated.args) as Record<string, unknown>;
        translatedToolCalls.set(tc.id, {
          originalName: tc.name,
          translatedName: translated.name,
          cmd: args.CommandLine || '',
          cwd: args.Cwd || '',
        });
        touchStateTimestamp(stateTimestamps.translatedCalls, tc.id);
      }
      return { functionCall: { name: translated.name, args: translated.args as Record<string, unknown>, id: tc.id } };
    });
    activeStreamContexts.delete(streamId);
    return { content: { parts, role: 'model' }, finishReason: 'TOOL_CALL', index: 0 };
  }

  if (text) {
    return { content: { parts: [{ text }], role: 'model' }, finishReason: 'OTHER', index: 0 };
  }

  return null;
}

export { mapGeminiToolsToOpenAI };
