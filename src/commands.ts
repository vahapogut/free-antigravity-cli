/**
 * Decides which invocations the wrapper answers itself and which it hands to agy.
 */

export type ModelsSubcommand = 'list' | 'add' | 'remove' | 'import';

export type Route =
  | { kind: 'models'; sub: ModelsSubcommand; rest: string[] }
  | { kind: 'models-usage' }
  | { kind: 'configure' }
  | { kind: 'restore' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'agy'; args: string[] };

const MODELS_SUBCOMMANDS: readonly string[] = ['list', 'add', 'remove', 'import'];

/**
 * `custom-models` is the wrapper's own command. `models list|add|remove|import` is kept as its
 * older spelling; every other `models ...` invocation belongs to agy. Arguments after `--` always
 * go to agy.
 */
export function routeCommand(args: string[]): Route {
  const [command, sub, ...rest] = args;

  if (command === '--') return { kind: 'agy', args: args.slice(1) };

  if (command === 'custom-models' || command === 'models') {
    if (sub !== undefined && MODELS_SUBCOMMANDS.includes(sub)) {
      return { kind: 'models', sub: sub as ModelsSubcommand, rest };
    }
    return command === 'custom-models' ? { kind: 'models-usage' } : { kind: 'agy', args };
  }

  if (command === 'configure') return { kind: 'configure' };
  if (command === 'restore') return { kind: 'restore' };
  if (command === 'version' || command === '--version' || command === '-V' || command === '-v') return { kind: 'version' };
  if (command === 'help' || command === '--help' || command === '-h') return { kind: 'help' };
  if (command === 'chat') return { kind: 'agy', args: args.slice(1) };

  return { kind: 'agy', args };
}
