import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startProxy, stopProxy } from '../src/proxy';
import { stopCleanupInterval } from '../src/proxy/shared';

test.each([true, false])('an occupied AGY port prevents a new session starting (pins enabled: %s)', async pinned => {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const file = path.join(process.env.FREE_ANTIGRAVITY_HOME!, 'pins.json');
  const original = process.env.ANTIGRAVITY_AGENT_PINS;
  try {
    fs.writeFileSync(file, JSON.stringify({ reviewer: { model: 'models/local-reviewer' } }));
    if (pinned) process.env.ANTIGRAVITY_AGENT_PINS = file;
    else delete process.env.ANTIGRAVITY_AGENT_PINS;
    await expect(startProxy((server.address() as AddressInfo).port)).rejects.toThrow(/port/i);
  } finally {
    await stopProxy();
    stopCleanupInterval();
    if (original === undefined) delete process.env.ANTIGRAVITY_AGENT_PINS;
    else process.env.ANTIGRAVITY_AGENT_PINS = original;
    await new Promise(resolve => server.close(resolve));
  }
});
