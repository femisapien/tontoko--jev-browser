import { version } from './version.js';
import { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { JevBrowser } from './browser.js';
import { commandSchemas, commandDescriptions, commandReadOnly, executeCommand, parseCommand, type Command, type CommandName } from './commands.js';
import { publicError } from './errors.js';
import { capabilityEnabled, type Capability } from './capabilities.js';
import type { ScreenResult } from './screen.js';
import { screenToolSchema } from './screen-tool.js';

/**
 * The caller owns the borrowed core, or its lazy factory's lifetime. Tool calls run one at a time, in arrival order.
 * `capabilities` lists the enabled opt-in tool groups; tools of other groups are not registered. Omitted, every tool is registered.
 */
export function createMcpServer(browser: JevBrowser | (() => Promise<JevBrowser>), options: { screenOnly?: boolean; capabilities?: readonly Capability[] } = {}): McpServer {
  const server = new McpServer({ name: 'jev-browser', version });
  const screenOnly = typeof browser === 'function' ? options.screenOnly === true : browser.screenOnly;
  let started = typeof browser !== 'function';
  const names: CommandName[] = screenOnly ? ['screen', 'close'] : (Object.keys(commandSchemas) as CommandName[]).filter(name => capabilityEnabled(options.capabilities, name));
  // The core is exclusive and answers BUSY; clients commonly send parallel calls, so they wait here instead.
  let queue = Promise.resolve();
  const serial = async <T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> => {
    const previous = queue;
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    queue = previous.then(() => done);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        void previous.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      return await task();
    } finally { release(); }
  };
  for (const name of names) {
    const inputSchema: z.ZodType = name === 'screen' ? screenToolSchema : commandSchemas[name];
    const readOnly = commandReadOnly(name);
    server.registerTool(`browser_${name}`, {
      description: commandDescriptions[name], inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
    }, async (args, context) => {
      try {
        context.mcpReq.signal.throwIfAborted();
        // A started core validates screen requests with the same schema and can report its current observationId.
        const command = name === 'screen' && started ? { ...(args as object), command: name } as Command : parseCommand({ ...(args as object), command: name });
        // An explicit budget also covers waiting for earlier calls. Unparsed screen arguments are validated by the core.
        const timeoutMs = 'timeoutMs' in command ? command.timeoutMs : undefined;
        const signal = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 0 ? AbortSignal.any([context.mcpReq.signal, AbortSignal.timeout(timeoutMs)]) : context.mcpReq.signal;
        const execute = async () => { const core = typeof browser === 'function' ? await browser() : browser; started = true; return executeCommand(core, command, signal); };
        // Close is not queued: like SDK close(), it can stop a long-running call.
        const result = name === 'close' ? await execute() : await serial(signal, execute);
        if (name === 'screen') {
          const screen = result as ScreenResult;
          const metadata = { ...screen, frames: screen.frames.map(({ data, path, ...frame }) => frame) };
          return { content: [
            { type: 'text' as const, text: JSON.stringify(metadata) },
            ...screen.frames.map(frame => ({ type: 'image' as const, data: frame.data, mimeType: frame.mimeType })),
          ], structuredContent: metadata };
        }
        if (name === 'screenshot' || name === 'take_screenshot') {
          const image = result as { data: string; mimeType: string; path?: string };
          return { content: [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }, ...(image.path ? [{ type: 'text' as const, text: JSON.stringify({ path: image.path }) }] : [])] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: publicError(error) }) }] };
      }
    });
  }
  return server;
}
