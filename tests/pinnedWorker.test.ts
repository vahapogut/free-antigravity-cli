import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import supertest from 'supertest';
import { startProxy, stopProxy } from '../src/proxy';
import { stopCleanupInterval } from '../src/proxy/shared';

describe('signed-in worker routing', () => {
  const saved = path.join(process.env.FREE_ANTIGRAVITY_HOME!, 'models.json');
  const pins = path.join(process.env.FREE_ANTIGRAVITY_HOME!, 'pins.json');
  const previousPins = process.env.ANTIGRAVITY_AGENT_PINS;
  const seen: { path: string | undefined; headers: http.IncomingHttpHeaders; body: any }[] = [];
  let endpoint: http.Server, client: ReturnType<typeof supertest>;
  let fail = false, reportedModel: string | undefined;
  beforeAll(async () => {
    endpoint = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      seen.push({ path: req.url, headers: req.headers, body });
      if (fail) { res.writeHead(403).end('private upstream diagnostic'); return; }
      const tool = body.tools && !body.messages.some((m: any) => m.role === 'tool');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: reportedModel ?? body.model, choices: [{ finish_reason: tool ? 'tool_calls' : 'stop',
         message: tool ? { reasoning_content: 'inspect the file', tool_calls: [{ id: 'call1', function: { name: 'view_file', arguments: '{"Path":"sample.txt"}' } }] } : { content: 'done' } }],
        usage: { prompt_tokens: 400000, completion_tokens: 10, total_tokens: 400010 } }));
    });
    await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1/chat/completions/`;
    fs.writeFileSync(saved, JSON.stringify({ models: ['lead','worker'].map(id => ({ name: `models/${id}`,
      provider: 'custom', externalModelName: id, apiUrl: url, apiKey: id + '-fixture' })) }));
    fs.writeFileSync(pins, JSON.stringify({ reviewer: { model: 'models/worker', contextReserve: 112000 }, missing: { model: 'models/missing' } }));
    process.env.ANTIGRAVITY_AGENT_PINS = pins;
    client = supertest(`http://127.0.0.1:${await startProxy(0)}`);
  });
  afterAll(async () => {
    if (previousPins === undefined) delete process.env.ANTIGRAVITY_AGENT_PINS;
    else process.env.ANTIGRAVITY_AGENT_PINS = previousPins;
    await stopProxy(); stopCleanupInterval();
    await new Promise(resolve => endpoint.close(resolve));
  });
  beforeEach(() => { seen.length = 0; fail = false; reportedModel = undefined; });
  const post = (text: string, contents: any[] = [], stream = false) => client
    .post(`/v1internal:${stream ? 'streamGenerateContent' : 'generateContent'}`)
    .set('Authorization', 'Bearer caller-fixture').send({ model: 'models/lead', project: 'account-envelope',
      request: { systemInstruction: { role:'user', parts: [{ text }] }, contents,
        tools: [{ functionDeclarations: [{ name: 'view_file', parametersJsonSchema: { type: 'object', properties: { Path: {type:'string'} } } }] }] } });

  test('the worker resumes its own tool call and reports checkpoint headroom without changing model input', async () => {
    const history: any[] = [{ role: 'user', parts: [{ text: 'Read sample.txt' }] }];
    const first = await post('Agent-Pin: reviewer', history, true);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toContain('text/event-stream');
    const msg = JSON.parse(first.text.trim().replace(/^data: /, '')).response;
    expect(msg.modelVersion).toBe('worker');
    expect(msg.usageMetadata).toEqual({ promptTokenCount: 512000, candidatesTokenCount: 10, totalTokenCount: 512010 });
    expect(first.headers['x-agy-raw-prompt-tokens']).toBe('400000');
    expect(first.headers['x-agy-context-reserve']).toBe('112000');
    expect(msg.candidates[0].content.parts.find((p: any) => p.functionCall).functionCall).toMatchObject({ name:'view_file', args:{Path:'sample.txt'}, id:'call1' });
    history.push(msg.candidates[0].content, { role:'user', parts:[{ functionResponse:{ name:'view_file', id:'call1', response:{output:'sample'} } }] });
    const second = await post('Agent-Pin: reviewer',history);
    expect(second.body.response.candidates[0].content.parts[0].text).toBe('done');
    expect(seen[1].body.messages.at(-1)).toMatchObject({role:'tool',tool_call_id:'call1'});
    expect(seen[1].body.messages.at(-2)).toMatchObject({role:'assistant',reasoning_content:'inspect the file'});
    for (const call of seen) {
      expect(call.path).toBe('/v1/chat/completions');
      expect(call.headers.authorization).toBe('Bearer worker-fixture');
      expect(call.body.model).toBe('worker');
      expect(JSON.stringify(call.body)).not.toMatch(/112000|account-envelope/);
    }
  });
  test('marker in user text leaves the lead on its selected model and its actual usage', async () => {
    const r = await post('Lead', [{ role:'user',parts:[{text:'Agent-Pin: reviewer'}] }]);
    expect(seen[0].body.model).toBe('lead');
    expect(r.body.response.usageMetadata.promptTokenCount).toBe(400000);
  });
  test('a missing saved model fails without forwarding the worker to its caller’s selected model', async () => {
    expect((await post('Agent-Pin: missing')).status).toBe(502);
    expect(seen).toHaveLength(0);
  });
  test('a provider refusal never falls back or echoes the upstream diagnostic', async () => {
    fail = true;
    const r = await post('Agent-Pin: reviewer');
    expect(r.status).toBe(502);
    expect(r.text).not.toContain('private upstream diagnostic');
    expect(seen.map(x=>x.body.model)).toEqual(['worker']);
  });
  test('a response from a different model fails the pinned turn', async () => {
    reportedModel = 'different-worker';
    expect((await post('Agent-Pin: reviewer')).status).toBe(502);
    expect(seen.map(x => x.body.model)).toEqual(['worker']);
  });
  test('ambiguous markers reject the turn before contacting any backend', async () => {
    expect((await post('Agent-Pin: reviewer\nAgent-Pin: missing')).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
  test('a misspelled role never sends the worker conversation to the lead provider', async () => {
    expect((await post('Agent-Pin: reveiwer')).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
