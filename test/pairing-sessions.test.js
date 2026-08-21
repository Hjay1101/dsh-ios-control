/**
 * Session persistence: paired phones survive host restarts, revocation
 * survives them too, and the store never leaks plaintext tokens.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { createPairingService } from '../src/pairing.js'

const dir = () => mkdtempSync(join(tmpdir(), 'rl-sessions-'))
const mk = (d, extra = {}) => createPairingService({
  devicesFile: join(d, 'devices.json'),
  sessionsFile: join(d, 'sessions.json'),
  ...extra,
})
const sessionsFile = (d) => join(d, 'sessions.json')

async function pairAndVerify(a) {
  const p = a.createPairing()
  const ch = a.challenge(p.sid)
  const proof = createHmac('sha256', p.secret)
    .update(`${p.sid}|${ch.nonce}|${ch.ts}`).digest('hex')
  const ok = await a.verify({ sid: p.sid, proof, ts: ch.ts })
  assert.equal(ok.ok, true)
  return ok
}

test('paired phone survives a restart (rehydrated from sessions.json)', async () => {
  const d = dir()
  try {
    const a = mk(d)
    const { sessionToken } = await pairAndVerify(a)
    const b = mk(d) // "restart": fresh instance over the same files
    const hit = b.resolveSession(sessionToken)
    assert.notEqual(hit, null)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('revoked device stays dead across restart', async () => {
  const d = dir()
  try {
    const a = mk(d)
    const { deviceId, sessionToken } = await pairAndVerify(a)
    a.revokeDevice(deviceId)
    const b = mk(d)
    assert.equal(b.resolveSession(sessionToken), null)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('revoke-all wipes the persisted table too', async () => {
  const d = dir()
  try {
    const a = mk(d)
    const { sessionToken } = await pairAndVerify(a)
    a.revokeAllDevices()
    const b = mk(d)
    assert.equal(b.resolveSession(sessionToken), null)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('sessions.json is written 0600 and contains digests only', async () => {
  const d = dir()
  try {
    const a = mk(d)
    const { sessionToken } = await pairAndVerify(a)
    assert.equal(statSync(sessionsFile(d)).mode & 0o777, 0o600)
    const rows = JSON.parse(readFileSync(sessionsFile(d), 'utf8'))
    assert.equal(rows.length, 1)
    assert.ok(typeof rows[0].digest === 'string')
    // The plaintext token must never appear on disk.
    assert.ok(!readFileSync(sessionsFile(d), 'utf8').includes(sessionToken))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('expired rows are pruned at load', async () => {
  const d = dir()
  try {
    const a = mk(d)
    const { sessionToken } = await pairAndVerify(a)
    const rows = JSON.parse(readFileSync(sessionsFile(d), 'utf8'))
    rows[0].expiresAt = 1 // far in the past
    writeFileSync(sessionsFile(d), JSON.stringify(rows))
    const b = mk(d)
    assert.equal(b.resolveSession(sessionToken), null)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('orphan rows (device gone) are pruned at load', async () => {
  const d = dir()
  try {
    const a = mk(d)
    const { sessionToken } = await pairAndVerify(a)
    const rows = JSON.parse(readFileSync(sessionsFile(d), 'utf8'))
    rows[0].deviceId = 'no-such-device'
    writeFileSync(sessionsFile(d), JSON.stringify(rows))
    const b = mk(d)
    assert.equal(b.resolveSession(sessionToken), null)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('corrupt sessions.json degrades to an empty table, service stays up', async () => {
  const d = dir()
  try {
    const a = mk(d)
    await pairAndVerify(a)
    writeFileSync(sessionsFile(d), 'not json at all')
    const b = mk(d)
    const p = b.createPairing()
    assert.ok(p.sid.length > 0)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('persistSessions:false keeps the old all-memory behavior (no file)', async () => {
  const d = dir()
  try {
    const a = mk(d, { persistSessions: false })
    await pairAndVerify(a)
    let missing = false
    try { statSync(sessionsFile(d)) } catch { missing = true }
    assert.equal(missing, true)
  } finally { rmSync(d, { recursive: true, force: true }) }
})
