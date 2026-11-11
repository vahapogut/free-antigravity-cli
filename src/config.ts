/**
 * Configuration and model storage management.
 * Stores custom models in ~/.free-antigravity/models.json
 */
import * as fs from 'fs';
import { encryptString, decryptString, needsProtection } from './crypto';
import { getConfigDir, getModelsPath } from './paths';

export { getConfigDir, getModelsPath };

export interface CustomModelEntry {
  name: string;
  displayName?: string;
  description?: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  /** In memory: true only for a record whose stored key could not be read. */
  encrypted?: boolean;
  timeout?: number;
  maxRetries?: number;
}

export function ensureConfigDir(): void {
  fs.mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
}

/** Replaces the models file in one step; the file is readable only by its owner. */
function writeModelsFile(models: CustomModelEntry[]): void {
  ensureConfigDir();
  const filePath = getModelsPath();
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ models }, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function protect(models: CustomModelEntry[]): CustomModelEntry[] {
  return models.map((m) =>
    m.apiKey && m.apiKey !== 'none' && !m.encrypted ? { ...m, apiKey: encryptString(m.apiKey), encrypted: true } : m,
  );
}

/**
 * Returns the saved models with their keys in clear.
 * A key stored in clear or in a format of an earlier release is re-encrypted on the way.
 * A record whose key cannot be read is returned untouched with `encrypted: true`, so saving the
 * list again does not destroy it.
 */
export function loadModels(): CustomModelEntry[] {
  let stored: CustomModelEntry[];
  try {
    const parsed = JSON.parse(fs.readFileSync(getModelsPath(), 'utf-8')) as { models?: CustomModelEntry[] };
    stored = Array.isArray(parsed.models) ? parsed.models : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Failed to load models:', (e as Error).message);
    return [];
  }

  let outdated = false;
  const models = stored.map((m) => {
    if (!m.apiKey || m.apiKey === 'none') return { ...m, encrypted: false };
    const key = decryptString(m.apiKey);
    if (key === 'DECRYPTION_FAILED') return { ...m, encrypted: true };
    if (needsProtection(m.apiKey)) outdated = true;
    return { ...m, apiKey: key, encrypted: false };
  });

  if (outdated) {
    try {
      writeModelsFile(protect(models));
    } catch (e) {
      console.warn('[Warn] Could not re-encrypt saved API keys:', (e as Error).message);
    }
  }
  return models;
}

export function saveModels(models: CustomModelEntry[]): void {
  writeModelsFile(protect(models));
}

export function addModel(model: CustomModelEntry): { success: boolean; error?: string } {
  const models = loadModels();
  const existingIdx = models.findIndex((m) => m.name === model.name);

  if (existingIdx !== -1) {
    if (model.apiKey && (model.apiKey.includes('...') || model.apiKey.startsWith('***'))) {
      model.apiKey = models[existingIdx].apiKey;
      model.encrypted = models[existingIdx].encrypted;
    }
    models[existingIdx] = model;
  } else {
    models.push(model);
  }

  try {
    saveModels(models);
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
  return { success: true };
}

/**
 * Converts records from the desktop app's custom_models.json.
 * Keys the desktop app encrypted are tied to that app and cannot be read here, so those models are
 * imported without a key and reported in `needKey`.
 */
export function fromDesktopModels(desktopModels: CustomModelEntry[]): { models: CustomModelEntry[]; needKey: string[] } {
  const needKey: string[] = [];
  const models = desktopModels.map((m) => {
    let apiKey = m.apiKey || 'none';
    if (m.encrypted && apiKey !== 'none') {
      apiKey = 'none';
      needKey.push(m.displayName || m.name);
    }
    return {
      name: m.name,
      displayName: m.displayName,
      description: m.description,
      provider: m.provider,
      apiKey,
      apiUrl: m.apiUrl,
      externalModelName: m.externalModelName,
      allowUnauthorized: m.allowUnauthorized,
    };
  });
  return { models, needKey };
}

export function removeModel(modelName: string): { success: boolean; error?: string } {
  const models = loadModels().filter((m) => m.name !== modelName);
  saveModels(models);
  return { success: true };
}

export function getModel(modelName: string): CustomModelEntry | undefined {
  return loadModels().find((m) => m.name === modelName || m.displayName === modelName);
}

export function listModels(): CustomModelEntry[] {
  return loadModels();
}
