import * as path from 'path';
import * as os from 'os';
import supertest from 'supertest';

// Mock FS before importing proxy
jest.mock('fs', () => {
  const originalFs = jest.requireActual('fs');
  return {
    ...originalFs,
    existsSync: jest.fn((p) => {
      if (typeof p === 'string' && p.endsWith('models.json')) return true;
      return originalFs.existsSync(p);
    }),
    readFileSync: jest.fn((p, encoding) => {
      if (typeof p === 'string' && p.endsWith('models.json')) {
        return JSON.stringify({
          models: [
            {
              name: 'models/custom-test-model',
              displayName: 'Custom Test Model',
              provider: 'openai',
              apiKey: 'test-key',
              apiUrl: 'https://api.openai.com/v1/chat/completions',
              externalModelName: 'gpt-4o'
            }
          ]
        });
      }
      return originalFs.readFileSync(p, encoding);
    })
  };
});

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

  beforeAll(async () => {
    // Start proxy
    const port = await startProxy(0);
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
});
