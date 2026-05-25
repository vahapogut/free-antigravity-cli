/**
 * API key encryption for CLI.
 * Uses base64 encoding as a basic obfuscation layer.
 * For production use, consider integrating with OS keychain via keytar.
 */
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
// Derive a machine-specific key - in production, use keytar or OS keychain
const MACHINE_KEY = crypto.createHash('sha256').update(process.env.USERNAME || process.env.USER || 'antigravity-cli').digest();

export function encryptString(plainText: string): string {
  if (!plainText || plainText === 'none') return plainText;
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, MACHINE_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf-8'), cipher.final()]);
    return 'enc:' + Buffer.concat([iv, encrypted]).toString('base64');
  } catch {
    return 'fallback:' + Buffer.from(plainText, 'utf-8').toString('base64');
  }
}

export function decryptString(encryptedText: string): string {
  if (!encryptedText || encryptedText === 'none') return encryptedText;

  if (encryptedText.startsWith('enc:')) {
    try {
      const data = Buffer.from(encryptedText.substring(4), 'base64');
      const iv = data.subarray(0, 16);
      const encrypted = data.subarray(16);
      const decipher = crypto.createDecipheriv(ALGORITHM, MACHINE_KEY, iv);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
    } catch { return 'DECRYPTION_FAILED'; }
  }

  if (encryptedText.startsWith('fallback:')) {
    try { return Buffer.from(encryptedText.substring(9), 'base64').toString('utf-8'); }
    catch { return 'DECRYPTION_FAILED'; }
  }

  return encryptedText; // plaintext
}

export function isEncryptionAvailable(): boolean { return true; }
export function backupFile(filePath: string, version?: string): string {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return '';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ver = version || 'unknown';
  const backupPath = `${filePath}.bak-${ver}-${timestamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}
