/**
 * Mobile PWA page loader ("DSH 遥控器", docs/MOBILE-PRODUCT.md): reads
 * ../mobile/index.html relative to this module — the same asset pattern as
 * index.js's loadHomeScreenIcon — and hands the HTML to the gateway's /m
 * route. Re-read per request (small file; editing + cp'ing the asset takes
 * effect on next phone refresh without a gateway restart). Returns null when
 * the asset is missing so the route transparently falls back to proxying.
 */

import { readFileSync } from 'node:fs'

export function loadMobilePage() {
  try {
    return readFileSync(new URL('../mobile/index.html', import.meta.url), 'utf8')
  } catch {
    return null
  }
}
