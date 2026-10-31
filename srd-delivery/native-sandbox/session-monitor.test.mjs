import test from 'node:test'
import assert from 'node:assert/strict'
import { monitorSession, COMPLETION_PATH } from './session-monitor.mjs'

const expected = { sessionId: 'sbx_' + 'fixtureSession', commandId: 'cmd_' + 'fixtureCommand',
  sourceCommit: 'a'.repeat(40), sourceRevision: 'b'.repeat(64) }
const resources = () => ({ vcpus: 4, memoryMiB: 8192, timeoutMs: 2700000,
  region: 'iad1', persistent: false, ports: [] })
const marker = () => ({ kind: 'native-verification-completion-v1', sourceCommit: expected.sourceCommit,
  sourceRevision: expected.sourceRevision, status: 'executed-awaiting-independent-review', exitCode: 0, artifactReady: true })
function fixture(overrides = {}) {
  let time = 0, cycles = 0
  const waits = []
  const adapter = {
    readSession: async () => ({ sessionId: expected.sessionId, status: 'running', resources: resources() }),
    probeCompletion: async request => {
      assert.equal(request.path, COMPLETION_PATH)
      return { sessionId: expected.sessionId, marker: cycles ? marker() : null, artifactReady: !!cycles }
    },
    readCommand: async request => {
      waits.push(request.wait)
      return { sessionId: expected.sessionId, commandId: expected.commandId, exitCode: request.wait ? 0 : null }
    },
    ...overrides,
  }
  return { adapter, waits, expected, deadlineAtMs: 40, now: () => time, pollMs: 5,
    observerTimeoutMs: 5, pause: async ms => { time += ms; cycles++ } }
}

test('running observations never long-poll; matching marker and actual exit finish without acceptance', async () => {
  const f = fixture(), result = await monitorSession(f)
  assert.deepEqual(f.waits, [false, true])
  assert.equal(result.status, 'command-finished')
  assert.equal(result.executionSucceeded, true)
  assert.equal(result.markerVerified, true)
  assert.equal(result.productionAccepted, false)
  assert.equal(result.productFailureEstablished, false)
})

test('transient session, probe and terminal-query errors remain unknown and recover without cancellation', async t => {
  for (const method of ['readSession', 'probeCompletion', 'readCommand']) await t.test(method, async () => {
    const f = fixture(), original = f.adapter[method]
    let failures = 0
    f.adapter[method] = async request => {
      if (failures++ === 0) throw new Error('private-canary-auth-and-path-must-not-leak')
      return original(request)
    }
    f.adapter.stop = () => { throw new Error('must never cancel from an observation failure') }
    const states = []
    f.onObservation = value => states.push(value.status)
    const result = await monitorSession(f)
    assert.equal(result.status, 'command-finished')
    assert.ok(result.observerFailures >= 1)
    assert.ok(states.includes('unknown'))
    assert.equal(JSON.stringify(result).includes('private-canary'), false)
  })
})

test('a completion marker is not an actual exit; no terminal result reaches the deadline as unknown', async () => {
  const f = fixture({ probeCompletion: async () => ({ sessionId: expected.sessionId, marker: marker(), artifactReady: true }),
    readCommand: async () => ({ sessionId: expected.sessionId, commandId: expected.commandId, exitCode: null }) })
  const result = await monitorSession(f)
  assert.equal(result.code, 'MONITOR_DEADLINE')
  assert.equal(result.executionSucceeded, false)
  assert.equal(result.productFailureEstablished, false)
})

test('even an actual zero exit cannot pass without a verified completion marker', async () => {
  const f = fixture({ probeCompletion: async () => ({ sessionId: expected.sessionId, marker: null, artifactReady: true }),
    readCommand: async () => ({ sessionId: expected.sessionId, commandId: expected.commandId, exitCode: 0 }) })
  assert.equal((await monitorSession(f)).code, 'MONITOR_DEADLINE')
  assert.deepEqual(f.waits, [])
})

test('a hanging observer is bounded and reused until the deadline instead of launching duplicate reads', async () => {
  let calls = 0
  const f = fixture({ readSession: () => { calls++; return new Promise(() => {}) } })
  f.observerTimeoutMs = 1
  const result = await monitorSession(f)
  assert.equal(result.code, 'MONITOR_DEADLINE')
  assert.equal(calls, 1)
  assert.ok(result.observerFailures > 1)
})

test('stale or malformed session, resource, marker and command identities fail closed without echoing them', async t => {
  const cases = [
    [{ readSession: async () => ({ sessionId: 'foreign-private-id', status: 'running', resources: resources() }) }, 'SESSION_IDENTITY_MISMATCH'],
    [{ readSession: async () => ({ sessionId: expected.sessionId, status: 'running', resources: { ...resources(), ports: [3000] } }) }, 'SESSION_RESOURCE_MISMATCH'],
    [{ probeCompletion: async () => ({ sessionId: 'foreign-private-id', marker: null, artifactReady: false }) }, 'COMPLETION_PROBE_INVALID'],
    [{ probeCompletion: async () => ({ sessionId: expected.sessionId, marker: { ...marker(), sourceCommit: 'c'.repeat(40) }, artifactReady: true }) }, 'COMPLETION_MARKER_INVALID'],
    [{ probeCompletion: async () => ({ sessionId: expected.sessionId, marker: { ...marker(), rawOutput: 'private-canary' }, artifactReady: true }) }, 'COMPLETION_MARKER_INVALID'],
    [{ readCommand: async () => ({ sessionId: expected.sessionId, commandId: 'foreign-private-id', exitCode: 0 }) }, 'COMMAND_IDENTITY_OR_STATUS_INVALID'],
  ]
  for (const [changes, code] of cases) await t.test(code, async () => {
    const result = await monitorSession(fixture(changes))
    assert.equal(result.code, code)
    assert.equal(result.executionSucceeded, false)
    assert.equal(JSON.stringify(result).includes('private'), false)
  })
})

test('actual nonzero exit remains a failed execution, not a claimed application defect', async () => {
  const result = await monitorSession(fixture({ readCommand: async () => ({ sessionId: expected.sessionId,
    commandId: expected.commandId, exitCode: 2 }) }))
  assert.equal(result.status, 'command-finished')
  assert.equal(result.exitCode, 2)
  assert.equal(result.executionSucceeded, false)
  assert.equal(result.productFailureEstablished, false)
})

test('a presentation callback failure is observation-only', async () => {
  const result = await monitorSession({ ...fixture(), onObservation: () => { throw new Error('private-canary') } })
  assert.equal(result.status, 'command-finished')
  assert.equal(result.observerFailures, 1)
})

test('a hanging presentation callback is bounded and does not overrun the deadline', async () => {
  let calls = 0
  const f = fixture({ probeCompletion: async () => ({ sessionId: expected.sessionId, marker: null, artifactReady: false }) })
  const result = await monitorSession({ ...f, observerTimeoutMs: 1,
    onObservation: () => { calls++; return new Promise(() => {}) } })
  assert.equal(result.code, 'MONITOR_DEADLINE')
  assert.equal(calls, 1)
})

test('an explicitly reduced provider timeout is supported but a different observed limit fails closed', async () => {
  const f = fixture({ readSession: async () => ({ sessionId: expected.sessionId, status: 'running',
    resources: { ...resources(), timeoutMs: 1800000 } }) })
  const reduced = { ...expected, timeoutMs: 1800000 }
  assert.equal((await monitorSession({ ...f, expected: reduced })).status, 'command-finished')
  assert.equal((await monitorSession(fixture({ readSession: f.adapter.readSession }))).code, 'SESSION_RESOURCE_MISMATCH')
})

test('invalid shorter-than-one-minute or expanded provider limits cannot be selected', async () => {
  for (const timeoutMs of [1, 59999, 2700001, '1800000']) {
    await assert.rejects(monitorSession({ ...fixture(), expected: { ...expected, timeoutMs } }),
      /^Error: MONITOR_CONFIGURATION_INVALID$/)
  }
})

test('inconsistent marker and actual terminal exit are rejected', async () => {
  const result = await monitorSession(fixture({
    probeCompletion: async () => ({ sessionId: expected.sessionId, marker: marker(), artifactReady: true }),
    readCommand: async () => ({ sessionId: expected.sessionId, commandId: expected.commandId, exitCode: 2 }),
  }))
  assert.equal(result.code, 'COMPLETION_EXIT_MISMATCH')
})
