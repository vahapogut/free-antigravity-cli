/**
 * Patch rollback utilities.
 * Applies the agy binary patch, verifies the proxy works, and rolls back on failure.
 */
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as os from 'os';
import { backupFile } from './crypto';
import { startProxy, stopProxy, getProxyPort } from './proxy';

function getAgyVersion(binPath: string): string | null {
  try {
    const out = execSync(`"${binPath}" --version`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
    const m = out.match(/(\d+\.\d+\.?\d*)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function testProxyConnection(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = require('http').request({
      hostname: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      timeout: 5000,
    }, (res: any) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function findLatestBackup(binPath: string): Promise<string | null> {
  const dir = require('path').dirname(binPath);
  const base = require('path').basename(binPath);
  try {
    const files = fs.readdirSync(dir);
    const backups = files
      .filter((f: string) => f.startsWith(base + '.bak-'))
      .map((f: string) => require('path').join(dir, f))
      .filter((p: string) => fs.existsSync(p))
      .sort((a: string, b: string) => {
        const statA = fs.statSync(a);
        const statB = fs.statSync(b);
        return statB.mtime.getTime() - statA.mtime.getTime();
      });
    return backups[0] || null;
  } catch {
    return null;
  }
}

export async function patchWithRollback(
  binPath: string,
  patchFn: (path: string) => void,
): Promise<boolean> {
  const version = getAgyVersion(binPath);
  const backup = backupFile(binPath, version || undefined);

  try {
    patchFn(binPath);

    const port = await startProxy();
    const ok = await testProxyConnection(port);
    if (!ok) {
      throw new Error('Proxy health check failed after patch');
    }
    console.log('[ok] Patch applied and verified successfully.');
    return true;
  } catch (e) {
    console.error('[Error] Patch verification failed, rolling back...');

    // Attempt to restore from the backup we just created
    if (backup && fs.existsSync(backup)) {
      try {
        fs.copyFileSync(backup, binPath);
        console.log('[ok] Rolled back to backup:', backup);
      } catch (restoreErr) {
        console.error('[Error] Failed to restore from backup:', restoreErr);
      }
    } else {
      // Fallback: try to find the most recent backup
      const latest = await findLatestBackup(binPath);
      if (latest) {
        try {
          fs.copyFileSync(latest, binPath);
          console.log('[ok] Rolled back to latest backup:', latest);
        } catch (restoreErr) {
          console.error('[Error] Failed to restore from latest backup:', restoreErr);
        }
      } else {
        console.error('[Error] No backup found. Manual restore may be required.');
      }
    }

    await stopProxy();
    return false;
  }
}
