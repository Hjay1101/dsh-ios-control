/**
 * Legacy-browser fallback for the gateway SPA entry.
 *
 * The official web frontend ships as a modern ES-module bundle; browsers that
 * cannot parse it (notably iOS 12 Safari — the last release some 2013-2014
 * iPhones can run) execute zero JavaScript and render a silent white screen.
 * Serving this page instead of the dead shell turns that dead end into an
 * explanation. Detection is deliberately conservative: unknown or missing
 * User-Agents pass through untouched.
 *
 * Floors follow the ES2020 "modules" baseline the frontend is built for:
 * Safari/iOS 14, Chromium 87, Firefox 78.
 */

const MIN_IOS = 14
const MIN_SAFARI = 14
const MIN_CHROMIUM = 87 // Chrome / Edge / CriOS / Samsung Internet
const MIN_FIREFOX = 78

export function isLegacyUa(ua) {
  if (typeof ua !== 'string' || ua.length === 0) return false

  // iOS first: any browser on iOS uses the system WebKit, so the OS version
  // is the real capability — an old iPhone with a high CriOS/FF number still
  // renders like the Safari it embeds.
  const ios = ua.match(/(?:iPhone|iPad|iPod)[^)]*?OS (\d+)[._]/)
  if (ios !== null) return Number(ios[1]) < MIN_IOS

  const safari = ua.match(/Version\/(\d+)/) // desktop Safari
  if (safari !== null) return Number(safari[1]) < MIN_SAFARI

  const chromium = ua.match(/(?:Chrome|Edg(?:e|A|iOS)?|SamsungBrowser)\/(\d+)/)
  if (chromium !== null) return Number(chromium[1]) < MIN_CHROMIUM

  const firefox = ua.match(/Firefox\/(\d+)/)
  if (firefox !== null) return Number(firefox[1]) < MIN_FIREFOX

  return false
}

export const LEGACY_PAGE_HTML = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>浏览器版本过低 · DSH</title>
<style>
  :root { color-scheme: light dark }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         -webkit-text-size-adjust:100%;
         font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
         background:#f5f5f7; color:#1d1d1f }
  @media (prefers-color-scheme: dark) { body{background:#000;color:#f5f5f7} .card{background:#1c1c1e} }
  .card { background:#fff; border-radius:18px; padding:34px 28px; max-width:360px; width:calc(100% - 40px);
          box-shadow:0 6px 24px rgba(0,0,0,.08); text-align:center }
  h1 { font-size:19px; margin:0 0 12px; font-weight:600 }
  p { font-size:14px; line-height:1.7; margin:8px 0 }
  .hint { opacity:.62; font-size:12.5px }
</style>
</head>
<body>
<div class="card">
  <h1>浏览器版本过低</h1>
  <p>这台设备的系统浏览器无法运行 DSH 控制台。<br>需要 iOS 14 或更高版本，以及其他现代浏览器。</p>
  <p class="hint">配对与会话数据不受影响；换用较新的设备打开本地址即可继续使用。</p>
</div>
</body>
</html>
`
