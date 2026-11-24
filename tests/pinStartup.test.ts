import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startProxy } from '../src/proxy';

test('an occupied port cannot silently select another router for a pinned session', async () => {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const file = path.join(process.env.FREE_ANTIGRAVITY_HOME!, 'pins.json');
  const original = process.env.ANTIGRAVITY_AGENT_PINS;
  try {
    fs.writeFileSync(file, JSON.stringify({ reviewer: { model: 'models/local-reviewer' } }));
    process.env.ANTIGRAVITY_AGENT_PINS = file;
    await expect(startProxy((server.address() as AddressInfo).port)).rejects.toThrow(/port/i);
  } finally {
    if (original === undefined) delete process.env.ANTIGRAVITY_AGENT_PINS;
    else process.env.ANTIGRAVITY_AGENT_PINS = original;
    await new Promise(resolve => server.close(resolve));
  }
});
