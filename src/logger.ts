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

const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'x-goog-api-key', 'x-api-key', 'api-key']);

/** Request headers for a log line, with the values of credential headers removed. */
export function describeHeaders(headers: Record<string, string | string[] | undefined>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, CREDENTIAL_HEADERS.has(name.toLowerCase()) ? '[redacted]' : value]),
    ),
  );
}

/** Request target for a log line, with credential query parameters removed. */
export function describeTarget(target: string | undefined): string {
  return (target || '').replace(/([?&](?:key|api_key|access_token|token)=)[^&#]*/gi, '$1[redacted]');
}
