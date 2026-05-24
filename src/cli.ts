#!/usr/bin/env node
/**
 * Free Antigravity CLI - Community Edition
 * Wraps the official agy CLI with custom model support via a local proxy.
 */
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { addModel, removeModel, listModels, ensureConfigDir, CustomModelEntry } from './config';
import { startProxy, getProxyPort, stopProxy } from './proxy';

function getAgyBin(): string {
  const locations = [
    path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc;
  }
  return path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
}

async function ensureProxy(): Promise<number> {
  try { return await startProxy(); }
  catch { return getProxyPort() || 50999; }
}

function ensureAgyPatched(binPath: string): void {
  if (!fs.existsSync(binPath)) return;
  try {
    const buf = fs.readFileSync(binPath);
    const original = Buffer.from('https://daily-cloudcode-pa.googleapis.com');
    const replacement = Buffer.from('http://localhost:50999/v1internal/xxxxxxx');
    if (buf.includes(replacement)) return;
    const idx = buf.indexOf(original);
    if (idx === -1) return;
    replacement.copy(buf, idx);
    fs.writeFileSync(binPath, buf);
    console.log('[ok] agy binary patched for custom model support.');
  } catch { /* ignore */ }
}

async function startAndDelegate(agyArgs: string[]): Promise<void> {
  // agy starts interactive mode by default when no flags are given
  const agyBin = getAgyBin();

  if (!fs.existsSync(agyBin)) {
    console.error(`\nagy CLI not found at: ${agyBin}`);
    console.error('Install: curl -fsSL https://antigravity.google/cli/install.cmd | cmd');
    process.exit(1);
  }

  ensureAgyPatched(agyBin);
  process.stdout.write('Starting proxy... ');
  const port = await ensureProxy();
  console.log(`ready (port ${port})\n`);

  const child = spawn(agyBin, agyArgs, { stdio: 'inherit', shell: true });
  child.on('exit', async (code) => { await stopProxy(); process.exit(code || 0); });
  process.on('SIGINT', async () => { child.kill(); await stopProxy(); process.exit(0); });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  // --- Model management ---
  if (cmd === 'models') {
    const sub = args[1];

    if (sub === 'list') {
      const models = listModels();
      if (models.length === 0) { console.log('No models. Use "antigravity models add".'); return; }
      console.log('\nCustom Models:\n' + '='.repeat(50));
      for (const m of models) {
        console.log(`  ${m.displayName || m.name}`);
        console.log(`  Provider: ${m.provider}  |  Model: ${m.externalModelName}`);
        console.log(`  URL: ${m.apiUrl}\n`);
      }
      return;
    }

    if (sub === 'add') {
      const inquirer = require('inquirer');
      console.log('\n  Add Custom AI Model\n' + '─'.repeat(40));
      const answers = await inquirer.prompt([
        { type: 'list', name: 'provider', message: 'Provider:', choices: ['openai', 'anthropic', 'google', 'ollama', 'openrouter', 'custom'] },
        { type: 'input', name: 'modelId', message: 'Model ID (e.g. gpt-4o):', validate: (v: string) => v.length > 0 },
        { type: 'input', name: 'displayName', message: 'Display name:' },
        { type: 'password', name: 'apiKey', message: 'API Key:', mask: '*' },
        { type: 'input', name: 'apiUrl', message: 'API URL:', default: (a: any) => {
          const d: Record<string, string> = { openai: 'https://api.openai.com/v1/chat/completions', anthropic: 'https://api.anthropic.com/v1/messages', ollama: 'http://localhost:11434/v1/chat/completions', openrouter: 'https://openrouter.ai/api/v1/chat/completions', custom: 'https://api.together.xyz/v1', google: `https://generativelanguage.googleapis.com/v1beta/models/${a.modelId}:generateContent` };
          return d[a.provider] || '';
        }},
      ]);
      const r = addModel({ name: 'models/' + answers.modelId, displayName: answers.displayName || answers.modelId, description: '', provider: answers.provider, apiKey: answers.apiKey || 'none', apiUrl: answers.apiUrl, externalModelName: answers.modelId });
      console.log(r.success ? `\nModel "${answers.displayName || answers.modelId}" added!\n` : `\nFailed: ${r.error}\n`);
      return;
    }

    if (sub === 'remove') {
      const name = args[2];
      if (!name) { console.log('Usage: antigravity models remove <name>'); return; }
      removeModel(name);
      console.log(`Model "${name}" removed.`);
      return;
    }

    if (sub === 'import') {
      const desktopPath = path.join(os.homedir(), '.gemini', 'antigravity', 'custom_models.json');
      if (!fs.existsSync(desktopPath)) { console.log('Desktop Antigravity models not found.\nUse "antigravity models add" instead.'); return; }
      try {
        const models = (JSON.parse(fs.readFileSync(desktopPath, 'utf-8')) as { models?: any[] }).models || [];
        if (models.length === 0) { console.log('No models in desktop config.'); return; }
        ensureConfigDir();
        const { decryptString } = require('./crypto');
        const { saveModels } = require('./config');
        const imported: CustomModelEntry[] = [];
        for (const m of models) {
          let key = m.apiKey || 'none';
          if (m.encrypted && key !== 'none') { try { key = decryptString(key); } catch { /* keep */ } }
          imported.push({ name: m.name, displayName: m.displayName, description: m.description, provider: m.provider, apiKey: key, apiUrl: m.apiUrl, externalModelName: m.externalModelName, allowUnauthorized: m.allowUnauthorized });
        }
        saveModels(imported);
        console.log(`Imported ${imported.length} model(s). NOTE: API keys from desktop need to be re-entered via "antigravity models add".`);
      } catch (e) { console.error('Import failed:', e); }
      return;
    }

    console.log('Usage: antigravity models <list|add|remove|import>');
    return;
  }

  // --- Info commands ---
  if (cmd === 'configure') {
    console.log(`Models file: ${path.join(os.homedir(), '.free-antigravity', 'models.json')}`);
    console.log(`Models configured: ${listModels().length}`);
    console.log(`Proxy: ${getProxyPort() ? `port ${getProxyPort()}` : 'not running'}`);
    console.log(`agy binary: ${getAgyBin()}`);
    return;
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-V' || cmd === '-v') {
    console.log('Free Antigravity CLI v1.0.0 (Community Edition)');
    return;
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`Free Antigravity CLI v1.0.0 - Community Edition
Wraps the official agy CLI with custom model support.

Commands:
  (no args)    Start interactive chat with custom model support
  chat         Same as above
  models list  List custom models
  models add   Add a custom model
  models remove <name>  Remove a custom model
  models import  Import models from desktop Antigravity
  configure    Show configuration
  version      Show version
  help         This help

Any other arguments are passed directly to agy CLI.`);
    return;
  }

  // --- Default: delegate to agy with proxy ---
  if (cmd === 'chat') args.shift();
  await startAndDelegate(args);
}

main().catch(console.error);
