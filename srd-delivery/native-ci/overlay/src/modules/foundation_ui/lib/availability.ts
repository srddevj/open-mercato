export type Availability = 'healthy' | 'degraded' | 'unknown'

/** Interpret the public health contract without retaining or displaying diagnostic payloads. */
export function classifyAvailability(status: number, result: unknown): Availability {
  if (status === 503) return 'degraded'
  if (status === 200 && result !== null && typeof result === 'object' && !Array.isArray(result) &&
    (result as { status?: unknown }).status === 'ok') return 'healthy'
  return 'unknown'
}
