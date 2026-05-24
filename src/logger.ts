type LogFn = (message: string, ...args: unknown[]) => void;

const isDebug = () => process.env.ANTIGRAVITY_DEBUG === 'true';

export const log = {
  info: ((message: string, ...args: unknown[]) => {
    if (isDebug()) console.log(`[INFO] ${message}`, ...args);
  }) as LogFn,
  warn: ((message: string, ...args: unknown[]) => {
    // Warnings are kept visible but styled
    console.warn(`[WARN] ${message}`, ...args);
  }) as LogFn,
  error: ((message: string, ...args: unknown[]) => {
    // Errors are always critical and visible
    console.error(`[ERROR] ${message}`, ...args);
  }) as LogFn,
  debug: ((message: string, ...args: unknown[]) => {
    if (isDebug()) console.debug(`[DEBUG] ${message}`, ...args);
  }) as LogFn,
};
