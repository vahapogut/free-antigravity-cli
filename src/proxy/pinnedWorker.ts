import type { ServerResponse } from 'http';
import type { CustomModel } from '../proxy';
import { applyContextReserve, type AgentPin } from './agentPins';
import { getProviderHeaders } from './registry';
import { getOllamaApiUrl } from './translators/ollama';
import { mapGeminiToOpenAI, mapOpenAIToGemini } from './translators/openai';

/** Preserve an explicit completions URL. Base URLs (including non-v1 provider bases)
 * take /chat/completions; bare origins use the OpenAI default /v1. */
function completionsURL(model: CustomModel): URL {
  const url = new URL(model.provider === 'ollama' ? getOllamaApiUrl(model.apiUrl) : model.apiUrl);
  const base = url.pathname.replace(/\/+$/, '');
  url.pathname = base.endsWith('/chat/completions') ? base : `${base || '/v1'}/chat/completions`;
  return url;
}

export function pinError(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message } }));
}

export async function servePinnedWorker(
  res: ServerResponse, pin: AgentPin, model: CustomModel | undefined,
  input: Parameters<typeof mapGeminiToOpenAI>[0], stream: boolean,
): Promise<void> {
  if (!model || !model.externalModelName) return pinError(res, 502, 'Pinned custom model is unavailable.');
  if (!['openai', 'custom', 'openrouter', 'ollama'].includes(model.provider))
    return pinError(res, 502, 'Agent pins require an OpenAI-compatible chat model.');

  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);
  const timer = setTimeout(cancel, model.timeout || 120_000);
  try {
    const payload = mapGeminiToOpenAI(input, model.externalModelName, { nativeInputs: true });
    // Buffer one model turn: AGY receives a complete tool call and final usage
    // together, including when its own request expects an SSE envelope.
    const reply = await fetch(completionsURL(model), {
      method: 'POST', headers: getProviderHeaders(model.provider, model.apiKey) as Record<string, string>,
      body: JSON.stringify({ ...payload, stream: false }), redirect: 'error', signal: controller.signal,
    });
    if (!reply.ok) {
      await reply.body?.cancel();
      return pinError(res, 502, `Pinned provider returned HTTP ${reply.status}.`);
    }
    const completion = await reply.json() as Parameters<typeof mapOpenAIToGemini>[0] & { model?: string };
    if (completion?.model !== model.externalModelName || !completion.choices?.[0]?.message)
      return pinError(res, 502, 'Pinned provider did not return the configured model and a completion.');
    const response = mapOpenAIToGemini(completion, completion.model, { nativeToolNames: true });
    const candidate = response.candidates[0];
    if (candidate.finishReason === 'TOOL_CALL') candidate.finishReason = 'STOP';
    if (completion.choices[0].finish_reason === 'length') candidate.finishReason = 'MAX_TOKENS';
    const usage = response.usageMetadata;
    if (usage && completion.usage && typeof completion.usage.completion_tokens === 'number') {
      const raw = usage.promptTokenCount;
      applyContextReserve(usage, pin.contextReserve);
      if (usage.promptTokenCount !== raw && !res.destroyed) {
        res.setHeader('X-Agy-Raw-Prompt-Tokens', raw);
        res.setHeader('X-Agy-Context-Reserve', pin.contextReserve);
      }
    }
    const data = JSON.stringify({ response: { ...response, modelVersion: completion.model }, traceId: '', metadata: {} });
    if (res.destroyed) return;
    res.writeHead(200, { 'Content-Type': stream ? 'text/event-stream' : 'application/json' });
    res.end(stream ? `data: ${data}\n\n` : data);
  } catch {
    pinError(res, 502, 'Pinned model request failed.');
  } finally {
    clearTimeout(timer);
    res.removeListener('close', cancel);
  }
}
