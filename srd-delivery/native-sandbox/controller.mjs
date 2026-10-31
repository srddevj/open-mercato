/** Offline-authored control contract; importing this module never provisions. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export function validateRequest(config) {
  if (!config || !/^team_[A-Za-z0-9]+$/.test(config.teamId ?? '') ||
      !/^prj_[A-Za-z0-9]+$/.test(config.projectId ?? '') ||
      !/^[a-f0-9]{40}$/.test(config.sourceCommit ?? '') ||
      !/^[a-f0-9]{64}$/.test(config.sourceRevision ?? '') ||
      !/^[a-f0-9]{64}$/.test(config.runnerSha256 ?? '')) throw new Error('REVIEWED_PROJECT_AND_SOURCE_PINS_REQUIRED')
  if (!['verified-hobby-with-headroom', 'approved-metered'].includes(config.billingBasis) ||
      config.spendApprovalUsd !== 1) throw new Error('EXPLICIT_ONE_DOLLAR_BUDGET_REQUIRED')
  if (config.resources?.vcpus !== 4 || config.resources?.derivedMemoryGb !== 8 ||
      config.timeoutMs !== 2700000 || config.persistent !== false ||
      !Array.isArray(config.ports) || config.ports.length || config.region !== 'iad1' ||
      config.image !== 'vercel/sandbox/universal:latest') throw new Error('FIXED_EPHEMERAL_RESOURCE_LIMITS_REQUIRED')
  return config
}

export function reviewedRunnerFiles(files, expectedDigest) {
  if (!Array.isArray(files) || files.length !== 1 || files[0]?.path !== 'native-sandbox/runner.py' ||
      files[0]?.mode !== 0o755 || !Buffer.isBuffer(files[0]?.content)) throw new Error('EXACT_REVIEWED_RUNNER_REQUIRED')
  const content = Buffer.from(files[0].content)
  if (!content.length || content.length > 65536 || createHash('sha256').update(content).digest('hex') !== expectedDigest) {
    throw new Error('REVIEWED_RUNNER_DIGEST_MISMATCH')
  }
  return [{ path: 'native-sandbox/runner.py', content, mode: 0o755 }]
}

export function createAttemptJournal(path, attempt, { write = writeSync } = {}) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('OWNED_ATTEMPT_JOURNAL_REQUIRED')
  const target = resolve(path)
  mkdirSync(dirname(target), { recursive: true })
  // Exclusive creation prevents reusing an uncertain attempt as a retry.
  const initial = openSync(target, 'wx', 0o600)
  const writeState = (fd, state) => {
    const bytes = Buffer.from(JSON.stringify({ ...attempt, state, updatedAt: new Date().toISOString() }, null, 2) + '\n')
    let offset = 0
    while (offset < bytes.length) {
      const count = write(fd, bytes, offset, bytes.length - offset, offset)
      if (!Number.isInteger(count) || count <= 0) throw new Error('ATTEMPT_JOURNAL_WRITE_FAILED')
      offset += count
    }
    fsyncSync(fd)
  }
  try { writeState(initial, 'create-not-started') } finally { closeSync(initial) }
  const update = (state) => {
    // Preserve the last complete identity until the replacement is fully written.
    const temporary = target + '.' + randomUUID() + '.tmp'
    let fd
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeState(fd, state)
      closeSync(fd); fd = undefined
      renameSync(temporary, target)
      const directory = openSync(dirname(target), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
  return { update, close: () => {} }
}

function cleanupError(code, attempt) {
  const error = new Error(code)
  error.code = code
  error.cleanupNeeded = true
  error.attempt = attempt
  return error
}

export function createRequest(config) {
  validateRequest(config)
  return { teamId: config.teamId, requestBody: {
    name: 'srd-native-verify-' + randomUUID(), projectId: config.projectId,
    image: config.image, architecture: 'amd64', resources: { vcpus: 4 },
    timeout: 2700000, persistent: false, ports: [], region: 'iad1',
    // Ubuntu apt sources can use HTTP. No provider/account credential is injected.
    networkPolicy: 'allow-all', env: { CI: 'true', DO_NOT_TRACK: '1', NEXT_TELEMETRY_DISABLED: '1' },
  } }
}

/**
 * Adapter methods wrap the connected provider's create/write/run/read/stop tools.
 * create returns {sessionId}; write uploads only this reviewed runner; run waits
 * with progress outside this module and returns {exitCode}; read retrieves the
 * bounded evidence ZIP. Never pass a token or user environment into the VM.
 */
export async function runCandidate(adapter, config, runnerFiles, { attemptJournalPath } = {}) {
  const request = createRequest(config) // Guard before the first provider call.
  const files = reviewedRunnerFiles(runnerFiles, config.runnerSha256)
  for (const method of ['create', 'write', 'run', 'read', 'stop']) {
    if (typeof adapter?.[method] !== 'function') throw new Error('COMPLETE_PROVIDER_ADAPTER_REQUIRED')
  }
  const pins = { sourceCommit: config.sourceCommit, sourceRevision: config.sourceRevision }
  const attempt = { name: request.requestBody.name, teamId: config.teamId, projectId: config.projectId,
    ...pins, runnerSha256: config.runnerSha256, timeoutMs: 2700000, persistent: false }
  const journal = createAttemptJournal(attemptJournalPath, attempt)
  let session
  try {
    journal.update('creating')
    try { session = await adapter.create(request) }
    catch {
      try { journal.update('create-outcome-uncertain-cleanup-required') } catch { /* Last atomic identity survives. */ }
      throw cleanupError('CREATE_OUTCOME_UNCERTAIN_CLEANUP_REQUIRED', attempt)
    }
    if (!session?.sessionId) {
      try { journal.update('create-outcome-uncertain-cleanup-required') } catch { /* Last atomic identity survives. */ }
      throw cleanupError('CREATE_OUTCOME_UNCERTAIN_CLEANUP_REQUIRED', attempt)
    }
    journal.update('session-known-running')
    await adapter.write(session.sessionId, files)
    const command = await adapter.run(session.sessionId, {
      command: 'python3', args: ['/vercel/sandbox/native-sandbox/runner.py',
        '--source-commit', pins.sourceCommit, '--source-revision', pins.sourceRevision],
      cwd: '/vercel/sandbox', sudo: false, timeout: 2400000, logs: false,
    })
    const artifact = await adapter.read(session.sessionId, '/vercel/sandbox/srd-native-run/evidence.zip')
    return { status: command.exitCode === 0 ? 'executed-awaiting-evidence-review' : 'blocked-or-failed',
      exitCode: command.exitCode, artifact, productionAccepted: false }
  } finally {
    try {
      if (session?.sessionId) {
        try { await adapter.stop(session.sessionId) }
        catch {
          try { journal.update('stop-failed-cleanup-required') } catch { /* Last atomic identity survives. */ }
          throw cleanupError('STOP_FAILED_CLEANUP_REQUIRED', attempt)
        }
        try { journal.update('stopped') }
        catch { throw cleanupError('ATTEMPT_JOURNAL_UPDATE_FAILED_CLEANUP_REQUIRED', attempt) }
      }
    } finally { journal.close() }
  }
}
