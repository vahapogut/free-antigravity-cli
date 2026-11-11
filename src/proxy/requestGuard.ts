/**
 * Access rules for the local proxy.
 * The proxy serves one native client on this machine (the agy CLI). A web page must never be
 * able to use it, because matched requests are answered with the user's saved provider keys.
 */
import type { IncomingMessage } from 'http';

function headerCount(req: IncomingMessage, name: string): number {
  return req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
}

/**
 * True when the request was addressed to this listener and did not come from another web origin.
 * Native clients send no Origin header. A browser always names its origin on cross-site requests,
 * and a rebound DNS name shows up in Host.
 */
export function isLocalClientRequest(req: IncomingMessage): boolean {
  const port = req.socket.localPort;
  if (!port || headerCount(req, 'host') > 1 || headerCount(req, 'origin') > 1) return false;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  return origin === undefined || [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin);
}

/**
 * Only origin-form targets are routed. "//host/path" or an absolute URL would replace the fixed
 * upstream host when the target is resolved against it.
 */
export function isSafeRequestTarget(target: string | undefined): boolean {
  return typeof target === 'string' && target.startsWith('/') && !/^[\\/]{2}/.test(target);
}
