/**
 * Storage protection for saved provider API keys.
 *
 * Keys are encrypted with AES-256-GCM under a random 256-bit key kept in the configuration
 * directory, readable only by its owner. This keeps keys out of backups, synced folders and
 * shared copies of models.json. It does not protect against software running as the same user,
 * which can read the key file too.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDir } from './paths';

const PREFIX = 'local-gcm:';
const KEY_FILE = '.credentials-key';

function readKey(filename: string): Buffer {
  const key = fs.readFileSync(filename);
  if (key.length !== 32) throw new Error('The credential key file is damaged');
  return key;
}

function loadKey(create: boolean): Buffer {
  const directory = getConfigDir();
  const filename = path.join(directory, KEY_FILE);
  try {
    return readKey(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(filename, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    // Another process created it first; use that one.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readKey(filename);
}

/** Encrypts a key for storage. Throws when the key file cannot be created; nothing is stored unprotected. */
export function encryptString(plainText: string): string {
  if (!plainText || plainText === 'none') return plainText;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(true), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/** The scheme used up to 1.1.5: its key is derived from the user name, so it is only read, never written. */
function decryptLegacy(value: string): string {
  const key = crypto.createHash('sha256').update(process.env.USERNAME || process.env.USER || 'antigravity-cli').digest();
  const data = Buffer.from(value.substring(4), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, data.subarray(0, 16));
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf-8');
}

/** Returns the stored key in clear, or 'DECRYPTION_FAILED' when it cannot be read. */
export function decryptString(storedText: string): string {
  if (!storedText || storedText === 'none') return storedText;
  try {
    if (storedText.startsWith(PREFIX)) {
      const data = Buffer.from(storedText.substring(PREFIX.length), 'base64');
      if (data.length < 28) throw new Error('Truncated value');
      const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(false), data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf-8');
    }
    if (storedText.startsWith('enc:')) return decryptLegacy(storedText);
    if (storedText.startsWith('fallback:')) return Buffer.from(storedText.substring(9), 'base64').toString('utf-8');
  } catch {
    return 'DECRYPTION_FAILED';
  }
  return storedText; // clear text written by hand or by a very old release
}

/** True for a stored key that is not in the current protected form. */
export function needsProtection(storedText: string | undefined): boolean {
  return !!storedText && storedText !== 'none' && !storedText.startsWith(PREFIX);
}

export function backupFile(filePath: string, version?: string): string {
  if (!fs.existsSync(filePath)) return '';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ver = version || 'unknown';
  const backupPath = `${filePath}.bak-${ver}-${timestamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}
