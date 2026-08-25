/**
 * Mux event tap: the gateway's own WebSocket subscription to the upstream
 * /api/events.mux, watching for pending user interactions (approval/question
 * requested/resolved).
 *
 * Why the gateway subscribes itself: mux frames only flow to OPEN
 * subscriptions — when no browser is connected, sniffing the proxied stream
 * would see nothing (each browser connection owns its stream). Our own
 * subscription sees interactions exactly when nobody else can, which is the
 * only case worth pushing about.
 *
 * Transport (2026-08-25 live-probe verdict): the upstream serves these paths
 * ONLY over WebSocket — a plain GET answers "426 upgrade required", with or
 * without an SSE Accept header. The previous SSE client therefore never
 * connected against a real host; this client performs the RFC 6455 upgrade
 * and parses server frames directly (text-only interest, ping→pong,
 * fragmentation-aware, size-capped).
 *
 * Non-DSH upstreams self-disable via shape detection (catch-all UI routes
 * answer with 200 HTML; missing endpoints with 404/501). Oversized frames
 * (> 256 KiB, e.g. base64 attachments) are skipped: interaction frames are
 * always tiny.
 */

import { request } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const MAX_INTERESTING_FRAME = 256 * 1024
const BACKOFF_MS = [1_000, 3_000, 10_000, 30_000]
const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==' // fixed key is fine: we never assert the accept digest

export function createEventTap({ target, onRequested, onResolved, handshakeTimeoutMs = 10_000, log = () => {} } = {}) {
  const state = { connected: false, supported: null, framesSeen: 0, interactionsSeen: 0, lastFrameAt: null }
  let req = null
  let socket = null
  let attempt = 0
  let timer = null
  let closed = false

  function handlePayload(payload) {
    if (payload === null || typeof payload !== 'object') return
    state.framesSeen += 1
    state.lastFrameAt = Date.now()
    if (payload.type === 'approval/requested' || payload.type === 'question/requested') {
      state.interactionsSeen += 1
      onRequested?.({
        kind: payload.type === 'approval/requested' ? 'approval' : 'question',
        id: String(payload.approvalId ?? payload.questionRpcId ?? payload.rpcId ?? ''),
        summary: typeof payload.summary === 'string' ? payload.summary.slice(0, 120) : null,
        sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null,
      })
    } else if (payload.type === 'approval/resolved' || payload.type === 'question/resolved') {
      onResolved?.({
        kind: payload.type === 'approval/resolved' ? 'approval' : 'question',
        id: String(payload.approvalId ?? payload.questionRpcId ?? ''),
      })
    }
  }

  // ---- minimal RFC 6455 framing (server→client is unmasked; our pongs mask) ----
  let rx = Buffer.alloc(0)
  let fragment = null // {opcode, chunks} while a fragmented text message is in flight

  function onData(chunk) {
    rx = rx.length === 0 ? chunk : Buffer.concat([rx, chunk])
    while (true) {
      const frame = readFrame()
      if (!frame) break
      if (frame.opcode === 0x9) { // ping → pong (masked, no body echo needed beyond legality)
        writeFrame(0xA, frame.payload)
      } else if (frame.opcode === 0x8) { // close → acknowledge, drop
        writeFrame(0x8, Buffer.alloc(0))
        teardown()
        schedule()
        return
      } else if (frame.opcode === 0x1 || frame.opcode === 0x2 || frame.opcode === 0x0) {
        const isText = frame.opcode === 0x1 || (fragment !== null && fragment.opcode === 0x1)
        if (!frame.fin && fragment === null) {
          if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue
          fragment = { opcode: frame.opcode, chunks: [frame.payload] }
          continue
        }
        if (fragment !== null) {
          if (frame.opcode !== 0x0) { fragment = null; continue } // protocol noise: drop
          fragment.chunks.push(frame.payload)
          if (!frame.fin) continue
          const joined = Buffer.concat(fragment.chunks)
          const opcode = fragment.opcode
          fragment = null
          if (opcode === 0x1) deliver(joined)
          continue
        }
        if (!isText) continue // binary (e.g. keepalive blobs) carries no interactions
        deliver(frame.payload)
      } // 0xA pong and anything else: ignore
    }
  }

  function deliver(payload) {
    if (payload.length > MAX_INTERESTING_FRAME) return
    let parsed = null
    try { parsed = JSON.parse(payload.toString('utf8')) } catch { return }
    handlePayload(parsed?.payload ?? parsed)
  }

  function readFrame() {
    if (rx.length < 2) return null
    const fin = (rx[0] & 0x80) !== 0
    const opcode = rx[0] & 0x0f
    const masked = (rx[1] & 0x80) !== 0
    let len = rx[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (rx.length < 4) return null
      len = rx.readUInt16BE(2); off = 4
    } else if (len === 127) {
      if (rx.length < 10) return null
      const big = rx.readBigUInt64BE(2)
      if (big > BigInt(MAX_INTERESTING_FRAME * 4)) { rx = Buffer.alloc(0); return null }
      len = Number(big); off = 10
    }
    const maskLen = masked ? 4 : 0
    if (rx.length < off + maskLen + len) return null
    let payload = rx.subarray(off + maskLen, off + maskLen + len)
    if (masked) {
      const mask = rx.subarray(off, off + 4)
      payload = Buffer.from(payload) // unshare before xor
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
    }
    rx = rx.subarray(off + maskLen + len)
    return { fin, opcode, payload }
  }

  function writeFrame(opcode, payload) {
    if (!socket || socket.destroyed) return
    const mask = randomBytes(4)
    const head = [0x80 | opcode]
    if (payload.length < 126) head.push(0x80 | payload.length)
    else if (payload.length < 65_536) { head.push(0x80 | 126); head.push((payload.length >> 8) & 0xff, payload.length & 0xff) }
    else { head.push(0x80 | 127); const big = BigInt(payload.length); for (let i = 7; i >= 0; i--) head.push(Number((big >> BigInt(i * 8)) & 0xffn)) }
    const masked = Buffer.from(payload)
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
    socket.write(Buffer.concat([Buffer.from(head), mask, masked]))
  }

  function teardown() {
    state.connected = false
    socket?.destroy()
    socket = null
    rx = Buffer.alloc(0)
    fragment = null
  }

  function connect() {
    if (closed || state.supported === false) return
    req = request({
      host: target().host, port: target().port, method: 'GET', path: '/api/events.mux',
      timeout: handshakeTimeoutMs,
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': WS_KEY,
        'sec-websocket-version': '13',
      },
    })
    req.on('upgrade', (res, upSocket, head) => {
      req.setTimeout(0)
      if (res.statusCode !== 101) { upSocket.destroy(); schedule(); return }
      state.connected = true
      state.supported = true
      attempt = 0
      socket = upSocket
      socket.on('data', onData)
      socket.on('error', () => { teardown(); schedule() })
      socket.on('close', () => { teardown(); schedule() })
      socket.on('end', () => { teardown(); schedule() })
      if (head.length > 0) onData(head)
    })
    // Non-upgrade answers arrive here: 404/501 (no such endpoint) and 200
    // (non-DSH catch-all HTML) self-disable; anything else retries.
    req.on('response', (res) => {
      res.resume()
      const code = res.statusCode ?? 0
      if (code === 404 || code === 501 || code === 200) {
        state.supported = false
        log('event-tap: upstream has no mux websocket endpoint — interaction push off')
        return
      }
      schedule()
    })
    req.on('timeout', () => { req.destroy(); schedule() })
    req.on('error', () => schedule())
    req.end()
  }

  function schedule() {
    if (closed || state.supported === false) return
    if (timer !== null) return // idempotent: timeout+error+close can all race into here
    timer = setTimeout(() => {
      timer = null
      connect()
    }, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)])
    attempt += 1
  }

  return {
    start() {
      if (closed) return
      connect()
    },
    state() {
      return { ...state }
    },
    close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      teardown()
      req?.destroy()
      req = null
    },
  }
}

// Accept-digest helper kept for tests that want a conforming handshake.
export function wsAccept(key) {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
}
