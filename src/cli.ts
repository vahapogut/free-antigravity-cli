#!/usr/bin/env node
/**
 * Free Antigravity CLI - Open Source Community Edition
 * Supports custom AI models alongside Gemini.
 */
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { loadModels, addModel, removeModel, listModels, getModel, ensureConfigDir, CustomModelEntry } from './config';
import { startProxy, getProxyPort, loadCustomModels, stopProxy } from './proxy';
import { startChat } from './chat';

const program = new Command();

program
  .name('antigravity')
  .description('Free Antigravity CLI - Open Source Community Edition\nSupports OpenAI, Anthropic, Ollama, OpenRouter, Google AI Studio, and custom providers.')
  .version('1.0.0');

// --- Chat command ---

program
  .command('chat')
  .description('Start interactive chat (default command)')
  .argument('[prompt]', 'One-shot prompt (non-interactive)')
  .option('-m, --model <name>', 'Model to use')
  .action(async (prompt?: string, options?: { model?: string }) => {
    if (prompt) {
      // One-shot mode
      console.log(`Sending to ${options?.model || 'default model'}...`);
      await startChat(options?.model);
      // In a full implementation, would send the prompt and exit
      console.log('One-shot mode: Use interactive chat for now.');
    } else {
      await startChat(options?.model);
    }
  });

// --- Models command ---

const modelsCmd = program.command('models').description('Manage custom AI models');

modelsCmd
  .command('list')
  .description('List all configured models')
  .action(() => {
    const models = listModels();
    if (models.length === 0) {
      console.log('No models configured. Use "antigravity models add" to add one.');
      return;
    }
    console.log('\nConfigured Models:');
    console.log('─'.repeat(60));
    for (const m of models) {
      const keyStatus = m.apiKey && m.apiKey !== 'none' ? '🔑' : '🔓';
      console.log(`  ${keyStatus} ${m.displayName || m.name}`);
      console.log(`     Provider: ${m.provider}  |  Model: ${m.externalModelName}`);
      console.log(`     URL: ${m.apiUrl}`);
      console.log();
    }
    console.log(`${models.length} model(s) configured.`);
  });

modelsCmd
  .command('add')
  .description('Add a new custom model (interactive wizard)')
  .action(async () => {
    const inquirer = require('inquirer');

    console.log('\n  Add Custom AI Model\n' + '─'.repeat(40));

    const answers = await inquirer.prompt([
      { type: 'list', name: 'provider', message: 'Provider:', choices: ['openai', 'anthropic', 'google', 'ollama', 'openrouter', 'custom'] },
      { type: 'input', name: 'modelId', message: 'Model ID (e.g. gpt-4o):', validate: (v: string) => v.length > 0 },
      { type: 'input', name: 'displayName', message: 'Display name (optional):' },
      { type: 'password', name: 'apiKey', message: 'API Key:', mask: '*' },
      { type: 'input', name: 'apiUrl', message: 'API URL:', default: (ans: any) => {
        const defaults: Record<string, string> = { openai: 'https://api.openai.com/v1/chat/completions', anthropic: 'https://api.anthropic.com/v1/messages', ollama: 'http://localhost:11434/v1/chat/completions', openrouter: 'https://openrouter.ai/api/v1/chat/completions', custom: 'https://api.together.xyz/v1' };
        return ans.provider === 'google' ? `https://generativelanguage.googleapis.com/v1beta/models/${ans.modelId}:generateContent` : (defaults[ans.provider] || '');
      }},
    ]);

    const entry: CustomModelEntry = {
      name: 'models/' + answers.modelId,
      displayName: answers.displayName || answers.modelId,
      description: `${answers.displayName || answers.modelId} custom model via Free Antigravity CLI`,
      provider: answers.provider,
      apiKey: answers.apiKey || 'none',
      apiUrl: answers.apiUrl,
      externalModelName: answers.modelId,
    };

    const result = addModel(entry);
    if (result.success) {
      console.log(`\n  Model "${entry.displayName}" added successfully!`);
      console.log('  Restart the proxy or chat to use it.\n');
    } else {
      console.error(`\n  Failed: ${result.error}\n`);
    }
  });

modelsCmd
  .command('remove')
  .description('Remove a model')
  .argument('<name>', 'Model name or display name')
  .action((name: string) => {
    const result = removeModel(name);
    if (result.success) console.log(`Model "${name}" removed.`);
    else console.error(`Failed: ${result.error}`);
  });

modelsCmd
  .command('import')
  .description('Import models from Antigravity desktop custom_models.json')
  .action(() => {
    const desktopPath = path.join(require('os').homedir(), '.gemini', 'antigravity', 'custom_models.json');
    if (!fs.existsSync(desktopPath)) {
      console.log('Desktop custom_models.json not found at:', desktopPath);
      return;
    }
    try {
      const content = fs.readFileSync(desktopPath, 'utf-8');
      const parsed = JSON.parse(content);
      const models = parsed.models || [];
      if (models.length === 0) { console.log('No models in desktop config.'); return; }

      ensureConfigDir();
      // Decrypt desktop keys using the crypto module
      const { decryptString } = require('./crypto');
      const imported: CustomModelEntry[] = [];
      for (const m of models) {
        let apiKey = m.apiKey || 'none';
        if (m.encrypted && apiKey !== 'none') {
          try { apiKey = decryptString(apiKey); } catch { /* keep as-is */ }
        }
        imported.push({
          name: m.name, displayName: m.displayName, description: m.description,
          provider: m.provider, apiKey, apiUrl: m.apiUrl,
          externalModelName: m.externalModelName, allowUnauthorized: m.allowUnauthorized,
        });
      }
      // Save all
      const { saveModels } = require('./config');
      saveModels(imported);
      console.log(`Imported ${imported.length} model(s) from desktop Antigravity.`);
      for (const m of imported) console.log(`  - ${m.displayName} (${m.provider})`);
    } catch (e) { console.error('Import failed:', e); }
  });

// --- Proxy command ---

program
  .command('proxy')
  .description('Start the proxy server (for IDE integration)')
  .action(async () => {
    try {
      const port = await startProxy();
      console.log(`Proxy running on http://127.0.0.1:${port}`);
      console.log('Press Ctrl+C to stop.');
      // Keep alive
      process.on('SIGINT', async () => { await stopProxy(); process.exit(0); });
    } catch (e) { console.error('Failed to start proxy:', e); }
  });

// --- Configure command ---

program
  .command('configure')
  .description('Show configuration info')
  .action(() => {
    const configPath = (require('./config') as typeof import('./config')).getModelsPath();
    console.log('Free Antigravity CLI Configuration');
    console.log('─'.repeat(40));
    console.log(`Models file: ${configPath}`);
    console.log(`Models: ${listModels().length} configured`);
    console.log(`Proxy port: ${getProxyPort() || 'not running'}`);
  });

// Default: chat if no command
program.action(() => {
  startChat();
});

program.parse(process.argv);
