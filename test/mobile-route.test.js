/**
 * /m mobile PWA route: gated like the official UI root, exact-path only,
 * per-request page load (hot-edit friendly), null-page falls through to the
 * proxy. Contract: docs/MOBILE-PRODUCT.md §6.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createGateway } from '../src/gateway.js'

function startUpstream() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>official ui</html>')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

async function startGateway(upstream, { mobilePage = null } = {}) {
  const gateway = createGateway({
    auth: {
      required: true,
      basicEnabled: true,
      check(req) {
        const ok = req.headers.authorization === 'Basic dXNlcjpwYXNz' // user:pass
        return { ok, via: ok ? 'basic' : 'none' }
      },
    },
    limiter: { check: () => ({ allowed: true, retryAfterMs: 0 }) },
    failureBan: { isBanned: () => ({ banned: false, retryAfterMs: 0 }), recordFailure() {}, recordSuccess() {} },
    target: () => ({ host: '127.0.0.1', port: upstream.port }),
    log: () => {},
    hostProbeIntervalMs: 0,
    mobilePage,
  })
  await gateway.listen({ host: '127.0.0.1', port: 0 })
  return gateway
}

const base = (gateway) => `http://127.0.0.1:${gateway.port}`
const authed = { authorization: 'Basic dXNlcjpwYXNz' }

test('/m serves the PWA page behind auth', async () => {
  const upstream = await startUpstream()
  const gateway = await startGateway(upstream, { mobilePage: () => '<html>remote pwa</html>' })
  try {
    const denied = await fetch(`${base(gateway)}/m`)
    assert.equal(denied.status, 401)

    const ok = await fetch(`${base(gateway)}/m`, { headers: authed })
    assert.equal(ok.status, 200)
    assert.ok(String(ok.headers.get('content-type')).includes('text/html'))
    assert.ok(String(ok.headers.get('content-security-policy')).length > 0)
    assert.equal(await ok.text(), '<html>remote pwa</html>')
    assert.deepEqual(upstream.seen, []) // never reached the proxy
  } finally {
    await gateway.close()
    upstream.server.close()
  }
})

test('/m is exact-path: subpaths keep proxying; query still routes (deep links)', async () => {
  const upstream = await startUpstream()
  const gateway = await startGateway(upstream, { mobilePage: () => '<html>remote pwa</html>' })
  try {
    // subpath → proxy
    const sub = await fetch(`${base(gateway)}/m/extra`, { headers: authed })
    assert.equal(await sub.text(), '<html>official ui</html>')

    // exact path with query → page (deep-link form /m?s=..&a=..)
    const deep = await fetch(`${base(gateway)}/m?s=abc&a=def`, { headers: authed })
    assert.equal(await deep.text(), '<html>remote pwa</html>')
    assert.ok(!upstream.seen.includes('/m?s=abc&a=def'))
  } finally {
    await gateway.close()
    upstream.server.close()
  }
})

test('HEAD /m answers headers without a body', async () => {
  const upstream = await startUpstream()
  const gateway = await startGateway(upstream, { mobilePage: () => '<html>remote pwa</html>' })
  try {
    const res = await fetch(`${base(gateway)}/m`, { method: 'HEAD', headers: authed })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '')
  } finally {
    await gateway.close()
    upstream.server.close()
  }
})

test('missing page asset (null) falls through to the proxy', async () => {
  const upstream = await startUpstream()
  const gateway = await startGateway(upstream, { mobilePage: () => null })
  try {
    const res = await fetch(`${base(gateway)}/m`, { headers: authed })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '<html>official ui</html>')
  } finally {
    await gateway.close()
    upstream.server.close()
  }
})

test('page loader runs per request (no caching — hot edits land)', async () => {
  const upstream = await startUpstream()
  let calls = 0
  const gateway = await startGateway(upstream, {
    mobilePage: () => `<html>v${++calls}</html>`,
  })
  try {
    const first = await fetch(`${base(gateway)}/m`, { headers: authed })
    const second = await fetch(`${base(gateway)}/m`, { headers: authed })
    assert.equal(await first.text(), '<html>v1</html>')
    assert.equal(await second.text(), '<html>v2</html>')
  } finally {
    await gateway.close()
    upstream.server.close()
  }
})
