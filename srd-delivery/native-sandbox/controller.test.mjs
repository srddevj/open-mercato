import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAttemptJournal, createRequest, runCandidate as runRaw, validateRequest } from './controller.mjs'

const content = Buffer.from('# reviewed offline fixture\n')
const runnerFiles = () => [{ path: 'native-sandbox/runner.py', content: Buffer.from(content), mode: 0o755 }]
const directories = []
const journal = () => { const root = mkdtempSync(join(tmpdir(), 'srd-sandbox-guard-')); directories.push(root); return join(root, 'attempt.json') }
after(() => { for (const root of directories) rmSync(root, { recursive: true, force: true }) })
const adapterDefaults = { create: async () => ({ sessionId: 'one' }), write: async () => {},
  run: async () => ({ exitCode: 0 }), read: async () => null, stop: async () => {} }
const runCandidate = (adapter, config, files) => runRaw({ ...adapterDefaults, ...adapter }, config, files, { attemptJournalPath: journal() })

const valid = () => ({ teamId: 'team_fixture', projectId: 'prj_fixture', sourceCommit: 'a'.repeat(40),
  sourceRevision: 'b'.repeat(64), runnerSha256: createHash('sha256').update(content).digest('hex'),
  billingBasis: 'approved-metered', spendApprovalUsd: 1,
  resources: { vcpus: 4, derivedMemoryGb: 8 }, timeoutMs: 2700000, persistent: false,
  ports: [], region: 'iad1', image: 'vercel/sandbox/universal:latest' })

test('unknown plan, missing approval and source/project placeholders cannot provision', async () => {
  let calls = 0
  for (const patch of [{ billingBasis: 'unknown' }, { spendApprovalUsd: null }, { sourceCommit: 'PIN_SOURCE' },
    { projectId: 'CREATE_PROJECT' }, { sourceRevision: 'main' }]) {
    await assert.rejects(runCandidate({ create: () => { calls++ } }, { ...valid(), ...patch }, []))
  }
  assert.equal(calls, 0)
})

test('resource expansion, persistence and exposed ports are refused', () => {
  for (const patch of [{ timeoutMs: 2700001 }, { persistent: true }, { ports: [3000] },
    { resources: { vcpus: 8, derivedMemoryGb: 16 } }, { region: 'sfo1' }]) {
    assert.throws(() => validateRequest({ ...valid(), ...patch }))
  }
})

test('create request forwards no caller tokens, drives, models or arbitrary environment', () => {
  const request = createRequest({ ...valid(), env: { PRIVATE_TOKEN: 'must-not-forward' }, token: 'must-not-forward' })
  assert.equal(request.requestBody.persistent, false)
  assert.deepEqual(request.requestBody.ports, [])
  assert.deepEqual(request.requestBody.resources, { vcpus: 4 })
  assert.ok(!JSON.stringify(request).includes('must-not-forward'))
  assert.equal(request.requestBody.timeout, 2700000)
})

test('a post-create runner-upload failure always stops the fresh VM', async () => {
  const stopped = []
  await assert.rejects(runCandidate({ create: async () => ({ sessionId: 'session-fixture' }),
    write: async () => { throw new Error('upload-failed') }, stop: async id => stopped.push(id) }, valid(), runnerFiles()))
  assert.deepEqual(stopped, ['session-fixture'])
})

test('failed evidence collection still stops, without creating a replacement VM', async () => {
  let created = 0; let stopped = 0
  await assert.rejects(runCandidate({ create: async () => { created++; return { sessionId: 'one' } },
    write: async () => {}, run: async () => ({ exitCode: 2 }), read: async () => { throw new Error('no-artifact') },
    stop: async () => { stopped++ } }, valid(), runnerFiles()))
  assert.equal(created, 1); assert.equal(stopped, 1)
})

test('successful adapter cycle uses the bounded command and stops before returning', async () => {
  const order = []
  const result = await runCandidate({ create: async () => { order.push('create'); return { sessionId: 'one' } },
    write: async () => order.push('write'), run: async (_id, command) => {
      order.push('run'); assert.equal(command.sudo, false); assert.equal(command.timeout, 2400000)
      assert.ok(command.args.includes('--source-commit')); return { exitCode: 0 }
    }, read: async () => { order.push('read'); return 'fixture-not-real-evidence' },
    stop: async () => order.push('stop') }, valid(), runnerFiles())
  assert.deepEqual(order, ['create', 'write', 'run', 'read', 'stop'])
  assert.equal(result.status, 'executed-awaiting-evidence-review')
  assert.equal(result.productionAccepted, false)
})

test('empty, extra, wrong-path and changed runner bytes are rejected before create', async () => {
  let creates = 0
  for (const files of [[], [...runnerFiles(), ...runnerFiles()], [{ ...runnerFiles()[0], path: 'other.py' }],
    [{ ...runnerFiles()[0], content: Buffer.from('changed bytes') }]]) {
    await assert.rejects(runCandidate({ create: async () => { creates++ } }, valid(), files))
  }
  assert.equal(creates, 0)
})

test('ambiguous create durably retains its exact name and blocks reuse of that attempt', async () => {
  let creates = 0; let name
  const path = journal()
  const adapter = { ...adapterDefaults, create: async request => { creates++; name = request.requestBody.name; throw new Error('ambiguous') } }
  await assert.rejects(runRaw(adapter, valid(), runnerFiles(), { attemptJournalPath: path }), error => {
    assert.equal(error.code, 'CREATE_OUTCOME_UNCERTAIN_CLEANUP_REQUIRED')
    assert.equal(error.cleanupNeeded, true)
    assert.equal(error.attempt.name, name)
    return true
  })
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.name, name)
  assert.equal(saved.state, 'create-outcome-uncertain-cleanup-required')
  await assert.rejects(runRaw(adapter, valid(), runnerFiles(), { attemptJournalPath: path }), /EEXIST/)
  assert.equal(creates, 1)
})

test('missing session ID and failed stop are explicit cleanup-needed outcomes', async () => {
  await assert.rejects(runCandidate({ create: async () => ({}) }, valid(), runnerFiles()), error => error.cleanupNeeded === true)
  await assert.rejects(runCandidate({ stop: async () => { throw new Error('stop failed') } }, valid(), runnerFiles()),
    error => error.code === 'STOP_FAILED_CLEANUP_REQUIRED' && error.cleanupNeeded === true)
})

test('an incomplete adapter cannot create a VM', async () => {
  let creates = 0
  await assert.rejects(runRaw({ create: async () => { creates++ } }, valid(), runnerFiles(), { attemptJournalPath: journal() }), /COMPLETE_PROVIDER_ADAPTER_REQUIRED/)
  assert.equal(creates, 0)
})

test('reviewed bytes are snapshotted before asynchronous provider calls', async () => {
  const files = runnerFiles()
  await runCandidate({ create: async () => { files[0].content.fill(0); return { sessionId: 'one' } },
    write: async (_id, uploaded) => assert.deepEqual(uploaded[0].content, content) }, valid(), files)
})

test('failed atomic state replacement preserves the prior exact resource identity', () => {
  const path = journal()
  let fail = false
  const state = createAttemptJournal(path, { name: 'exact-created-resource', teamId: 'team_fixture' }, {
    write: (...args) => { if (fail) throw new Error('forced-write-failure'); return writeSync(...args) },
  })
  state.update('creating')
  fail = true // Simulate the next disk write failing after a remote create.
  assert.throws(() => state.update('session-known-running'), /forced-write-failure/)
  const previous = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(previous.name, 'exact-created-resource')
  assert.equal(previous.state, 'creating')
  state.close()
})
