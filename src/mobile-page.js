/**
 * Mobile PWA page loader ("DSH 遥控器", docs/MOBILE-PRODUCT.md): reads
 * ../mobile/index.html relative to this module — the same asset pattern as
 * index.js's loadHomeScreenIcon — and hands the HTML to the gateway's /m
 * route. Re-read per request (small file; editing + cp'ing the asset takes
 * effect on next phone refresh without a gateway restart). Returns null when
 * the asset is missing so the route transparently falls back to proxying.
 *
 * Caching: the response carries a strong ETag (file size + mtime, cheap and
 * stable across restarts) plus Cache-Control: no-cache. "no-cache" still lets
 * the browser revalidate cheaply — a slow-relay client sends one tiny
 * If-None-Match round-trip and gets a 304 instead of re-downloading the whole
 * page — while a content change is reflected immediately (the ETag changes,
 * so the next revalidation refetches). This is the cold-start win for
 * phones arriving over a high-latency DERP relay.
 */

import { readFileSync, statSync } from 'node:fs'

export function loadMobilePage() {
  try {
    const html = readFileSync(new URL('../mobile/index.html', import.meta.url), 'utf8')
    const st = statSync(new URL('../mobile/index.html', import.meta.url))
    const etag = '"' + (st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16)) + '"'
    return { html, etag }
  } catch {
    return null
  }
}
