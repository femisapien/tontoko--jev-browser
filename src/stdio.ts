import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { JevBrowser } from './browser.js';
import { createMcpServer } from './mcp.js';
import { BrowserError, publicError } from './errors.js';
import type { BrowserLaunchOptions } from './types.js';
import type { Capability } from './capabilities.js';

/** The official SDK owns transport and protocol; browser launch is lazy. */
export function startMcpStdio(options: BrowserLaunchOptions = {}, initialURL?: string, capabilities?: readonly Capability[]): void {
  let browser: Promise<JevBrowser> | undefined;
  let ownedBrowser: JevBrowser | undefined;
  let closing = false;
  const lost = new WeakSet<JevBrowser>();
  const getBrowser = async () => {
    if (closing) throw new BrowserError('CLOSED', 'This browser session is closed.');
    if (browser) {
      const current = browser, core = await current, ended = core.isClosed || lost.has(core);
      if (closing || ended && options.screenOnly)
        throw new BrowserError('CLOSED', 'This browser session is closed.');
      if (!ended) return core;
      if (browser === current) browser = undefined;
      // The browser is already gone; releasing the core cannot fail the replacement launch.
      await core.close().catch(() => undefined);
    }
    const launching = browser ??= JevBrowser.launch(options).then(async core => {
      ownedBrowser = core;
      if (closing) { await core.close(); throw new BrowserError('CLOSED', 'This browser session is closed.'); }
      // A crashed, killed or disconnected browser closes its context.
      core.page.context().once('close', () => { lost.add(core); });
      try { if (initialURL) await core.goto(initialURL); return core; }
      catch (error) { await core.close(); throw error; }
    });
    // An ordinary failed launch is not cached, so a later call can launch again; screen-only startup stays final.
    if (!options.screenOnly) launching.catch(() => { if (browser === launching) browser = undefined; });
    return launching;
  };
  const closeBrowser = async () => {
    closing = true;
    await ownedBrowser?.close();
    // Startup may still be launching; its continuation observes closing before navigation.
    await browser?.catch(() => undefined);
  };
  const report = (error: unknown) => { process.stderr.write(`${JSON.stringify(publicError(error))}\n`); };
  const handle = serveStdio(() => {
    const server = createMcpServer(getBrowser, { screenOnly: options.screenOnly, capabilities });
    server.server.onclose = () => { void closeBrowser().catch(report); };
    return server;
  }, { onerror: report });
  process.stdin.once('end', () => { void closeBrowser().catch(report); });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    void handle.close().then(closeBrowser).catch(report);
  });
}
