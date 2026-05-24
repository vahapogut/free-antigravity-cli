type LogFn = (message: string, ...args: unknown[]) => void;

export const log = {
  info: console.log as LogFn,
  warn: console.warn as LogFn,
  error: console.error as LogFn,
  debug: console.debug as LogFn,
};
