/**
 * Saved provider keys: how they are stored, and how values written by earlier releases are upgraded.
 * Every test uses its own temporary configuration directory.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encryptString, decryptString } from '../src/crypto';
import { loadModels, saveModels, getModelsPath, fromDesktopModels, CustomModelEntry } from '../src/config';
import { loadCustomModels } from '../src/proxy';
import { stopCleanupInterval } from '../src/proxy/shared';

const SECRET = 'sk-test-0123456789-secret';
const directories: string[] = [];
const previousHome = process.env.FREE_ANTIGRAVITY_HOME;

function useFreshConfigDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free-agy-store-'));
  directories.push(directory);
  process.env.FREE_ANTIGRAVITY_HOME = directory;
  // Never let a test touch the real configuration directory.
  if (path.dirname(getModelsPath()) !== directory) throw new Error('Tests must run inside a temporary configuration directory');
  return directory;
}

/** The scheme used up to 1.1.5: AES-256-CBC with a key derived from the user name. */
function legacyEncrypt(plain: string): string {
  const key = crypto.createHash('sha256').update(process.env.USERNAME || process.env.USER || 'antigravity-cli').digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return 'enc:' + Buffer.concat([iv, cipher.update(plain, 'utf-8'), cipher.final()]).toString('base64');
}

function model(overrides: Partial<CustomModelEntry> = {}): CustomModelEntry {
  return {
    name: 'models/test-model',
    displayName: 'Test Model',
    description: '',
    provider: 'openai',
    apiKey: SECRET,
    apiUrl: 'https://api.openai.com/v1/chat/completions',
    externalModelName: 'gpt-4o',
    ...overrides,
  };
}

const storedText = () => fs.readFileSync(getModelsPath(), 'utf-8');
const storedModels = () => JSON.parse(storedText()).models as CustomModelEntry[];

beforeEach(() => {
  useFreshConfigDir();
});

afterAll(() => {
  stopCleanupInterval();
  if (previousHome === undefined) delete process.env.FREE_ANTIGRAVITY_HOME;
  else process.env.FREE_ANTIGRAVITY_HOME = previousHome;
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== fs.realpathSync(os.tmpdir()) && path.dirname(directory) !== os.tmpdir()) continue;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('key encryption', () => {
  test('uses a random key file instead of anything derived from the user name', () => {
    const directory = process.env.FREE_ANTIGRAVITY_HOME!;
    const first = encryptString(SECRET);
    const second = encryptString(SECRET);

    expect(first).toMatch(/^local-gcm:/);
    expect(second).not.toBe(first);
    expect(first).not.toContain(SECRET);
    expect(decryptString(first)).toBe(SECRET);

    const keyFile = path.join(directory, '.credentials-key');
    expect(fs.readFileSync(keyFile)).toHaveLength(32);
    if (process.platform !== 'win32') expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);

    // Without the key file the value cannot be recovered, whatever the user name is.
    fs.unlinkSync(keyFile);
    expect(decryptString(first)).toBe('DECRYPTION_FAILED');
  });

  test('detects a modified value', () => {
    const value = encryptString(SECRET);
    const bytes = Buffer.from(value.slice('local-gcm:'.length), 'base64');
    bytes[bytes.length - 1] ^= 1;
    expect(decryptString('local-gcm:' + bytes.toString('base64'))).toBe('DECRYPTION_FAILED');
  });

  test('still reads the two formats written by earlier releases', () => {
    expect(decryptString(legacyEncrypt(SECRET))).toBe(SECRET);
    expect(decryptString('fallback:' + Buffer.from(SECRET).toString('base64'))).toBe(SECRET);
  });

  test('leaves empty values and the "none" marker alone', () => {
    expect(encryptString('none')).toBe('none');
    expect(encryptString('')).toBe('');
    expect(decryptString('none')).toBe('none');
  });
});

describe('models file', () => {
  test('is written without the key in clear text and readable only by its owner', () => {
    saveModels([model()]);

    expect(storedText()).not.toContain(SECRET);
    expect(storedModels()[0]).toMatchObject({ encrypted: true, apiKey: expect.stringMatching(/^local-gcm:/) });
    if (process.platform !== 'win32') expect(fs.statSync(getModelsPath()).mode & 0o777).toBe(0o600);
    expect(loadModels()[0].apiKey).toBe(SECRET);
  });

  test.each([
    ['the user-name scheme', () => ({ apiKey: legacyEncrypt(SECRET), encrypted: true })],
    ['base64', () => ({ apiKey: 'fallback:' + Buffer.from(SECRET).toString('base64'), encrypted: true })],
    ['clear text', () => ({ apiKey: SECRET, encrypted: false })],
  ])('upgrades a key stored with %s the first time it is loaded', (_name, stored) => {
    fs.writeFileSync(getModelsPath(), JSON.stringify({ models: [model(stored())] }));

    expect(loadModels()[0].apiKey).toBe(SECRET);

    expect(storedText()).not.toContain(SECRET);
    expect(storedModels()[0]).toMatchObject({ encrypted: true, apiKey: expect.stringMatching(/^local-gcm:/) });
    expect(loadModels()[0].apiKey).toBe(SECRET);
  });

  test('keeps a value it cannot read exactly as it was', () => {
    const unreadable = 'enc:' + Buffer.from('not a real ciphertext').toString('base64');
    fs.writeFileSync(getModelsPath(), JSON.stringify({ models: [model({ apiKey: unreadable, encrypted: true })] }));

    loadModels();

    expect(storedModels()[0].apiKey).toBe(unreadable);
  });
});

describe('proxy model loading', () => {
  test('uses the real key on the same load that upgrades the file', () => {
    fs.writeFileSync(getModelsPath(), JSON.stringify({ models: [model({ apiKey: SECRET, encrypted: false })] }));

    expect(loadCustomModels().map((m) => m.apiKey)).toEqual([SECRET]);
    expect(loadCustomModels().map((m) => m.apiKey)).toEqual([SECRET]);
  });

  test('skips a model whose key cannot be read instead of sending a placeholder as the key', () => {
    const unreadable = 'enc:' + Buffer.from('not a real ciphertext').toString('base64');
    fs.writeFileSync(
      getModelsPath(),
      JSON.stringify({
        models: [
          model({ name: 'models/broken', apiKey: unreadable, encrypted: true }),
          model({ name: 'models/keyless', apiKey: 'none' }),
        ],
      }),
    );

    expect(loadCustomModels().map((m) => m.name)).toEqual(['models/keyless']);
  });
});

describe('importing models from the desktop app', () => {
  test('keeps readable keys and asks for the ones only the desktop app can read', () => {
    const result = fromDesktopModels([
      { ...model({ name: 'models/plain', displayName: 'Plain' }), encrypted: false },
      { ...model({ name: 'models/desktop', displayName: 'Desktop', apiKey: 'enc:AAAA' }), encrypted: true },
      { ...model({ name: 'models/local', displayName: 'Local', apiKey: 'none' }) },
    ]);

    expect(result.models.map((m) => [m.name, m.apiKey])).toEqual([
      ['models/plain', SECRET],
      ['models/desktop', 'none'],
      ['models/local', 'none'],
    ]);
    expect(result.needKey).toEqual(['Desktop']);
    expect(result.models.every((m) => !m.encrypted)).toBe(true);
  });
});
