/**
 * HTTP/WebSocket reverse proxy onto the loopback DSH webserver.
 *
 * The Host header is rewritten to the loopback origin so the connection
 * layer's trust fence (loopback-Host DNS-rebinding guard) accepts proxied
 * requests; hop-by-hop headers are dropped per RFC 7230 §6.1.
 *
 * Payload compression: the upstream webserver serves large JSON responses
 * (e.g. session.history returns raw event sequences measuring hundreds of
 * KiB) uncompressed regardless of Accept-Encoding. On a slow phone over a
 * high-latency DERP relay that full body costs seconds. When the client
 * advertises gzip and the upstream did not already encode the body, this
 * proxy gzips compressible JSON/text responses on the fly (~10x smaller);
 * the browser's request still names the original encoding, so the upstream
 * is never asked for a form it cannot produce.
 */

import { request } from 'node:http'
import { createGzip } from 'node:zlib'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** Is this content-type a JSON document (exact or +json structured suffix)? */
function isJsonContentType(ct) {
  return ct === 'application/json' || ct.endsWith('+json')
}

function forwardedHeaders(req, target) {
  const headers = { ...req.headers }
  const connectionTokens = String(req.headers.connection ?? '')
    .split(',').map((token) => token.trim().toLowerCase())
  for (const header of [...HOP_BY_HOP, ...connectionTokens]) delete headers[header]
  headers.host = `${target.host}:${target.port}`
  // The backend enforces same-origin on RPC POSTs (CSRF fence): rewrite Host
  // alone is not enough — the browser's Origin/Referer still name the public
  // URL and the call 403s. Strip both so the upstream sees an own-origin call.
  delete headers.origin
  delete headers.referer
  return headers
}

export function proxyRequest(req, res, target, onError, { onResponded } = {}) {
  const upstream = request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: forwardedHeaders(req, target),
  })
  upstream.on('response', (upstreamRes) => {
    onResponded?.()
    const headers = { ...upstreamRes.headers }
    const connectionTokens = String(upstreamRes.headers.connection ?? '')
      .split(',').map((token) => token.trim().toLowerCase())
    for (const header of [...HOP_BY_HOP, ...connectionTokens]) delete headers[header]
    // Gzip large JSON RPC responses for gzip-capable clients (see module
    // doc). Restrict to JSON documents: RPC responses are finite complete
    // bodies, while text/html|plain may be endless streams (SSE-style) whose
    // first chunk must reach the client immediately — gzip's internal buffer
    // would stall those. Never double-encode, never touch binary payloads.
    const ct = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    const acceptGzip = String(req.headers['accept-encoding'] ?? '').split(',').some((t) => t.trim().split(';')[0] === 'gzip')
    const wantsCompress = acceptGzip && !headers['content-encoding'] && isJsonContentType(ct)
    if (wantsCompress) {
      delete headers['content-length']
      delete headers['etag'] // entity changed under this ETag; drop rather than mislead
      headers['content-encoding'] = 'gzip'
      res.writeHead(upstreamRes.statusCode, headers)
      const gz = createGzip({ level: 6 })
      upstreamRes.pipe(gz).pipe(res)
      gz.on('error', () => res.destroy())
      upstreamRes.on('aborted', () => res.destroy())
      upstreamRes.on('error', () => res.destroy())
      return
    }
    res.writeHead(upstreamRes.statusCode, headers)
    // A dead upstream mid-body surfaces on the RESPONSE stream (aborted +
    // error); the request itself only ever emits 'close'. Tear the client
    // down instead of leaving it waiting forever on a half-delivered body.
    upstreamRes.on('aborted', () => res.destroy())
    upstreamRes.on('error', () => res.destroy())
    upstreamRes.pipe(res)
  })
  upstream.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`upstream unavailable: ${String(error?.message ?? error)}`)
    onError?.(error)
  })
  // Client went away (request aborted or response dropped mid-stream): stop
  // draining the upstream for a peer that can no longer receive it.
  res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
  req.pipe(upstream)
}

export function proxyUpgrade(req, socket, head, target, onError, { onEstablished, handshakeTimeoutMs = 10_000 } = {}) {
  const upstream = request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: { ...forwardedHeaders(req, target), connection: 'Upgrade', upgrade: req.headers.upgrade ?? 'websocket' },
  })
  // Deadline for the 101 handshake only: an upstream that accepts TCP but
  // never answers would hang the browser's WS connect and the leg forever.
  // Cleared on establishment — an established leg may be legitimately quiet
  // for minutes (that is what ws-keepalive exists for).
  let timedOut = false
  upstream.setTimeout(handshakeTimeoutMs, () => {
    timedOut = true
    upstream.destroy()
    socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n')
  })
  upstream.on('upgrade', (_upstreamRes, upstreamSocket, upstreamHead) => {
    upstream.setTimeout(0)
    const headerBlock = Object.entries(_upstreamRes.headers)
      .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`)
      .join('')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headerBlock}\r\n`)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    if (head.length > 0) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    // Established before the pipes can deliver a chunk (same tick), so the
    // observer sees every byte of both directions; seeds replay the heads
    // already written. Returns a disposer for teardown.
    const detach = onEstablished?.(socket, upstreamSocket, upstreamHead) ?? null
    const teardown = () => { detach?.(); upstreamSocket.destroy(); socket.destroy() }
    upstreamSocket.on('close', teardown)
    socket.on('close', teardown)
    upstreamSocket.on('error', teardown)
    socket.on('error', teardown)
  })
  upstream.on('response', (upstreamRes) => {
    // The upstream refused the upgrade (e.g. unknown path): pass the verdict on.
    socket.end(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`)
    upstreamRes.resume()
  })
  upstream.on('error', (error) => {
    if (timedOut) return // the 504 already told the story
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    onError?.(error)
  })
  upstream.end()
}
