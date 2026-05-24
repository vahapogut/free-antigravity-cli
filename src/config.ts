/**
 * Configuration and model storage management.
 * Stores custom models in ~/.free-antigravity/models.json
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { encryptString, decryptString } from './crypto';

export interface CustomModelEntry {
  name: string;
  displayName?: string;
  description?: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  timeout?: number;
  maxRetries?: number;
}

export function getConfigDir(): string {
  return path.join(os.homedir(), '.free-antigravity');
}

export function getModelsPath(): string {
  return path.join(getConfigDir(), 'models.json');
}

export function ensureConfigDir(): void {
  const dir = getConfigDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadModels(): CustomModelEntry[] {
  const filePath = getModelsPath();
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as { models?: CustomModelEntry[] };
    const models = parsed.models || [];

    return models.map((m) => {
      if (m.encrypted && m.apiKey && m.apiKey !== 'none') {
        try { return { ...m, apiKey: decryptString(m.apiKey), encrypted: false }; }
        catch { return m; }
      }
      return m;
    });
  } catch (e) {
    console.error('Failed to load models:', e);
    return [];
  }
}

export function saveModels(models: CustomModelEntry[]): void {
  ensureConfigDir();
  const encrypted = models.map((m) => {
    if (m.apiKey && m.apiKey !== 'none' && !m.encrypted) {
      return { ...m, apiKey: encryptString(m.apiKey), encrypted: true };
    }
    return m;
  });
  fs.writeFileSync(getModelsPath(), JSON.stringify({ models: encrypted }, null, 2), 'utf-8');
}

export function addModel(model: CustomModelEntry): { success: boolean; error?: string } {
  const models = loadModels();
  const existingIdx = models.findIndex((m) => m.name === model.name);

  if (existingIdx !== -1) {
    if (model.apiKey && (model.apiKey.includes('...') || model.apiKey.startsWith('***'))) {
      model.apiKey = models[existingIdx].apiKey;
    }
    models[existingIdx] = model;
  } else {
    models.push(model);
  }

  saveModels(models);
  return { success: true };
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
