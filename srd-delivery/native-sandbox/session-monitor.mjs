/** Observe one already-authorized session. Importing never calls a provider. */
export const COMPLETION_PATH = '/vercel/sandbox/srd-native-run/completion.json'
const MARKER_KEYS = ['kind', 'sourceCommit', 'sourceRevision', 'status', 'exitCode', 'artifactReady']
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => plain(value) && Object.keys(value).every(key => allowed.includes(key))
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/**
 * Adapter results are normalized by the caller, never raw tool/log payloads:
 * readSession -> {sessionId,status,resources:{vcpus,memoryMiB,timeoutMs,region,persistent,ports}}
 * probeCompletion -> {sessionId,marker:null|object,artifactReady:boolean}
 * readCommand -> {sessionId,commandId,exitCode:null|integer}; args include wait.
 * The caller retrieves evidence before its finally-stop. This observer never stops.
 */
export async function monitorSession({ adapter, expected, deadlineAtMs, now = Date.now,
  pause = sleep, pollMs = 5000, observerTimeoutMs = 15000, onObservation = () => {} }) {
  if (!/^sbx_[A-Za-z0-9]+$/.test(expected?.sessionId ?? '') ||
      !/^cmd_[A-Za-z0-9]+$/.test(expected?.commandId ?? '') ||
      !/^[a-f0-9]{40}$/.test(expected?.sourceCommit ?? '') ||
      !/^[a-f0-9]{64}$/.test(expected?.sourceRevision ?? '') ||
      !Number.isSafeInteger(expected.timeoutMs ?? 2700000) || (expected.timeoutMs ?? 2700000) < 60000 ||
      (expected.timeoutMs ?? 2700000) > 2700000 ||
      !Number.isFinite(deadlineAtMs) || !Number.isFinite(pollMs) || pollMs < 1 || pollMs > 30000 ||
      !Number.isFinite(observerTimeoutMs) || observerTimeoutMs < 1 || observerTimeoutMs > 30000 ||
      ['readSession', 'probeCompletion', 'readCommand'].some(key => typeof adapter?.[key] !== 'function')) {
    throw new Error('MONITOR_CONFIGURATION_INVALID')
  }
  let observerFailures = 0
  const inFlight = new Map()
  const outcome = (status, extra = {}) => ({ status, observerFailures,
    productFailureEstablished: false, productionAccepted: false, ...extra })
  const blocked = code => outcome('blocked', { code, cleanupNeeded: true, executionSucceeded: false })
  async function observe(method, args, key = method, operation = () => adapter[method](args)) {
    // Reuse a timed-out read instead of piling up still-pending long polls.
    let pending = inFlight.get(key)
    if (!pending) {
      pending = Promise.resolve().then(operation)
        .then(value => ({ available: true, value }), () => ({ available: false }))
      inFlight.set(key, pending)
    }
    let timer
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ available: false, timedOut: true }),
        Math.max(0, Math.min(observerTimeoutMs, deadlineAtMs - now())))
    })
    try {
      const result = await Promise.race([pending, timeout])
      if (!result.timedOut) inFlight.delete(key)
      if (!result.available) observerFailures++
      return result
    } finally { clearTimeout(timer) }
  }
  const request = { sessionId: expected.sessionId, commandId: expected.commandId }
  while (now() < deadlineAtMs) {
    const session = await observe('readSession', { sessionId: expected.sessionId })
    if (now() >= deadlineAtMs) break
    if (session.available) {
      const value = session.value
      if (!plain(value) || value.sessionId !== expected.sessionId) return blocked('SESSION_IDENTITY_MISMATCH')
      const r = value.resources
      if (!plain(r) || r.vcpus !== 4 || r.memoryMiB !== 8192 || r.timeoutMs !== (expected.timeoutMs ?? 2700000) ||
          r.region !== 'iad1' || r.persistent !== false || !Array.isArray(r.ports) || r.ports.length) {
        return blocked('SESSION_RESOURCE_MISMATCH')
      }
      if (!['running', 'stopped', 'stopping'].includes(value.status)) return blocked('SESSION_STATE_INVALID')
      const probe = await observe('probeCompletion', { sessionId: expected.sessionId, path: COMPLETION_PATH })
      if (now() >= deadlineAtMs) break
      let marker
      if (probe.available) {
        const p = probe.value
        if (!keys(p, ['sessionId', 'marker', 'artifactReady']) || p.sessionId !== expected.sessionId ||
            typeof p.artifactReady !== 'boolean' || !Object.hasOwn(p, 'marker')) return blocked('COMPLETION_PROBE_INVALID')
        if (p.marker !== null) {
          marker = p.marker
          if (!keys(marker, MARKER_KEYS) || Object.keys(marker).length !== MARKER_KEYS.length ||
              marker.kind !== 'native-verification-completion-v1' || marker.sourceCommit !== expected.sourceCommit ||
              marker.sourceRevision !== expected.sourceRevision || !['blocked', 'executed-awaiting-independent-review'].includes(marker.status) ||
              ![0, 2].includes(marker.exitCode) || typeof marker.artifactReady !== 'boolean' ||
              marker.artifactReady !== p.artifactReady ||
              (marker.exitCode === 0 && (marker.status !== 'executed-awaiting-independent-review' || !marker.artifactReady)) ||
              (marker.exitCode === 2 && marker.status !== 'blocked')) {
            return blocked('COMPLETION_MARKER_INVALID')
          }
        }
      }
      // Never hold a wait=true request open during installation/build/browser work.
      const command = await observe('readCommand', { ...request, wait: !!marker }, marker ? 'terminalCommand' : 'runningCommand')
      if (now() >= deadlineAtMs) break
      if (command.available) {
        const c = command.value
        if (!keys(c, ['sessionId', 'commandId', 'exitCode']) || c.sessionId !== expected.sessionId ||
            c.commandId !== expected.commandId || (c.exitCode !== null &&
              (!Number.isSafeInteger(c.exitCode) || c.exitCode < 0 || c.exitCode > 255))) return blocked('COMMAND_IDENTITY_OR_STATUS_INVALID')
        if (c.exitCode !== null) {
          if (marker && c.exitCode !== marker.exitCode) return blocked('COMPLETION_EXIT_MISMATCH')
          if (c.exitCode !== 0 || marker) return outcome('command-finished', { exitCode: c.exitCode,
            markerVerified: !!marker, artifactReady: marker?.artifactReady ?? false,
            executionSucceeded: c.exitCode === 0 && !!marker, cleanupNeeded: true })
        }
      }
      if (value.status !== 'running') return blocked('SESSION_STOPPED_WITHOUT_VERIFIED_COMPLETION')
    }
    // Presentation or logging failures must not turn observation into cancellation.
    await observe('onObservation', undefined, 'presentation', () => onObservation(outcome('unknown')))
    if (now() < deadlineAtMs) await pause(Math.min(pollMs, deadlineAtMs - now()))
  }
  return blocked('MONITOR_DEADLINE')
}
