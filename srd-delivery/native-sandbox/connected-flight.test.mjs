import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectedRpc, restCreateRequest, artifactMetadata, createFlightAdapter, runConnectedFlight } from './connected-flight.mjs'
import { runCandidate } from './controller.mjs'

function transport(options = {}) {
  const input = new PassThrough(), output = new PassThrough(), requests = []
  let buffer = ''
  output.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const end = buffer.indexOf('\n')
      if (end < 0) break
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      requests.push(JSON.parse(line.slice('SRD_RPC '.length)))
    }
  })
  const channel = createConnectedRpc({ input, output, ...options })
  return { ...channel, input, output, requests, reply(value) { input.write(JSON.stringify(value) + '\n') } }
}
const metadata = { localPath: 'evidence/2026-10-31/native-vercel/evidence.zip', size: 3282,
  sha256: 'a'.repeat(64), chunks: 4, chunkBytes: 1024 }
const config = (content) => ({ teamId: 'team_fixture', projectId: 'prj_fixture', sourceCommit: 'a'.repeat(40),
  sourceRevision: 'b'.repeat(64), runnerSha256: createHash('sha256').update(content).digest('hex'),
  billingBasis: 'approved-metered', spendApprovalUsd: 1, resources: { vcpus: 4, derivedMemoryGb: 8 },
  timeoutMs: 2700000, persistent: false, ports: [], region: 'iad1', image: 'vercel/sandbox/universal:latest' })

async function candidate(behavior) {
  const folder = mkdtempSync(join(tmpdir(), 'srd-bridge-unit-'))
  const content = Buffer.from('offline fixture only'), journal = join(folder, 'attempt.json')
  const calls = [], records = []
  const adapter = createFlightAdapter({ config: config(content), record: (fields) => records.push(fields),
    rpc: async (method, payload) => {
      calls.push({ method, payload })
      if (behavior?.[method]) return behavior[method](payload)
      if (method === 'create') return { sessionId: 'sbx_fixture' }
      if (method === 'run') return { commandId: 'cmd_fixture' }
      if (method === 'wait') return { exitCode: 2 }
      if (method === 'read') return metadata
      return { ok: true }
    } })
  let result, error
  try { result = await runCandidate(adapter, config(content), [{ path: 'native-sandbox/runner.py', mode: 0o755, content }], { attemptJournalPath: journal }) }
  catch (caught) { error = caught }
  const saved = JSON.parse(readFileSync(journal, 'utf8'))
  rmSync(folder, { recursive: true, force: true })
  return { result, error, calls, records, saved }
}

test('import does not provision and a valid RPC reply resolves only its matching job', async () => {
  const t = transport()
  try {
    const pending = t.rpc('create', { fixture: true })
    assert.equal(t.requests.length, 1)
    t.reply({ id: t.requests[0].id, result: { sessionId: 'sbx_fixture' } })
    assert.deepEqual(await pending, { sessionId: 'sbx_fixture' })
  } finally { t.close() }
})

test('stdin EOF rejects pending requests and rejects later cleanup calls explicitly', async () => {
  const t = transport()
  const rejected = assert.rejects(t.rpc('wait', {}), { message: 'CONNECTED_TRANSPORT_CLOSED' })
  t.input.end()
  await rejected
  await assert.rejects(t.rpc('stop', {}), { message: 'CONNECTED_TRANSPORT_CLOSED' })
  assert.equal(t.requests.length, 1)
  t.close()
})

test('stdin errors and output errors use constant messages without source details', async (context) => {
  for (const surface of ['input', 'output']) await context.test(surface, async () => {
    const t = transport()
    const rejected = assert.rejects(t.rpc('wait', {}), { message: 'CONNECTED_TRANSPORT_ERROR' })
    t[surface].emit('error', new Error('private-token-and-environment-must-not-export'))
    await rejected
    t.close()
  })
})

test('RPC deadline rejects and a late reply does not poison the following stop', async () => {
  const t = transport({ deadlineMs: 15 })
  try {
    await assert.rejects(t.rpc('wait', {}), { message: 'CONNECTED_RPC_DEADLINE' })
    const stopped = t.rpc('stop', {})
    t.reply({ id: 1, result: { exitCode: 0 } })
    t.reply({ id: 2, result: { ok: true } })
    assert.deepEqual(await stopped, { ok: true })
  } finally { t.close() }
})

test('malformed, unmatched, oversized or ambiguous replies fail closed with constant protocol errors', async (context) => {
  for (const line of ['not-json-secret', JSON.stringify({ id: 999, result: {} }),
    JSON.stringify({ id: 1, result: {}, error: 'raw-secret' }), 'x'.repeat(4097)]) {
    await context.test('invalid reply', async () => {
      const t = transport()
      const rejected = assert.rejects(t.rpc('wait', {}), { message: 'CONNECTED_PROTOCOL_ERROR' })
      t.input.write(line + '\n')
      await rejected
      t.close()
    })
  }
})

test('provider errors are discarded and do not prevent a finally stop RPC', async () => {
  const t = transport()
  try {
    const failed = t.rpc('read', {})
    t.reply({ id: 1, error: 'secret-provider-transcript' })
    await assert.rejects(failed, { message: 'CONNECTED_PROVIDER_OPERATION_FAILED' })
    const stopped = t.rpc('stop', {})
    t.reply({ id: 2, result: { ok: true } })
    assert.deepEqual(await stopped, { ok: true })
  } finally { t.close() }
})

test('REST normalization changes only exact SDK allow-all spelling and retains attempt identity/limits', () => {
  const request = { teamId: 'team_fixture', requestBody: { name: 'same-attempt', networkPolicy: 'allow-all',
    timeout: 2700000, resources: { vcpus: 4 }, ports: [], persistent: false } }
  assert.deepEqual(restCreateRequest(request), { ...request, requestBody: { ...request.requestBody, networkPolicy: { mode: 'allow-all' } } })
  assert.equal(request.requestBody.networkPolicy, 'allow-all')
  for (const networkPolicy of ['deny-all', { mode: 'allow-all' }, undefined]) {
    assert.throws(() => restCreateRequest({ ...request, requestBody: { ...request.requestBody, networkPolicy } }), { message: 'REST_POLICY_NORMALIZATION_REFUSED' })
  }
})

test('artifact receipt allows only bounded local metadata, never file bytes or credentials', () => {
  assert.deepEqual(artifactMetadata(metadata), metadata)
  for (const value of [{ ...metadata, base64: 'secret-file-body' }, { ...metadata, token: 'private' },
    { ...metadata, localPath: '../private/credentials.json' }, { ...metadata, localPath: '/private/evidence.zip' },
    { ...metadata, size: 20 * 1024 * 1024 + 1 }, { ...metadata, sha256: 'raw-secret' },
    { ...metadata, chunks: 3 }, { ...metadata, chunkBytes: 1000000 }, 'raw-base64-file']) {
    assert.throws(() => artifactMetadata(value), { message: 'CONNECTED_ARTIFACT_METADATA_REQUIRED' })
  }
})

test('controller completes the blocked flight, retrieves metadata, then stops exactly once', async () => {
  const value = await candidate()
  assert.equal(value.error, undefined)
  assert.equal(value.result.status, 'blocked-or-failed')
  assert.equal(value.result.productionAccepted, false)
  assert.deepEqual(value.calls.map((call) => call.method), ['create', 'write', 'run', 'wait', 'read', 'stop'])
  assert.deepEqual(value.calls[0].payload.requestBody.networkPolicy, { mode: 'allow-all' })
  assert.equal(value.saved.state, 'stopped')
})

test('run and artifact failures still call stop once through controller finally', async (context) => {
  for (const stage of ['run', 'wait', 'read']) await context.test(stage, async () => {
    const value = await candidate({ [stage]: async () => { throw new Error('private-provider-error') } })
    assert.ok(value.error)
    assert.equal(value.calls.at(-1).method, 'stop')
    assert.equal(value.calls.filter((call) => call.method === 'stop').length, 1)
    assert.equal(value.saved.state, 'stopped')
  })
})

test('artifact bytes are rejected before receipt serialization and still trigger stop', async () => {
  const value = await candidate({ read: async () => ({ ...metadata, base64: 'private-payload' }) })
  assert.equal(value.error.message, 'CONNECTED_ARTIFACT_METADATA_REQUIRED')
  assert.equal(value.calls.at(-1).method, 'stop')
  assert.equal(JSON.stringify(value.records).includes('private-payload'), false)
})

test('unavailable transport during stop preserves cleanup-needed rather than claiming shutdown', async () => {
  const value = await candidate({ wait: async () => { throw Object.assign(new Error('CONNECTED_TRANSPORT_CLOSED'), { code: 'CONNECTED_TRANSPORT_CLOSED' }) },
    stop: async () => { throw Object.assign(new Error('CONNECTED_TRANSPORT_CLOSED'), { code: 'CONNECTED_TRANSPORT_CLOSED' }) } })
  assert.equal(value.error.code, 'STOP_FAILED_CLEANUP_REQUIRED')
  assert.equal(value.error.cleanupNeeded, true)
  assert.equal(value.saved.state, 'stop-failed-cleanup-required')
  assert.ok(value.records.some((entry) => entry.cleanupNeeded === true && entry.explicitStopAcknowledged === false))
})

test('unconfirmed stop replies never count as an acknowledgment', async () => {
  const value = await candidate({ stop: async () => ({ raw: 'not-an-acknowledgment' }) })
  assert.equal(value.error.cleanupNeeded, true)
  assert.equal(value.records.some((entry) => entry.explicitStopAcknowledged === true), false)
})

test('duplicate receipt or journal preserves the prior flight session identity byte-for-byte', async (context) => {
  for (const duplicateJournal of [false, true]) await context.test(duplicateJournal ? 'receipt and journal' : 'receipt only', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'srd-bridge-preservation-unit-'))
    const configPath = join(folder, 'request.json'), journal = join(folder, 'attempt.json')
    const receipt = join(folder, 'connected-session-receipt.json')
    const oldReceipt = JSON.stringify({ sessionId: 'sbx_priorfixture', status: 'running', sentinel: 'preserve prior receipt' }) + '\n'
    const oldJournal = JSON.stringify({ name: 'prior-owned-attempt', state: 'session-known-running' }) + '\n'
    writeFileSync(configPath, JSON.stringify(config(Buffer.from('offline fixture'))), { mode: 0o600 })
    writeFileSync(receipt, oldReceipt, { mode: 0o600 })
    if (duplicateJournal) writeFileSync(journal, oldJournal, { mode: 0o600 })
    const input = new PassThrough(), output = new PassThrough()
    let transcript = ''
    output.on('data', (chunk) => { transcript += chunk })
    try {
      const value = await runConnectedFlight(configPath, journal, { input, output })
      assert.equal(value.exitCode, 1)
      assert.equal(value.result.errorCode, 'CONNECTED_RECEIPT_ALREADY_EXISTS')
      assert.equal(readFileSync(receipt, 'utf8'), oldReceipt)
      if (duplicateJournal) assert.equal(readFileSync(journal, 'utf8'), oldJournal)
      assert.equal(transcript.includes('SRD_RPC'), false)
      assert.equal(transcript.includes('sbx_priorfixture'), false)
    } finally { input.end(); output.end(); rmSync(folder, { recursive: true, force: true }) }
  })
})
