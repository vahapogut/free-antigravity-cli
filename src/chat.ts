/**
 * Interactive chat REPL - streaming AI chat in the terminal.
 */
import * as readline from 'readline';
import * as http from 'http';
import { startProxy, getProxyPort, loadCustomModels, generateModelPlaceholderId, toSlug, CustomModel } from './proxy';
import { loadModels, CustomModelEntry } from './config';

function toProxyModel(m: CustomModelEntry): CustomModel {
  return { ...m, displayName: m.displayName || m.name, description: m.description || '', _slug: undefined };
}

async function getModels(): Promise<string[]> {
  const custom = loadModels();
  return custom.map((m) => m.displayName || m.name);
}

async function selectModel(): Promise<string> {
  const models = await getModels();
  console.log('\nAvailable models:');
  models.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
  console.log('  0. Enter model name manually');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('\nSelect model (number): ', (answer) => {
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx >= 0 && idx < models.length) resolve(models[idx]);
      else resolve('');
    });
  });
}

export async function startChat(model?: string): Promise<void> {
  // Start proxy
  let proxyPort: number;
  try { proxyPort = await startProxy(); }
  catch { console.error('Failed to start proxy. Is port 50999 in use?'); process.exit(1); }

  console.log(`
  ╔══════════════════════════════════════╗
  ║   Free Antigravity CLI v1.0.0      ║
  ║   Community Edition                 ║
  ╚══════════════════════════════════════╝
  Proxy: http://127.0.0.1:${proxyPort}
  `);

  if (!model) model = await selectModel();
  if (!model) { console.log('No model selected. Exiting.'); process.exit(0); }

  const customModels = loadModels();
  const selectedEntry = customModels.find((m) => (m.displayName || m.name) === model);
  if (!selectedEntry) {
    console.log(`Model "${model}" not configured. Use "antigravity models add" first.`);
    process.exit(1);
  }

  const selectedModel = toProxyModel(selectedEntry);
  console.log(`Using: ${selectedModel.displayName} (${selectedModel.provider})`);
  console.log('Type /help for commands, /quit to exit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n> ' });

  let conversationHistory: { role: string; parts: { text?: string }[] }[] = [];

  rl.on('line', async (line) => {
    const input = line.trim();

    if (input === '/quit' || input === '/exit') {
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    }

    if (input === '/help') {
      console.log('Commands: /quit, /help, /clear (clear history), /model (switch model)');
      rl.prompt();
      return;
    }

    if (input === '/clear') {
      conversationHistory = [];
      console.log('Conversation cleared.');
      rl.prompt();
      return;
    }

    if (input === '/model') {
      const newModel = await selectModel();
      if (newModel) {
        const m = customModels.find((x) => (x.displayName || x.name) === newModel);
        if (m) { console.log(`Switched to ${m.displayName}`); }
      }
      rl.prompt();
      return;
    }

    if (!input) { rl.prompt(); return; }

    // Build Gemini request
    const geminiBody = {
      model: selectedModel.name,
      contents: [
        ...conversationHistory,
        { role: 'user', parts: [{ text: input }] },
      ],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    };

    // Send to proxy
    const placeholderId = generateModelPlaceholderId(selectedModel);
    const slug = toSlug(selectedModel);

    const postData = JSON.stringify({
      request: geminiBody,
      model: slug,
      project: 'free-antigravity-cli',
      requestId: Date.now().toString(),
      requestType: 'CHAT',
    });

    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: proxyPort,
      path: '/v1internal:streamGenerateContent?alt=sse',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Accept': 'text/event-stream',
      },
    };

    const req = http.request(options, (res) => {
      let buffer = '';
      let fullResponse = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(trimmed.substring(6));
            const candidates = data.response?.candidates || [];
            for (const c of candidates) {
              const parts = c.content?.parts || [];
              for (const p of parts) {
                if (p.text && !p.thought) {
                  process.stdout.write(p.text);
                  fullResponse += p.text;
                }
              }
            }
          } catch { /* partial chunk */ }
        }
      });

      res.on('end', () => {
        console.log();
        conversationHistory.push({ role: 'user', parts: [{ text: input }] });
        conversationHistory.push({ role: 'model', parts: [{ text: fullResponse }] });
        // Keep history manageable
        if (conversationHistory.length > 20) conversationHistory = conversationHistory.slice(-20);
        rl.prompt();
      });
    });

    req.on('error', (err) => {
      console.error(`\nConnection error: ${err.message}`);
      console.error('Is the proxy running? Try: antigravity proxy');
      rl.prompt();
    });

    req.write(postData);
    req.end();
  });

  rl.prompt();
}
