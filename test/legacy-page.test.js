import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createGateway } from '../src/gateway.js'
import { LEGACY_PAGE_HTML, isLegacyUa } from '../src/legacy-page.js'

test('isLegacyUa: iOS floor at 14', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1'
  assert.equal(isLegacyUa(iphone), true)
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1'
  assert.equal(isLegacyUa(ipad), true)
  const modern = iphone.replace('OS 12_5_8', 'OS 18_3_2').replace('Version/12.1.2', 'Version/18.3')
  assert.equal(isLegacyUa(modern), false)
  // iOS 13 is below the ES2020 modules baseline too
  assert.equal(isLegacyUa(iphone.replace('OS 12_5_8', 'OS 13_7')), true)
})

test('isLegacyUa: on iOS the OS wins over engine tokens', () => {
  // Old device shipping a high CriOS number still renders with ancient WebKit
  const hybrid = 'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/103.0.5060.63 Mobile/15E148 Safari/604.1'
  assert.equal(isLegacyUa(hybrid), true)
})

test('isLegacyUa: desktop Safari floor at 14', () => {
  assert.equal(isLegacyUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15'), false)
  assert.equal(isLegacyUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.2 Safari/605.1.15'), true)
})

test('isLegacyUa: chromium and firefox floors', () => {
  assert.equal(isLegacyUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'), false)
  assert.equal(isLegacyUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36'), true)
  assert.equal(isLegacyUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91'), false)
  assert.equal(isLegacyUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.140 Safari/537.36 Edge/18.17763'), true)
  assert.equal(isLegacyUa('Mozilla/5.0 (X11; Linux x86_64; rv:115.0) Gecko/20100101 Firefox/115.0'), false)
  assert.equal(isLegacyUa('Mozilla/5.0 (X11; Linux x86_64; rv:68.0) Gecko/20100101 Firefox/68.0'), true)
})

test('isLegacyUa: conservative on unknown or missing UAs', () => {
  assert.equal(isLegacyUa(undefined), false)
  assert.equal(isLegacyUa(''), false)
  assert.equal(isLegacyUa(null), false)
  assert.equal(isLegacyUa('curl/8.4.0'), false)
  assert.equal(isLegacyUa('SomeUnknownBrowser/1.0'), false)
})

// ---- integration: paired + legacy UA → explanation page instead of shell ----

function startUpstream() {
  const seen = []
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url })
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>official ui</html>')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

const basicHeader = 'Basic ' + Buffer.from('dsh:s3cret').toString('base64')

async function withGateway(run) {
  const upstream = await startUpstream()
  const gateway = createGateway({
    auth: { check(req) { return { ok: req.headers.authorization === basicHeader } }, basicEnabled: true },
    limiter: { check: () => ({ allowed: true }) },
    failureBan: { isBanned: () => ({ banned: false }), recordFailure() {}, recordSuccess() {} },
    target: () => ({ host: '127.0.0.1', port: upstream.port }),
    log: () => {},
    hostProbeIntervalMs: 0,
  })
  await gateway.listen({ host: '127.0.0.1', port: 0 })
  try {
    await run({ port: gateway.port }, upstream.seen)
  } finally {
    gateway.close()
    await new Promise((resolve) => upstream.server.close(resolve))
  }
}

const IOS12_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 12_5_8 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1'

test('gateway serves the legacy page instead of the SPA shell', async () => {
  await withGateway(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { authorization: basicHeader, 'user-agent': IOS12_UA },
    })
    const body = await res.text()
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type'), /text\/html/)
    assert.ok(body.includes('浏览器版本过低'))
    assert.ok(body.includes('iOS 14'))
  })
})

test('modern UAs keep reaching the real app', async () => {
  await withGateway(async ({ port }, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { authorization: basicHeader, 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_2 like Mac OS X) Version/18.3 Mobile Safari/604.1' },
    })
    assert.equal(res.status, 200)
    assert.ok((await res.text()).includes('official ui'))
    assert.equal(seen.length, 1)
  })
})

test('unauthenticated legacy requests stay a bare 401', async () => {
  await withGateway(async ({ port }) => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { 'user-agent': IOS12_UA } })
    assert.equal(res.status, 401)
    assert.equal(await res.text(), 'unauthorized')
  })
})

test('non-GET entry hits are not intercepted', async () => {
  await withGateway(async ({ port }, seen) => {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { authorization: basicHeader, 'user-agent': IOS12_UA },
      body: 'x=1',
    })
    assert.equal(res.status, 200)
    assert.ok((await res.text()).includes('official ui'))
    assert.deepEqual(seen.map((s) => s.method), ['POST'])
  })
})
