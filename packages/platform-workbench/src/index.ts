/** Host half of the enterprise workbench plugin (T02/T06/T10).
 *
 *  The native WebUI owns `/api/*`, so the enterprise control-plane API is exposed under a
 *  dedicated prefix instead of colliding with the Gateway. This half registers one prefix route
 *  that proxies to the control plane reachable at `PLATFORM_WORKBENCH_CONTROL_URL`; when no target
 *  is configured it answers 503 with an honest code rather than pretending the API exists.
 *
 *  Reads and the enterprise operations the workbench page needs (create Work, save draft, start a
 *  run, answer a native question, set a model preference) are forwarded. The proxy never accepts a
 *  client-supplied URL, refuses a cross-origin browser write, refuses a `..` path segment, and
 *  forwards the client's Authorization/Cookie headers only to the configured origin. It does not
 *  decode the protocol into a second chat event stream.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Readable } from 'node:stream'
import type { IncomingMessage } from 'node:http'

export const name = 'ec-platform-workbench-host'
export const inject = ['webServer']

/** Absolute path prefix this plugin claims on the native server. */
export const CONTROL_PREFIX = '/platform-workbench'

/** Methods the workbench page needs; anything else is refused before a socket is opened. */
export const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PUT'] as const

/** Hard cap for one enterprise request body; the control plane enforces its own limit too. */
export const MAX_PROXY_BODY = 1024 * 1024

const target = (): URL | null => {
  const raw = process.env.PLATFORM_WORKBENCH_CONTROL_URL
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search) return null
    return url
  } catch {
    return null
  }
}

/** Build the upstream request URL from the incoming path, dropping the proxy prefix.
 *  Leading slashes are collapsed to exactly one so a `//host` path cannot resolve as a
 *  protocol-relative URL on a different origin. */
export function upstreamUrl(configured: URL, pathname: string, search: string): URL {
  const rest = pathname.startsWith(CONTROL_PREFIX) ? pathname.slice(CONTROL_PREFIX.length) : pathname
  const normalised = '/' + rest.replace(/^\/+/, '')
  return new URL(normalised + search, configured)
}

/** A proxied path may not escape the control plane's own route space. */
export function safeProxiedPath(pathname: string): boolean {
  if (pathname.includes('\0') || pathname.includes('\\')) return false
  for (const segment of pathname.split('/')) {
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return false
    }
    // Refuse any decoded separator or parent marker, including an encoded `..%2f` segment.
    if (decoded === '.' || decoded.includes('..') || decoded.includes('/') || decoded.includes('\\')) return false
  }
  return true
}

/**
 * A browser write must come from this very origin. Requests without an Origin header (a
 * same-origin GET, a CLI probe) are allowed only when the browser's own `sec-fetch-site` does
 * not say cross-site; a foreign Origin is always refused.
 */
export function writeOriginAllowed(request: { headers: Headers }): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false
  const origin = request.headers.get('origin')
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.get('host')
  } catch {
    return false
  }
}

/** Copy only readable header values from Node's request into a Fetch Headers bag. */
export function nodeHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  return headers
}

/** Read one request body with the proxy's hard cap; never buffer an unbounded upload. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_PROXY_BODY) {
        reject(new Error('REQUEST_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Forward only caller credentials and content headers to the configured control origin; never to a client URL. */
export function forwardedHeaders(incoming: Headers): Headers {
  const headers = new Headers()
  for (const key of ['authorization', 'cookie', 'accept', 'content-type']) {
    const value = incoming.get(key)
    if (value) headers.set(key, value)
  }
  return headers
}

/** Response headers a sealed-artifact download needs; everything else is re-derived locally. */
export function forwardedResponseHeaders(incoming: Headers): Headers {
  const headers = new Headers()
  headers.set('content-type', incoming.get('content-type') ?? 'application/json; charset=utf-8')
  for (const key of ['content-disposition', 'content-length', 'etag', 'last-modified']) {
    const value = incoming.get(key)
    if (value) headers.set(key, value)
  }
  headers.set('cache-control', 'no-store')
  headers.set('x-content-type-options', 'nosniff')
  return headers
}

export function apply(ctx: Context): void {
  // A `handler` route owns the full response lifecycle and therefore accepts POST/PUT; a
  // `resource` route is deliberately limited to GET/HEAD by the native web server, which would make
  // every enterprise operation unreachable. The handler still forwards only this plugin's prefix.
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTROL_PREFIX,
    handler: async (req, res): Promise<void> => {
      const method = (req.method ?? 'GET').toUpperCase();
      const reply = (status: number, code: string, extra: Record<string, string> = {}): void => {
        const text = JSON.stringify({ ok: false, code });
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(text)),
          'cache-control': 'no-store',
          ...extra,
        });
        res.end(text);
      };
      if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
        reply(405, 'METHOD_NOT_ALLOWED', { allow: ALLOWED_METHODS.join(', ') });
        return;
      }
      const targetUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (!safeProxiedPath(targetUrl.pathname)) {
        reply(400, 'PROXY_PATH_INVALID');
        return;
      }
      if (method !== 'GET' && method !== 'HEAD' && !writeOriginAllowed({ headers: nodeHeaders(req) })) {
        // A cross-site page must not create Works or spend the employee's execution budget.
        reply(403, 'CROSS_ORIGIN_REFUSED');
        return;
      }
      const configured = target();
      if (!configured) {
        // No control plane wired: report the truth instead of a fabricated API.
        reply(503, 'CONTROL_PLANE_UNCONFIGURED');
        return;
      }
      let body: Buffer | undefined;
      if (method !== 'GET' && method !== 'HEAD') {
        const length = Number(req.headers['content-length'] ?? '0');
        if (Number.isFinite(length) && length > MAX_PROXY_BODY) {
          reply(413, 'REQUEST_TOO_LARGE');
          return;
        }
        try {
          body = await readBody(req);
        } catch (error) {
          reply(413, error instanceof Error && error.message === 'REQUEST_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'REQUEST_INVALID');
          return;
        }
      }
      const abort = new AbortController();
      const onClose = (): void => { abort.abort(); };
      res.on('close', onClose);
      try {
        const upstream = await fetch(upstreamUrl(configured, targetUrl.pathname, targetUrl.search), {
          method,
          headers: forwardedHeaders(nodeHeaders(req)),
          ...(body === undefined ? {} : { body: new Uint8Array(body) }),
          signal: abort.signal,
        });
        const headers = forwardedResponseHeaders(upstream.headers);
        res.writeHead(upstream.status, Object.fromEntries(headers.entries()));
        if (upstream.body === null) {
          res.end();
        } else {
          Readable.fromWeb(upstream.body as never)
            .on('error', () => { res.destroy(); })
            .pipe(res);
        }
      } catch {
        if (!res.headersSent) reply(502, 'CONTROL_PLANE_UNREACHABLE');
        else res.destroy();
      } finally {
        res.off('close', onClose);
      }
    },
  }), 'ec-platform-workbench control proxy')
}

export * from './knowledge-seeds.js';
