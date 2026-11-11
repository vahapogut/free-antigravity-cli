import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import supertest from 'supertest';

// Mock HTTPS before importing proxy
jest.mock('https', () => {
  const originalHttps = jest.requireActual('https');
  return {
    ...originalHttps,
    request: jest.fn((url: any, options: any, callback?: any) => {
      const mockResponse = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on: (event: string, handler: any) => {
          if (event === 'data') {
            setImmediate(() => handler(Buffer.from(JSON.stringify({ models: [] }))));
          }
          if (event === 'end') {
            setImmediate(() => handler());
          }
        }
      };
      if (callback) {
        setImmediate(() => callback(mockResponse));
      }
      return {
        on: () => {},
        write: () => {},
        end: () => {},
        setTimeout: () => {},
        destroy: () => {}
      };
    })
  };
});

import { startProxy, stopProxy } from '../src/proxy';
import { stopCleanupInterval } from '../src/proxy/shared';

describe('Proxy Server Integration', () => {
  let request: any;
  let port: number;

  beforeAll(async () => {
    // tests/setup-env.ts points FREE_ANTIGRAVITY_HOME at a temporary directory.
    fs.writeFileSync(
      path.join(process.env.FREE_ANTIGRAVITY_HOME!, 'models.json'),
      JSON.stringify({
        models: [
          {
            name: 'models/custom-test-model',
            displayName: 'Custom Test Model',
            provider: 'openai',
            apiKey: 'test-key',
            apiUrl: 'https://api.openai.com/v1/chat/completions',
            externalModelName: 'gpt-4o',
          },
        ],
      }),
    );
    port = await startProxy(0);
    request = supertest(`http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    await stopProxy();
    stopCleanupInterval();
  });

  test('Health check endpoint returns status ok', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('Intercepts fetchAvailableModels and injects custom models', async () => {
    const res = await request.post('/v1internal:fetchAvailableModels');
    expect(res.status).toBe(200);
    
    // Expect the custom model to be merged in the output
    const models = res.body.models || [];
    const customExists = models.some((m: any) => m.displayName === 'Custom Test Model');
    expect(customExists).toBe(true);
  });

  test('verbose logging never prints credentials', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const spies = [
      jest.spyOn(console, 'log').mockImplementation(capture),
      jest.spyOn(console, 'debug').mockImplementation(capture),
    ];
    const previous = process.env.ANTIGRAVITY_DEBUG;
    process.env.ANTIGRAVITY_DEBUG = 'true';
    try {
      await request
        .post('/v1internal:fetchAvailableModels?key=query-secret-123')
        .set('Authorization', 'Bearer ya29.session-secret-456')
        .set('x-goog-api-key', 'header-secret-789')
        .set('x-custom', 'visible-value');
    } finally {
      if (previous === undefined) delete process.env.ANTIGRAVITY_DEBUG;
      else process.env.ANTIGRAVITY_DEBUG = previous;
      spies.forEach((spy) => spy.mockRestore());
    }
    const output = lines.join(' | ');
    expect(output).toContain('fetchAvailableModels');
    expect(output).toContain('visible-value');
    for (const secret of ['query-secret-123', 'ya29.session-secret-456', 'header-secret-789']) {
      expect(output).not.toContain(secret);
    }
  });

  // The proxy serves one native client (agy). A web page must not be able to use it.
  describe('local-only access', () => {
    const corsHeaders = ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers'];

    test.each(['https://attacker.example', 'null', 'http://127.0.0.1:1'])(
      'refuses a request whose Origin is %s',
      async (origin) => {
        const res = await request.post('/v1internal:fetchAvailableModels').set('Origin', origin);
        expect(res.status).toBe(403);
        for (const header of corsHeaders) expect(res.headers[header]).toBeUndefined();
      },
    );

    test('does not answer a cross-origin preflight', async () => {
      const res = await request
        .options('/v1internal:streamGenerateContent')
        .set('Origin', 'https://attacker.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.status).toBe(403);
      for (const header of corsHeaders) expect(res.headers[header]).toBeUndefined();
    });

    test.each(['attacker.example', 'attacker.example:80', 'localhost'])(
      'refuses a Host header that is not this listener (%s)',
      async (host) => {
        const res = await request.get('/health').set('Host', host);
        expect(res.status).toBe(403);
      },
    );

    test('never sends CORS headers, even to the local client', async () => {
      const res = await request.get('/health');
      expect(res.status).toBe(200);
      for (const header of corsHeaders) expect(res.headers[header]).toBeUndefined();
    });

    test('accepts localhost as the Host name and its own origin', async () => {
      const res = await request
        .get('/health')
        .set('Host', `localhost:${port}`)
        .set('Origin', `http://localhost:${port}`);
      expect(res.status).toBe(200);
    });

    // new URL('//host/x', upstream) would replace the upstream host.
    test.each(['//attacker.example/v1internal:x', '/\\attacker.example/x', 'http://attacker.example/x'])(
      'refuses the request target %s',
      async (target) => {
        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port, path: target, method: 'GET', agent: false }, (res) => {
            res.resume();
            resolve(res.statusCode || 0);
          });
          req.setTimeout(2000, () => req.destroy(new Error('no response')));
          req.on('error', reject);
          req.end();
        });
        expect(status).toBe(400);
      },
    );
  });
});
