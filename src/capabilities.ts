import { BrowserError } from './errors.js';
import type { CommandName } from './commands.js';

/** Opt-in CLI/MCP tool groups. Tools outside these groups are always available; SDK dispatch is not gated. */
export const capabilityNames = ['storage', 'network', 'trace', 'evaluate'] as const;
export type Capability = typeof capabilityNames[number];
const gated: Partial<Record<CommandName, Capability>> = {
  cookies: 'storage', storage: 'storage', storage_state: 'storage',
  route: 'network', trace: 'trace', evaluate: 'evaluate', init_script: 'evaluate',
};
/** `undefined` means ungated (library callers); an array is the exact enabled set. */
export function capabilityEnabled(capabilities: readonly Capability[] | undefined, name: CommandName): boolean {
  const capability = gated[name];
  return capability === undefined || capabilities === undefined || capabilities.includes(capability);
}
export function requireCapability(capabilities: readonly Capability[] | undefined, name: CommandName): void {
  if (capabilityEnabled(capabilities, name)) return;
  const capability = gated[name]!;
  const error = new BrowserError('CAPABILITY_DISABLED', `${name} requires the ${capability} capability, which is disabled. Start the CLI session or MCP server with --caps ${capability}.`);
  error.details = { capability };
  throw error;
}
/** Parse repeatable, comma-separated --caps values into a sorted, de-duplicated set. */
export function parseCapabilities(values: readonly string[] = [], allowEvaluate = false): Capability[] {
  const set = new Set<Capability>(allowEvaluate ? ['evaluate'] : []);
  for (const item of values.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean)) {
    if (!(capabilityNames as readonly string[]).includes(item)) throw new BrowserError('INVALID_ARGUMENT', `Unknown capability ${JSON.stringify(item)} in --caps. Use a comma-separated list of: ${capabilityNames.join(', ')}.`);
    set.add(item as Capability);
  }
  return [...set].sort();
}
export function sameCapabilities(a: readonly Capability[], b: readonly Capability[]): boolean {
  return a.length === b.length && a.every(value => b.includes(value));
}
