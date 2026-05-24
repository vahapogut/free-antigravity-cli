#!/usr/bin/env node
/**
 * Free Antigravity CLI - Community Edition
 * Wraps the official agy CLI with custom model support via a local proxy.
 */
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { addModel, removeModel, listModels, ensureConfigDir, CustomModelEntry } from './config';
import { startProxy, getProxyPort, stopProxy } from './proxy';
import { backupFile } from './crypto';

function searchInPath(): string | null {
  try {
    const cmd = os.platform() === 'win32' ? 'where agy' : 'which agy';
    const out = execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\r\n')[0].split('\n')[0];
    if (out && fs.existsSync(out)) return out;
  } catch { /* ignore */ }
  return null;
}

function getAgyBin(): string {
  // 1. User Override
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) {
    return process.env.AGY_BIN;
  }

  // 2. PATH Search
  const pathBin = searchInPath();
  if (pathBin) return pathBin;

  // 3. OS-specific defaults
  const isWin = os.platform() === 'win32';
  const binName = isWin ? 'agy.exe' : 'agy';
  const locations = [
    // Windows default
    path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', binName),
    // macOS default Application Support
    path.join(os.homedir(), 'Library', 'Application Support', 'agy', 'bin', binName),
    // macOS/Linux local share
    path.join(os.homedir(), '.local', 'share', 'agy', 'bin', binName),
    // macOS/Linux local bin fallback
    path.join(os.homedir(), '.local', 'bin', binName),
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc;
  }

  // 4. Default fallback based on platform
  if (isWin) {
    return path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
  }
  return path.join(os.homedir(), '.local', 'share', 'agy', 'bin', 'agy');
}

async function ensureProxy(): Promise<number> {
  try { return await startProxy(); }
  catch { return getProxyPort() || 50998; }
}

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || '1.0.4';
    }
  } catch { /* ignore */ }
  return '1.0.4';
}

function ensureAgyPatched(binPath: string): void {
  if (!fs.existsSync(binPath)) return;
  try {
    const buf = fs.readFileSync(binPath);
    const original = Buffer.from('https://daily-cloudcode-pa.googleapis.com');
    const newPatch = Buffer.from('http://localhost:50998/v1internal/xxxxxxx');
    const oldPatch = Buffer.from('http://localhost:50999/v1internal/xxxxxxx');
    const backup = Buffer.from('https://daily-cloudcode-pa.googleapis.com');

    // Already up to date
    if (buf.includes(newPatch)) return;

    let patched = false;

    // Upgrade old patch (50999 → 50998)
    const oldIdx = buf.indexOf(oldPatch);
    if (oldIdx !== -1) {
      backupFile(binPath);
      newPatch.copy(buf, oldIdx);
      patched = true;
      console.log('[ok] agy binary patch upgraded (50999 → 50998).');
    }

    // Fresh patch (original Google URL → 50998)
    if (!patched) {
      const origIdx = buf.indexOf(original);
      if (origIdx !== -1) {
        backupFile(binPath);
        newPatch.copy(buf, origIdx);
        patched = true;
        console.log('[ok] agy binary patched for custom model support.');
      }
    }

    if (patched) {
      fs.writeFileSync(binPath, buf);
      // macOS adjustments
      if (os.platform() === 'darwin') {
        try {
          execSync(`codesign --force --sign - "${binPath}"`, { stdio: 'ignore' });
          execSync(`xattr -d com.apple.quarantine "${binPath}"`, { stdio: 'ignore' });
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

async function startAndDelegate(agyArgs: string[]): Promise<void> {
  // agy starts interactive mode by default when no flags are given
  const agyBin = getAgyBin();

  if (!fs.existsSync(agyBin)) {
    console.error(`\n[Error] agy CLI not found!`);
    console.error(`Search location checked: ${agyBin}`);
    console.error('\nPlease install the official Antigravity CLI first.');
    console.error('If installed in a custom location, set the AGY_BIN environment variable:');
    console.error('  export AGY_BIN=/path/to/agy\n');
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
  let args = process.argv.slice(2);

  // Parse and strip verbose/debug flags
  const isDebug = args.includes('--verbose') || args.includes('--debug') || process.env.ANTIGRAVITY_DEBUG === 'true';
  if (isDebug) {
    process.env.ANTIGRAVITY_DEBUG = 'true';
  }
  args = args.filter(a => a !== '--verbose' && a !== '--debug');

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
    console.log(`Free Antigravity CLI v${getVersion()} (Community Edition)`);
    return;
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`Free Antigravity CLI v${getVersion()} - Community Edition
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
