/**
 * Free Antigravity CLI - Local Proxy Server.
 * Routes requests to Google, OpenAI, Anthropic, Ollama, and custom providers.
 * Intercepts model lists to inject user-defined custom models.
 */
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { log } from './logger';

// --- Types ---

export interface CustomModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  _slug?: string;
  timeout?: number;
  maxRetries?: number;
}

interface GeminiRequestBody {
  model?: string;
  modelId?: string;
  model_id?: string;
  request?: GeminiRequestBody;
  systemInstruction?: { parts: { text?: string }[] };
  contents?: {
    parts?: { text?: string; functionCall?: unknown; functionResponse?: unknown; thought?: boolean }[];
    role?: string;
  }[];
  tools?: unknown[];
  generationConfig?: { temperature?: number; maxOutputTokens?: number };
}

// --- State ---

let server: http.Server | null = null;
let proxyPort = 0;

import { modelToolCallIds, modelReasoningContent, activeStreamContexts, translatedToolCalls, stateTimestamps, touchStateTimestamp } from './proxy/shared';
import { detectModelCapabilities } from './proxy/modelUtils';
import * as registry from './proxy/registry';
import { decryptString } from './crypto';
import { validateCustomModel } from './schemaValidator';

// --- Model Helpers ---

export function generateModelPlaceholderId(model: CustomModel): string {
  const input = (model.displayName || model.name || 'custom-model').toLowerCase();
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash = hash & hash;
  }
  const placeholderNum = 400 + (Math.abs(hash) % 200);
  return `MODEL_PLACEHOLDER_M${placeholderNum}`;
}

export function getCustomModelsPath(): string {
  const home = os.homedir();
  return path.join(home, '.free-antigravity', 'models.json');
}

export function toSlug(model: CustomModel): string {
  return (
    'custom-' +
    (model.externalModelName || model.name)
      .replace(/^models\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
  );
}

// --- Model Loading ---

export function loadCustomModels(): CustomModel[] {
  const filePath = getCustomModelsPath();

  if (!fs.existsSync(filePath)) {
    // Create default config directory and file
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ models: [] }, null, 2), 'utf-8');
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { models?: CustomModel[] };
    const models = parsed.models || [];

    // Auto-migration: encrypt plaintext keys
    const needsMigration = models.some(
      (m) => !m.encrypted && m.apiKey && m.apiKey !== 'none' && !m.apiKey.startsWith('enc:') && !m.apiKey.startsWith('fallback:'),
    );
    if (needsMigration) {
      log.info('[Proxy] Migrating plaintext keys to encrypted format...');
      const encryptedModels = models.map((m) => {
        if (m.apiKey && m.apiKey !== 'none' && !m.encrypted) {
          const { encryptString } = require('./crypto');
          return { ...m, apiKey: encryptString(m.apiKey), encrypted: true };
        }
        return m;
      });
      fs.writeFileSync(filePath, JSON.stringify({ models: encryptedModels }, null, 2), 'utf-8');
      return encryptedModels as CustomModel[];
    }

    // Decrypt keys for in-memory use
    const decrypted = models.map((m) => {
      if (m.encrypted && m.apiKey && m.apiKey !== 'none') {
        try { return { ...m, apiKey: decryptString(m.apiKey), encrypted: false }; }
        catch { return m; }
      }
      return m;
    });

    // Validate models
    const validModels: CustomModel[] = [];
    for (let i = 0; i < decrypted.length; i++) {
      const validation = validateCustomModel(decrypted[i]) as { valid: boolean; error?: string };
      if (validation.valid) {
        validModels.push(decrypted[i] as CustomModel);
      } else {
        log.warn(`[Proxy] Skipping invalid model at index ${i}: ${validation.error}`);
      }
    }
    return validModels;
  } catch (e) {
    log.error('[Proxy] Failed to parse models config:', e);
    return [];
  }
}

// --- Google Proxy ---

function proxyToGoogle(req: http.IncomingMessage, res: http.ServerResponse, reqBody: Buffer): void {
  const targetUrl = 'https://daily-cloudcode-pa.googleapis.com';
  const parsedUrl = new URL(req.url!, targetUrl);

  const headers: Record<string, string | string[] | undefined> = { ...(req.headers as Record<string, string | string[] | undefined>) };
  headers['host'] = 'daily-cloudcode-pa.googleapis.com';
  delete headers['connection'];
  delete headers['keep-alive'];

  const options: https.RequestOptions = { method: req.method, headers: headers as Record<string, string> };

  const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
    proxyReq.setTimeout(60_000, () => {
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Google API request timed out' } }));
      }
    });

    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers as Record<string, string>);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    log.error('[Proxy] Google Forwarding Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Proxy forwarding failed: ' + err.message } }));
  });

  if (reqBody) proxyReq.write(reqBody);
  proxyReq.end();
}

// --- Custom Model Request Handler ---

function handleCustomModelRequest(
  res: http.ServerResponse, model: CustomModel, geminiBody: GeminiRequestBody,
  isStream: boolean, retryCount = 0,
): void {
  const MAX_RETRIES = Math.min(Math.max(model.maxRetries ?? 3, 0), 5);
  const REQUEST_TIMEOUT_MS = model.timeout || 120_000;

  const provider = model.provider === 'custom' || model.provider === 'openrouter' ? 'openai' : model.provider;
  const payload = registry.translateRequest(provider, geminiBody, model.externalModelName);
  const headers = registry.getProviderHeaders(provider, model.apiKey);

  if (isStream && registry.supportsStreaming(provider)) {
    (payload as Record<string, unknown>).stream = true;
  }

  let finalUrlStr = model.apiUrl;
  if (provider === 'google' || provider === 'ollama') {
    const t = registry.getTranslator(provider);
    finalUrlStr = registry.getProviderUrl(finalUrlStr, model.externalModelName, isStream, t);
  } else if (provider === 'openai' || model.provider === 'custom' || model.provider === 'openrouter') {
    const urlLower = finalUrlStr.toLowerCase();
    if (!urlLower.includes('/chat/completions') && !urlLower.includes('/completions')) {
      if (finalUrlStr.endsWith('/v1')) finalUrlStr += '/chat/completions';
      else if (!finalUrlStr.endsWith('/')) finalUrlStr += '/v1/chat/completions';
      else finalUrlStr += 'v1/chat/completions';
    }
  }

  const url = new URL(finalUrlStr);
  const client = url.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = { method: 'POST', headers: headers as Record<string, string> };
  if (model.allowUnauthorized) {
    (options as Record<string, unknown>).rejectUnauthorized = false;
    log.warn(`[Proxy] SSL verification DISABLED for ${model.name}`);
  }

  log.info(`[Proxy] Routing ${model.name} → ${model.provider} (${isStream ? 'stream' : 'non-stream'})${retryCount > 0 ? ` retry ${retryCount}` : ''}`);

  const request = client.request(url, options, (apiRes) => {
    apiRes.on('error', (err) => {
      log.error(`[Proxy] Upstream error for ${model.name}:`, err.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream error: ' + err.message } }));
      }
    });

    if (isStream) {
      if (apiRes.statusCode! >= 400) {
        let errorBody = '';
        apiRes.on('data', (chunk: Buffer) => errorBody += chunk.toString());
        apiRes.on('end', () => {
          log.error(`[Proxy] Stream API error (${apiRes.statusCode}): ${errorBody.substring(0, 200)}`);
          if (retryCount < MAX_RETRIES) {
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
            return;
          }
          res.writeHead(apiRes.statusCode!, { 'Content-Type': 'application/json' });
          res.end(errorBody);
        });
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

      let buffer = '';
      apiRes.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.substring(6).trim();
          if (dataStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(dataStr);
            const mapped = registry.translateStreamChunk(provider, parsed, model.name);
            if (mapped) {
              res.write(`data: ${JSON.stringify({ response: { candidates: [mapped] }, traceId: '', metadata: {} })}\n\n`);
            }
          } catch { /* partial chunk - ignore */ }
        }
      });

      apiRes.on('end', () => {
        if (buffer.trim().startsWith('data: ')) {
          const dataStr = buffer.trim().substring(6).trim();
          if (dataStr !== '[DONE]') {
            try {
              const parsed = JSON.parse(dataStr);
              const mapped = registry.translateStreamChunk(provider, parsed, model.name);
              if (mapped) {
                res.write(`data: ${JSON.stringify({ response: { candidates: [mapped] }, traceId: '', metadata: {} })}\n\n`);
              }
            } catch { /* ignore */ }
          }
        }
        const finalChunk = { response: { candidates: [{ content: { parts: [], role: 'model' }, finishReason: 'STOP', index: 0 }] }, traceId: '', metadata: {} };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.end();
      });
    } else {
      let body = '';
      apiRes.on('data', (chunk: Buffer) => (body += chunk));
      apiRes.on('end', () => {
        if (apiRes.statusCode! >= 500 && retryCount < MAX_RETRIES) {
          setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * Math.pow(2, retryCount));
          return;
        }
        if (apiRes.statusCode === 429 && retryCount < MAX_RETRIES) {
          setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 2000 * Math.pow(2, retryCount));
          return;
        }
        if (apiRes.statusCode! >= 400) {
          res.writeHead(apiRes.statusCode!, { 'Content-Type': 'application/json' });
          res.end(body);
          return;
        }
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          const reasoning = (parsed as { choices?: { message?: { reasoning_content?: string } }[] }).choices?.[0]?.message?.reasoning_content;
          if (reasoning) { modelReasoningContent.set(model.name, reasoning); touchStateTimestamp(stateTimestamps.reasoning, model.name); }

          const providerForResponse = model.provider === 'custom' || model.provider === 'openrouter' ? 'openai' : model.provider;
          const mapped = registry.translateResponse(providerForResponse, parsed, model.name);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ response: mapped, traceId: '', metadata: {} }));
        } catch (e) {
          if (retryCount < MAX_RETRIES) {
            setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
            return;
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Failed to translate response' } }));
        }
      });
    }
  });

  request.setTimeout(REQUEST_TIMEOUT_MS, () => {
    request.destroy();
    if (retryCount < MAX_RETRIES) {
      setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
      return;
    }
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Request timeout after ${REQUEST_TIMEOUT_MS / 1000}s` } }));
    }
  });

  request.on('error', (err) => {
    log.error('[Proxy] Custom Model Request Error:', err);
    if (retryCount < MAX_RETRIES) {
      setTimeout(() => handleCustomModelRequest(res, model, geminiBody, isStream, retryCount + 1), 1000 * (retryCount + 1));
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Custom model request failed: ' + err.message } }));
    }
  });

  request.write(JSON.stringify(payload));
  request.end();
}

// --- Main Request Handler ---

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Strip binary patch padding
  req.url = req.url!.replace(/\/v1internal\/x+/, '');

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    const memUsage = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), port: proxyPort, memory: { rssMB: Math.round(memUsage.rss / 1024 / 1024), heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024) }, timestamp: new Date().toISOString() }));
    return;
  }

  const MAX_BODY_SIZE = 10 * 1024 * 1024;
  let bodyLength = 0;
  let bodyRejected = false;
  const bodyChunks: Buffer[] = [];

  req.on('data', (chunk) => {
    bodyLength += chunk.length;
    if (bodyLength > MAX_BODY_SIZE) {
      if (!bodyRejected) { bodyRejected = true; req.destroy(); res.writeHead(413); res.end(JSON.stringify({ error: 'Request body too large' })); }
      return;
    }
    bodyChunks.push(chunk);
  });

  req.on('end', () => {
    if (bodyRejected) return;
    const fullBody = Buffer.concat(bodyChunks);

    log.info(`[Proxy] ${req.method} ${req.url}`);

    // 1. Intercept fetchAvailableModels - inject custom models
    if (req.url!.includes('/v1internal:fetchAvailableModels')) {
      log.info('[Proxy] Intercepting fetchAvailableModels');

      const targetUrl = 'https://daily-cloudcode-pa.googleapis.com';
      const fwdHeaders: Record<string, string | string[] | undefined> = { ...(req.headers as Record<string, string | string[] | undefined>) };
      fwdHeaders['host'] = 'daily-cloudcode-pa.googleapis.com';
      delete fwdHeaders['connection'];
      delete fwdHeaders['keep-alive'];

      const googleReq = https.request(new URL(req.url!, targetUrl), { method: req.method, headers: fwdHeaders as Record<string, string> }, (googleRes) => {
        googleReq.setTimeout(30_000, () => { googleReq.destroy(); if (!res.headersSent) { res.writeHead(200); res.end(JSON.stringify({ models: {} })); } });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            const googleJson = JSON.parse(googleBody) as Record<string, unknown>;
            const customModels = loadCustomModels();

            const mergeModels = (target: unknown): unknown => {
              if (Array.isArray(target)) {
                const mapped = customModels.map((m) => {
                  const cap = detectModelCapabilities(m, true);
                  return { name: 'models/' + generateModelPlaceholderId(m), version: '1.0', displayName: m.displayName, description: m.description, inputTokenLimit: cap.maxTokens, outputTokenLimit: cap.maxOutputTokens, supportedGenerationMethods: ['generateContent', 'countTokens'], temperature: cap.isThinking ? undefined : 0.7, topP: cap.isThinking ? undefined : 0.9, topK: cap.isThinking ? undefined : 40 };
                });
                return [...mapped, ...target];
              } else if (target && typeof target === 'object') {
                const result = { ...(target as Record<string, unknown>) };
                customModels.forEach((m) => {
                  const slug = toSlug(m);
                  const cap = detectModelCapabilities(m, true);
                  (result as Record<string, unknown>)[slug] = { displayName: m.displayName, supportsImages: cap.supportsImages, supportsThinking: cap.isThinking, recommended: true, maxTokens: cap.maxTokens, maxOutputTokens: cap.maxOutputTokens, tokenizerType: 'LLAMA_WITH_SPECIAL', model: generateModelPlaceholderId(m), apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE' };
                  m._slug = slug;
                });
                return result;
              }
              return target;
            };

            let merged = false;
            if (googleJson.models) { googleJson.models = mergeModels(googleJson.models); merged = true; }
            if (googleJson.availableModels) { googleJson.availableModels = mergeModels(googleJson.availableModels); merged = true; }
            if (googleJson.available_models) { googleJson.available_models = mergeModels(googleJson.available_models); merged = true; }

            if (!merged) {
              const modelsMap: Record<string, unknown> = {};
              customModels.forEach((m) => { const slug = toSlug(m); modelsMap[slug] = { displayName: m.displayName, recommended: true, maxTokens: 1048576, maxOutputTokens: 4096, tokenizerType: 'LLAMA_WITH_SPECIAL', model: generateModelPlaceholderId(m), apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE' }; m._slug = slug; });
              googleJson.models = modelsMap;
            }

            // Inject custom model slugs into agentModelSorts so they appear in the model selector
            const customSlugs = customModels.map((m) => m._slug).filter(Boolean) as string[];
            if (customSlugs.length > 0) {
              if (googleJson.agentModelSorts && Array.isArray(googleJson.agentModelSorts)) {
                (googleJson.agentModelSorts as { groups?: { modelIds?: string[] }[] }[]).forEach((sort) => {
                  if (sort.groups && Array.isArray(sort.groups)) {
                    sort.groups.forEach((group) => {
                      if (group.modelIds && Array.isArray(group.modelIds)) {
                        customSlugs.forEach((slug) => {
                          if (!group.modelIds!.includes(slug)) {
                            group.modelIds!.push(slug);
                          }
                        });
                      }
                    });
                  }
                });
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            // Google may return binary/protobuf on auth errors. Log cleanly.
            if (googleRes.statusCode && googleRes.statusCode >= 400) {
              log.info(`[Proxy] fetchAvailableModels: Google returned ${googleRes.statusCode}, using custom models only`);
            } else {
              log.info('[Proxy] fetchAvailableModels: response parse failed, using custom models only');
            }
            const customModels = loadCustomModels();
            const mappedCustom: Record<string, unknown> = {};
            const slugs: string[] = [];
            customModels.forEach((m) => { const slug = toSlug(m); slugs.push(slug); mappedCustom[slug] = { displayName: m.displayName, maxTokens: 1048576, maxOutputTokens: 4096, model: generateModelPlaceholderId(m), apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE' }; });
            const agentModelSorts = slugs.length > 0 ? [{ groups: [{ modelIds: slugs }] }] : [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom, agentModelSorts }));
          }
        });
      });
      googleReq.on('error', (err) => {
        log.error('[Proxy] fetchAvailableModels forward error:', err);
        const customModels = loadCustomModels();
        const mappedCustom: Record<string, unknown> = {};
        customModels.forEach((m) => { mappedCustom[toSlug(m)] = { displayName: m.displayName, maxTokens: 1048576, maxOutputTokens: 4096, model: generateModelPlaceholderId(m), apiProvider: 'API_PROVIDER_GOOGLE_GEMINI', modelProvider: 'MODEL_PROVIDER_GOOGLE' }; });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: mappedCustom }));
      });
      if (fullBody.length > 0) googleReq.write(fullBody);
      googleReq.end();
      return;
    }

    // 2. Intercept standard model list
    if (req.method === 'GET' && (req.url!.endsWith('/models') || req.url!.includes('/models?'))) {
      log.info('[Proxy] Intercepting models list');
      const targetUrl = 'https://generativelanguage.googleapis.com';
      const mdlHeaders: Record<string, string | string[] | undefined> = { ...(req.headers as Record<string, string | string[] | undefined>) };
      mdlHeaders['host'] = 'generativelanguage.googleapis.com';
      delete mdlHeaders['connection'];

      const googleReq = https.request(new URL(req.url!, targetUrl), { method: 'GET', headers: mdlHeaders as Record<string, string> }, (googleRes) => {
        let body = '';
        googleRes.on('data', (chunk) => (body += chunk));
        googleRes.on('end', () => {
          try {
            const googleJson = JSON.parse(body) as { models?: unknown[] };
            const customModels = loadCustomModels();
            const mappedCustom = customModels.map((m) => ({ name: 'models/' + generateModelPlaceholderId(m), version: '1.0', displayName: m.displayName, description: m.description, inputTokenLimit: 1048576, outputTokenLimit: 4096, supportedGenerationMethods: ['generateContent', 'countTokens'], temperature: 0.7, topP: 0.9, topK: 40 }));
            googleJson.models = [...mappedCustom, ...(googleJson.models || [])];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
          }
        });
      });
      googleReq.on('error', () => { res.writeHead(502); res.end(); });
      googleReq.end();
      return;
    }

    // 3. Intercept generateContent / streamGenerateContent for custom models
    const isCloudCodeStream = req.url!.includes('/v1internal:streamGenerateContent') || req.url!.includes('/v1internal:generateContent');
    if (req.method === 'POST' && isCloudCodeStream) {
      try {
        const reqJson = JSON.parse(fullBody.toString('utf-8')) as Record<string, unknown>;
        const modelName = reqJson.model as string | undefined;
        if (modelName) {
          const customModels = loadCustomModels();
          const matched = customModels.find((m) => {
            const enumName = generateModelPlaceholderId(m);
            return m.name === modelName || toSlug(m) === modelName || enumName === modelName || enumName === (reqJson.modelId || reqJson.model_id);
          });
          if (matched) {
            log.info(`[Proxy] Custom model match: ${modelName} → ${matched.displayName}`);
            const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
            handleCustomModelRequest(res, matched, (reqJson.request || reqJson) as GeminiRequestBody, isStream);
            return;
          }
        }
      } catch (err) { log.error('[Proxy] Parse error:', err); }
    }

    // 4. Intercept standard Gemini generateContent for custom models
    const generateMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
    const streamMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);
    if (req.method === 'POST' && (generateMatch || streamMatch)) {
      const matchedModelName = generateMatch ? generateMatch![1] : streamMatch![1];
      const customModels = loadCustomModels();
      const matched = customModels.find((m) => {
        const enumName = generateModelPlaceholderId(m);
        return m.name === matchedModelName || toSlug(m) === matchedModelName || enumName === matchedModelName || 'models/' + enumName === matchedModelName;
      });
      if (matched) {
        try {
          handleCustomModelRequest(res, matched, JSON.parse(fullBody.toString('utf-8')) as GeminiRequestBody, !!streamMatch);
          return;
        } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
      }
    }

    // 5. Fallback: transparent proxy to Google
    proxyToGoogle(req, res, fullBody);
  });
}

// --- Server Start/Stop ---

export function startProxy(port = 50998): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);
    server.listen(port, '127.0.0.1', () => {
      proxyPort = (server!.address() as import('net').AddressInfo).port;
      log.info(`[Proxy] Listening on http://127.0.0.1:${proxyPort}`);
      resolve(proxyPort);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.warn(`[Proxy] Port ${port} in use, falling back to dynamic port...`);
        console.warn(`[Warn] Port ${port} is busy, using dynamic port. Custom models may not appear in agy.`);
        console.warn(`[Warn] Close other instances or run: taskkill //F //IM agy.exe`);
        server!.close();
        server!.listen(0, '127.0.0.1', () => {
          proxyPort = (server!.address() as import('net').AddressInfo).port;
          log.info(`[Proxy] Listening on http://127.0.0.1:${proxyPort}`);
          resolve(proxyPort);
        });
      } else { reject(err); }
    });
  });
}

export function stopProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (server) { server.close(() => { server = null; resolve(); }); }
    else { resolve(); }
  });
}

export function getProxyPort(): number { return proxyPort; }
