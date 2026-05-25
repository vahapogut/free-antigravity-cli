#!/usr/bin/env node
/**
 * Free Antigravity CLI - Community Edition
 * Wraps the official agy CLI with custom model support via a local proxy.
 */
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import inquirer from 'inquirer';
import { addModel, removeModel, listModels, ensureConfigDir, saveModels, CustomModelEntry } from './config';
import { startProxy, getProxyPort, stopProxy } from './proxy';
import { backupFile, decryptString } from './crypto';

function searchInPath(): string | null {
  try {
    const cmd = os.platform() === 'win32' ? 'where agy' : 'which agy';
    const out = execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\r\n')[0].split('\n')[0];
    if (out && fs.existsSync(out)) return out;
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.debug('[Debug] searchInPath failed:', (e as Error).message);
    }
  }
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
  catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.warn('[Warn] startProxy failed, using cached port:', (e as Error).message);
    }
    return getProxyPort() || 50998;
  }
}

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || '1.0.4';
    }
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.debug('[Debug] getVersion failed:', (e as Error).message);
    }
  }
  return '1.0.4';
}

function patchUrl(buf: Buffer, original: string, replacement: string): boolean {
  const origBuf = Buffer.from(original);
  const replBuf = Buffer.from(replacement);
  const idx = buf.indexOf(origBuf);
  if (idx === -1) return false;
  if (replBuf.length !== origBuf.length) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.warn(`[Warn] URL length mismatch: cannot patch "${original}" (len=${original.length}) → "${replacement}" (len=${replacement.length})`);
    }
    return false;
  }
  replBuf.copy(buf, idx);
  return true;
}

function ensureAgyPatched(binPath: string): void {
  if (!fs.existsSync(binPath)) return;
  try {
    const buf = fs.readFileSync(binPath);
    const targets = [
      { orig: 'https://daily-cloudcode-pa.googleapis.com', repl: 'http://localhost:50998/v1internal/xxxxxxx' },
      { orig: 'https://cloudcode-pa.googleapis.com',         repl: 'http://localhost:50998/v1internal/x' },
    ];

    // Check if already fully patched
    if (targets.every((t) => buf.includes(Buffer.from(t.repl)))) return;

    // Check for old patches to upgrade
    const oldPatches = [
      { old: 'http://localhost:50999/v1internal/xxxxxxx', newP: 'http://localhost:50998/v1internal/xxxxxxx' },
    ];
    let upgraded = false;
    for (const op of oldPatches) {
      const oldBuf = Buffer.from(op.old);
      const newBuf = Buffer.from(op.newP);
      const oi = buf.indexOf(oldBuf);
      if (oi !== -1 && newBuf.length === oldBuf.length) {
        backupFile(binPath);
        newBuf.copy(buf, oi);
        upgraded = true;
      }
    }
    if (upgraded) console.log('[ok] agy binary patch upgraded (50999 → 50998).');

    // Apply fresh patches
    let patched = false;
    for (const t of targets) {
      if (buf.includes(Buffer.from(t.repl))) continue;
      if (patchUrl(buf, t.orig, t.repl)) patched = true;
    }

    if (patched || upgraded) {
      if (!upgraded) backupFile(binPath);
      fs.writeFileSync(binPath, buf);
      if (!upgraded) console.log('[ok] agy binary patched for custom model support.');
      if (os.platform() === 'darwin') {
        try {
          execSync(`codesign --force --sign - "${binPath}"`, { stdio: 'ignore' });
          execSync(`xattr -d com.apple.quarantine "${binPath}"`, { stdio: 'ignore' });
        } catch { /* macOS code signing not available */ }
      }
    }
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.warn('[Warn] agy binary patching failed:', e);
    }
  }
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
      console.log('\n  Add Custom AI Model\n' + '─'.repeat(40));
      const answers = await inquirer.prompt([
        { type: 'list', name: 'provider', message: 'Provider:', choices: [
          'openai', 'anthropic', 'google', 'ollama', 'openrouter', 'custom',
          'deepseek', 'groq', 'mistral', 'cerebras', 'kimi', 'fireworks',
          'lmstudio', 'llamacpp', 'nvidia'
        ] },
        { type: 'input', name: 'modelId', message: 'Model ID (e.g. gpt-4o):', validate: (v: string) => v.length > 0 },
        { type: 'input', name: 'displayName', message: 'Display name:' },
        { type: 'password', name: 'apiKey', message: 'API Key:', mask: '*' },
        { type: 'input', name: 'apiUrl', message: 'API URL:', default: (a: any) => {
          const d: Record<string, string> = {
            openai: 'https://api.openai.com/v1/chat/completions',
            anthropic: 'https://api.anthropic.com/v1/messages',
            google: `https://generativelanguage.googleapis.com/v1beta/models/${a.modelId}:generateContent`,
            ollama: 'http://localhost:11434/v1/chat/completions',
            openrouter: 'https://openrouter.ai/api/v1/chat/completions',
            custom: 'https://api.together.xyz/v1',
            deepseek: 'https://api.deepseek.com/anthropic',
            groq: 'https://api.groq.com/openai/v1',
            mistral: 'https://api.mistral.ai/v1',
            cerebras: 'https://api.cerebras.ai/v1',
            kimi: 'https://api.moonshot.ai/anthropic/v1',
            fireworks: 'https://api.fireworks.ai/inference/v1',
            lmstudio: 'http://localhost:1234/v1',
            llamacpp: 'http://localhost:8080/v1',
            nvidia: 'https://integrate.api.nvidia.com/v1',
          };
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
        const imported: CustomModelEntry[] = [];
        for (const m of models) {
          let key = m.apiKey || 'none';
          if (m.encrypted && key !== 'none') {
            try { key = decryptString(key); }
            catch (e2) {
              if (process.env.ANTIGRAVITY_DEBUG === 'true') {
                console.debug('[Debug] decryptString failed for model:', m.name, (e2 as Error).message);
              }
            }
          }
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
