/** Local JSON-line bridge to connected tools; never authenticates the guest. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createInterface } from 'node:readline'
import { runCandidate } from './controller.mjs'

const RPC_TIMEOUTS = Object.freeze({ create: 120000, write: 120000, run: 60000,
  wait: 2420000, read: 120000, stop: 60000 })
const SAFE_CODES = new Set(['CONNECTED_TRANSPORT_CLOSED', 'CONNECTED_TRANSPORT_ERROR',
  'CONNECTED_PROTOCOL_ERROR', 'CONNECTED_RPC_DEADLINE', 'CONNECTED_PROVIDER_OPERATION_FAILED',
  'CONNECTED_RESPONSE_INVALID', 'CONNECTED_ARTIFACT_METADATA_REQUIRED', 'REST_POLICY_NORMALIZATION_REFUSED',
  'CONNECTED_RECEIPT_ALREADY_EXISTS',
  'PRIVATE_CONFIG_AND_EXCLUSIVE_JOURNAL_REQUIRED', 'REVIEWED_PROJECT_AND_SOURCE_PINS_REQUIRED',
  'EXPLICIT_ONE_DOLLAR_BUDGET_REQUIRED', 'FIXED_EPHEMERAL_RESOURCE_LIMITS_REQUIRED',
  'EXACT_REVIEWED_RUNNER_REQUIRED', 'REVIEWED_RUNNER_DIGEST_MISMATCH',
  'COMPLETE_PROVIDER_ADAPTER_REQUIRED', 'OWNED_ATTEMPT_JOURNAL_REQUIRED',
  'ATTEMPT_JOURNAL_WRITE_FAILED', 'CREATE_OUTCOME_UNCERTAIN_CLEANUP_REQUIRED',
  'STOP_FAILED_CLEANUP_REQUIRED', 'ATTEMPT_JOURNAL_UPDATE_FAILED_CLEANUP_REQUIRED'])
const fail = (code) => Object.assign(new Error(code), { code })
const safeCode = (error) => SAFE_CODES.has(error?.code) ? error.code : 'CONNECTED_FLIGHT_FAILED'
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, allowed) => plain(value) && Object.keys(value).every((key) => allowed.includes(key))

/** Timers retain pending jobs; EOF/errors reject them instead of hanging cleanup. */
export function createConnectedRpc({ input = process.stdin, output = process.stdout, deadlineMs } = {}) {
  const reader = createInterface({ input, crlfDelay: Infinity })
  const pending = new Map()
  const expired = new Set()
  let sequence = 0
  let closedCode
  function rejectPending(code) {
    closedCode ??= code
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(fail(code)) }
    pending.clear()
  }
  reader.on('line', (line) => {
    if (closedCode) return
    try {
      if (Buffer.byteLength(line) > 4096) throw fail('CONNECTED_PROTOCOL_ERROR')
      const response = JSON.parse(line)
      if (!exactKeys(response, ['id', 'result', 'error']) || !Number.isSafeInteger(response.id) ||
          Object.hasOwn(response, 'result') === Object.hasOwn(response, 'error')) throw fail('CONNECTED_PROTOCOL_ERROR')
      // A late completed command must not prevent a subsequent stop acknowledgment.
      if (expired.has(response.id)) return
      if (!pending.has(response.id)) throw fail('CONNECTED_PROTOCOL_ERROR')
      const job = pending.get(response.id)
      clearTimeout(job.timer); pending.delete(response.id)
      // Never interpolate, retain, or print the provider's raw error.
      if (Object.hasOwn(response, 'error')) job.reject(fail('CONNECTED_PROVIDER_OPERATION_FAILED'))
      else job.resolve(response.result)
    } catch { rejectPending('CONNECTED_PROTOCOL_ERROR') }
  })
  reader.on('close', () => rejectPending('CONNECTED_TRANSPORT_CLOSED'))
  reader.on('error', () => rejectPending('CONNECTED_TRANSPORT_ERROR'))
  input.on('error', () => rejectPending('CONNECTED_TRANSPORT_ERROR'))
  output.on('error', () => rejectPending('CONNECTED_TRANSPORT_ERROR'))
  function rpc(method, payload) {
    if (!Object.hasOwn(RPC_TIMEOUTS, method)) return Promise.reject(fail('CONNECTED_PROTOCOL_ERROR'))
    if (closedCode) return Promise.reject(fail(closedCode))
    const maximum = RPC_TIMEOUTS[method], timeout = deadlineMs === undefined ? maximum : deadlineMs
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > maximum) return Promise.reject(fail('CONNECTED_PROTOCOL_ERROR'))
    const id = ++sequence
    return new Promise((resolveJob, reject) => {
      const timer = setTimeout(() => { pending.delete(id); expired.add(id); reject(fail('CONNECTED_RPC_DEADLINE')) }, timeout)
      pending.set(id, { resolve: resolveJob, reject, timer })
      try { output.write('SRD_RPC ' + JSON.stringify({ id, method, payload }) + '\n') }
      catch { rejectPending('CONNECTED_TRANSPORT_ERROR') }
    })
  }
  return { rpc, close() { rejectPending('CONNECTED_TRANSPORT_CLOSED'); reader.close() } }
}

/** SDK spelling -> equivalent REST spelling, without changing any policy. */
export function restCreateRequest(request) {
  if (!plain(request?.requestBody) || request.requestBody.networkPolicy !== 'allow-all') throw fail('REST_POLICY_NORMALIZATION_REFUSED')
  return { ...request, requestBody: { ...request.requestBody, networkPolicy: { mode: 'allow-all' } } }
}

/** ZIP downloads stay outside stdin; this accepts only a bounded metadata receipt. */
export function artifactMetadata(value) {
  if (!exactKeys(value, ['localPath', 'size', 'sha256', 'chunks', 'chunkBytes']) ||
      typeof value.localPath !== 'string' || !/^evidence\/\d{4}-\d{2}-\d{2}\/native-vercel\/evidence\.zip$/.test(value.localPath) ||
      !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > 20 * 1024 * 1024 ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) throw fail('CONNECTED_ARTIFACT_METADATA_REQUIRED')
  if (Object.hasOwn(value, 'chunks') || Object.hasOwn(value, 'chunkBytes')) {
    if (!Number.isSafeInteger(value.chunkBytes) || value.chunkBytes < 1 || value.chunkBytes > 65536 ||
        !Number.isSafeInteger(value.chunks) || value.chunks !== Math.ceil(value.size / value.chunkBytes)) throw fail('CONNECTED_ARTIFACT_METADATA_REQUIRED')
  }
  return { localPath: value.localPath, size: value.size, sha256: value.sha256,
    ...(value.chunks === undefined ? {} : { chunks: value.chunks, chunkBytes: value.chunkBytes }) }
}

function runnerTar(files) {
  if (files.length !== 1) throw fail('EXACT_REVIEWED_RUNNER_REQUIRED')
  const file = files[0], header = Buffer.alloc(512)
  const field = (value, offset, length) => header.write(value, offset, length, 'ascii')
  const octal = (n, length) => n.toString(8).padStart(length - 1, '0') + '\0'
  field(file.path, 0, 100); field(octal(file.mode, 8), 100, 8)
  field(octal(0, 8), 108, 8); field(octal(0, 8), 116, 8)
  field(octal(file.content.length, 12), 124, 12); field(octal(0, 12), 136, 12)
  field('        ', 148, 8); field('0', 156, 1); field('ustar\0', 257, 6); field('00', 263, 2)
  field([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return gzipSync(Buffer.concat([header, file.content,
    Buffer.alloc((512 - file.content.length % 512) % 512), Buffer.alloc(1024)]))
}
function responseField(result, key, pattern) {
  if (!exactKeys(result, [key]) || typeof result[key] !== 'string' || !pattern.test(result[key])) throw fail('CONNECTED_RESPONSE_INVALID')
  return result[key]
}
function acknowledgement(result) {
  if (!exactKeys(result, ['ok']) || result.ok !== true) throw fail('CONNECTED_RESPONSE_INVALID')
}

export function createFlightAdapter({ config, rpc, record }) {
  return {
    async create(request) {
      const normalized = restCreateRequest(request)
      record({ attemptName: normalized.requestBody.name, status: 'creating' })
      const result = await rpc('create', normalized)
      const sessionId = responseField(result, 'sessionId', /^sbx_[A-Za-z0-9]+$/)
      record({ sessionId, status: 'session-known' })
      return { sessionId }
    },
    async write(sessionId, files) {
      const tar = runnerTar(files)
      record({ uploadBytes: tar.length, uploadSha256: createHash('sha256').update(tar).digest('hex') })
      acknowledgement(await rpc('write', { sessionId, teamId: config.teamId, xCwd: '/vercel/sandbox', requestBody: tar.toString('base64') }))
      record({ status: 'reviewed-runner-uploaded' })
    },
    async run(sessionId, requestBody) {
      const started = await rpc('run', { sessionId, teamId: config.teamId, requestBody: { ...requestBody, wait: false } })
      const commandId = responseField(started, 'commandId', /^cmd_[A-Za-z0-9]+$/)
      record({ commandId, status: 'running' })
      const result = await rpc('wait', { sessionId, teamId: config.teamId, cmdId: commandId })
      if (!exactKeys(result, ['exitCode']) || !Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) throw fail('CONNECTED_RESPONSE_INVALID')
      record({ status: 'command-finished', commandExitCode: result.exitCode })
      return { exitCode: result.exitCode }
    },
    async read(sessionId, path) {
      const artifact = artifactMetadata(await rpc('read', { sessionId, teamId: config.teamId, requestBody: { path } }))
      record({ artifact, status: 'evidence-retrieved' })
      return artifact
    },
    async stop(sessionId) {
      try {
        acknowledgement(await rpc('stop', { sessionId, teamId: config.teamId }))
        record({ status: 'stopped', explicitStopAcknowledged: true })
      } catch (error) {
        record({ status: 'cleanup-required', cleanupNeeded: true, explicitStopAcknowledged: false, transportErrorCode: safeCode(error) })
        throw error
      }
    },
  }
}

function receiptWriter(path, initial) {
  let receipt = { ...initial, updatedAt: new Date().toISOString() }
  // Claim this receipt before returning a writer. A duplicate journal/receipt
  // invocation must never replace the prior flight's known session identity.
  let initialFd
  try { initialFd = openSync(path, 'wx', 0o600) }
  catch (error) { if (error.code === 'EEXIST') throw fail('CONNECTED_RECEIPT_ALREADY_EXISTS'); throw error }
  try { writeFileSync(initialFd, JSON.stringify(receipt, null, 2) + '\n'); fsyncSync(initialFd) }
  finally { closeSync(initialFd) }
  const initialDirectory = openSync(dirname(path), 'r')
  try { fsyncSync(initialDirectory) } finally { closeSync(initialDirectory) }
  return function record(fields) {
    receipt = { ...receipt, ...fields, updatedAt: new Date().toISOString() }
    const temporary = path + '.' + randomUUID() + '.tmp'
    let fd
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fsyncSync(fd)
      closeSync(fd); fd = undefined
      renameSync(temporary, path)
      const dir = openSync(dirname(path), 'r')
      try { fsyncSync(dir) } finally { closeSync(dir) }
    } finally {
      if (fd !== undefined) closeSync(fd)
      try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
  }
}

export async function runConnectedFlight(configPath, journalPath, { input = process.stdin, output = process.stdout } = {}) {
  let record, channel
  try {
    if (!configPath || !journalPath) throw fail('PRIVATE_CONFIG_AND_EXCLUSIVE_JOURNAL_REQUIRED')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    mkdirSync(dirname(resolve(journalPath)), { recursive: true })
    record = receiptWriter(resolve(dirname(journalPath), 'connected-session-receipt.json'), {
      kind: 'connected-native-single-flight', sourceCommit: config.sourceCommit,
      sourceRevision: config.sourceRevision, runnerSha256: config.runnerSha256, teamId: config.teamId,
      projectId: config.projectId, productionAccepted: false })
    channel = createConnectedRpc({ input, output })
    const result = await runCandidate(createFlightAdapter({ config, rpc: channel.rpc, record }), config,
      [{ path: 'native-sandbox/runner.py', mode: 0o755, content: readFileSync(new URL('./runner.py', import.meta.url)) }],
      { attemptJournalPath: journalPath })
    record({ result })
    output.write('SRD_RESULT ' + JSON.stringify(result) + '\n')
    return { exitCode: 0, result }
  } catch (error) {
    const result = { status: 'blocked-or-failed', errorCode: safeCode(error),
      cleanupNeeded: error?.cleanupNeeded === true, productionAccepted: false }
    try { record?.({ status: result.cleanupNeeded ? 'cleanup-required' : 'blocked-or-failed', ...result }) } catch { /* The controller journal retains resource identity. */ }
    try { output.write('SRD_RESULT ' + JSON.stringify(result) + '\n') } catch { /* Parent must use the durable receipt/journal. */ }
    return { exitCode: 1, result }
  } finally { channel?.close() }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = (await runConnectedFlight(process.argv[2], process.argv[3])).exitCode
}
