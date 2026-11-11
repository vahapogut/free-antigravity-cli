/**
 * Runs before every test file: gives the tests their own configuration directory,
 * so nothing under the real ~/.free-antigravity is ever read or written.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free-agy-test-'));
process.env.FREE_ANTIGRAVITY_HOME = directory;
process.on('exit', () => {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: the directory is in the system temp folder.
  }
});
