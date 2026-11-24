#!/usr/bin/env node
/**
 * Free Antigravity CLI - Community Edition
 * Wraps the official agy CLI with custom model support via a local proxy.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import inquirer from 'inquirer';
import { addModel, removeModel, listModels, saveModels, fromDesktopModels, getModelsPath, CustomModelEntry } from './config';
import { startProxy, getProxyPort, stopProxy } from './proxy';
import { checkAgyCompatibility } from './manifest';
import { launchAgy, readAgyVersion, locateAgy } from './agy';
import { ensureAgyPatched, restoreAgy } from './agyPatch';
import { routeCommand, ModelsSubcommand } from './commands';

/** The agy binary to use, or null after printing why there is none to use. */
function getAgyBin(): string | null {
  const location = locateAgy();
  if ('error' in location) {
    console.error(`[Error] ${location.error}`);
    process.exitCode = 1;
    return null;
  }
  return location.path;
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
  if (agyBin === null) return;

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

  // From here on stdout belongs to agy: it has machine-readable modes (--output-format json,
  // stream-json, the acp server). What the wrapper says itself goes to stderr.
  const patch = ensureAgyPatched(agyBin);
  if (patch.status === 'patched') {
    console.error('[ok] agy binary patched for custom model support.');
    console.error('     While it is patched, start agy through "antigravity". "antigravity restore" undoes the patch.');
  } else if (patch.status === 'failed' || patch.status === 'unsupported') {
    if (process.env.ANTIGRAVITY_AGENT_PINS) throw Error('Cannot enforce agent pins: agy could not be patched.');
    console.error(`[Error] ${patch.message}`);
  }

  // The patched binary targets one fixed port; do not launch it until this
  // process owns that listener, even when this session has no agent pins.
  const port = await startProxy();
  console.error(`Starting proxy... ready (port ${port})\n`);

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
    const location = locateAgy();
    console.log(`agy binary: ${'error' in location ? `none (${location.error})` : location.path}`);
    return;
  }

  if (route.kind === 'restore') {
    const agyBin = getAgyBin();
    if (agyBin === null) return;
    const result = restoreAgy(agyBin);
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
