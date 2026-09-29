import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Install the browser build matching the Playwright this package resolves, not the caller's own Playwright. */
export function installBrowser(browser: string, dryRun = false): Promise<number> {
  const cli = join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  const child = spawn(process.execPath, [cli, 'install', ...(dryRun ? ['--dry-run'] : []), browser], { stdio: ['ignore', 2, 2] });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
}
