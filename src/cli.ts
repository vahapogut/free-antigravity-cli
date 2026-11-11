#!/usr/bin/env node
/**
 * Free Antigravity CLI - Community Edition
 * Wraps the official agy CLI with custom model support via a local proxy.
 */
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import inquirer from 'inquirer';
import { addModel, removeModel, listModels, saveModels, fromDesktopModels, getModelsPath, CustomModelEntry } from './config';
import { startProxy, getProxyPort, stopProxy } from './proxy';
import { checkAgyCompatibility } from './manifest';
import { launchAgy, readAgyVersion } from './agy';
import { ensureAgyPatched, restoreAgy } from './agyPatch';
import { routeCommand, ModelsSubcommand } from './commands';

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

  const version = readAgyVersion(agyBin);
  if (version) {
    await checkAgyCompatibility(version);
  }

  const patch = ensureAgyPatched(agyBin);
  if (patch.status === 'patched') {
    console.log('[ok] agy binary patched for custom model support.');
    console.log('     While it is patched, start agy through "antigravity". "antigravity restore" undoes the patch.');
  } else if (patch.status === 'failed' || patch.status === 'unsupported') {
    console.error(`[Error] ${patch.message}`);
  }

  process.stdout.write('Starting proxy... ');
  const port = await ensureProxy();
  console.log(`ready (port ${port})\n`);

  const child = launchAgy(agyBin, agyArgs);
  child.on('error', async (error) => {
    console.error(`[Error] Could not start agy: ${error.message}`);
    await stopProxy();
    process.exit(1);
  });
  child.on('exit', async (code) => { await stopProxy(); process.exit(code || 0); });
  process.on('SIGINT', async () => { child.kill(); await stopProxy(); process.exit(0); });
}

const MODELS_USAGE = 'Usage: antigravity custom-models <list|add|remove|import>';

async function manageModels(sub: ModelsSubcommand, rest: string[]): Promise<void> {
  if (sub === 'list') {
    const models = listModels();
    if (models.length === 0) { console.log('No models. Use "antigravity custom-models add".'); return; }
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
    const name = rest[0];
    if (!name) { console.log('Usage: antigravity custom-models remove <name>'); return; }
    removeModel(name);
    console.log(`Model "${name}" removed.`);
    return;
  }

  // sub === 'import'
  const desktopPath = path.join(os.homedir(), '.gemini', 'antigravity', 'custom_models.json');
  if (!fs.existsSync(desktopPath)) { console.log('Desktop Antigravity models not found.\nUse "antigravity custom-models add" instead.'); return; }
  try {
    const models = (JSON.parse(fs.readFileSync(desktopPath, 'utf-8')) as { models?: any[] }).models || [];
    if (models.length === 0) { console.log('No models in desktop config.'); return; }
    const { models: imported, needKey } = fromDesktopModels(models as CustomModelEntry[]);
    saveModels(imported);
    console.log(`Imported ${imported.length} model(s).`);
    if (needKey.length > 0) {
      console.log('The desktop app encrypts these keys for itself, so they could not be copied.');
      console.log(`Enter the API key again with "antigravity custom-models add" for: ${needKey.join(', ')}`);
    }
  } catch (e) { console.error('Import failed:', (e as Error).message); }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // --verbose / --debug belong to the wrapper; arguments after "--" are agy's and stay as they are.
  const separator = argv.indexOf('--');
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator);
  const isDebug = own.includes('--verbose') || own.includes('--debug') || process.env.ANTIGRAVITY_DEBUG === 'true';
  if (isDebug) {
    process.env.ANTIGRAVITY_DEBUG = 'true';
  }
  const args = [...own.filter(a => a !== '--verbose' && a !== '--debug'), ...passthrough];

  const route = routeCommand(args);

  if (route.kind === 'models') {
    await manageModels(route.sub, route.rest);
    return;
  }

  if (route.kind === 'models-usage') {
    console.log(MODELS_USAGE);
    return;
  }

  if (route.kind === 'configure') {
    console.log(`Models file: ${getModelsPath()}`);
    console.log(`Models configured: ${listModels().length}`);
    console.log(`Proxy: ${getProxyPort() ? `port ${getProxyPort()}` : 'not running'}`);
    console.log(`agy binary: ${getAgyBin()}`);
    return;
  }

  if (route.kind === 'restore') {
    const result = restoreAgy(getAgyBin());
    if (result.status === 'restored') console.log(`agy was restored from ${result.backup}.`);
    else if (result.status === 'not-patched') console.log('agy is not patched; there is nothing to restore.');
    else { console.error(`[Error] ${result.message}`); process.exitCode = 1; }
    return;
  }

  if (route.kind === 'version') {
    console.log(`Free Antigravity CLI v${getVersion()} (Community Edition)`);
    return;
  }

  if (route.kind === 'help') {
    console.log(`Free Antigravity CLI v${getVersion()} - Community Edition
Wraps the official agy CLI with custom model support.

Commands:
  (no args)                   Start interactive chat with custom model support
  chat                        Same as above
  custom-models list          List custom models
  custom-models add           Add a custom model
  custom-models remove <name> Remove a custom model
  custom-models import        Import models from desktop Antigravity
  restore                     Put the original agy binary back
  configure                   Show configuration
  version                     Show version
  help                        This help

"models list|add|remove|import" still works as the older name for custom-models.
Any other arguments are passed directly to agy, including "models".
Use "--" to pass an argument that the wrapper would otherwise handle:
  antigravity -- --help`);
    return;
  }

  await startAndDelegate(route.args);
}

main().catch((error) => {
  console.error(error instanceof Error ? `[Error] ${error.message}` : error);
  process.exitCode = 1;
});
