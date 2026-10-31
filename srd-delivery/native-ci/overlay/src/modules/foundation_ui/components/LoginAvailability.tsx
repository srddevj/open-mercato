'use client'

import * as React from 'react'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { Button } from '@open-mercato/ui/primitives/button'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { classifyAvailability } from '../lib/availability'
import type { Availability } from '../lib/availability'

export const AVAILABILITY_TIMEOUT_MS = 8000

type Check = {
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
}

export function LoginAvailabilityNotice() {
  const t = useT()
  const [availability, setAvailability] = React.useState<Availability | null>(null)
  const [checking, setChecking] = React.useState(false)
  const mounted = React.useRef(false)
  const active = React.useRef<Check | null>(null)

  const checkAvailability = React.useCallback(() => {
    if (!mounted.current || active.current) return
    const request: Check = { controller: new AbortController() }
    active.current = request
    setChecking(true)
    const finish = (next: Availability) => {
      // A timed-out, superseded or unmounted request cannot change the current notice.
      if (!mounted.current || active.current !== request) return
      clearTimeout(request.timer)
      active.current = null
      setAvailability(next)
      setChecking(false)
    }
    request.timer = setTimeout(() => {
      request.controller.abort()
      finish('unknown')
    }, AVAILABILITY_TIMEOUT_MS)
    void apiCall<unknown>('/api/healthz', {
      method: 'GET',
      cache: 'no-store',
      signal: request.controller.signal,
      headers: {
        accept: 'application/json',
        'x-om-unauthorized-redirect': '0',
        'x-om-forbidden-redirect': '0',
      },
    }).then((response) => {
      finish(classifyAvailability(response.status, response.result))
    }).catch(() => {
      finish('unknown')
    })
  }, [])

  React.useEffect(() => {
    mounted.current = true
    checkAvailability()
    return () => {
      mounted.current = false
      const request = active.current
      active.current = null
      if (request) {
        clearTimeout(request.timer)
        request.controller.abort()
      }
    }
  }, [checkAvailability])

  if (availability === null || availability === 'healthy') return null
  return (
    <Alert status="warning" style="lighter" className="mb-4" aria-live="polite" aria-atomic="true" aria-busy={checking}
      footer={(
        <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={checking} onClick={checkAvailability}>
          {checking
            ? t('foundation_ui.login.availability.checking', 'Checking…')
            : t('foundation_ui.login.availability.retry', 'Retry availability check')}
        </Button>
      )}
    >
      <AlertDescription>
        {availability === 'degraded'
          ? t('foundation_ui.login.availability.degraded', 'Some services are temporarily unavailable. You can still try signing in, or check again.')
          : t('foundation_ui.login.availability.unknown', 'We could not check service availability. You can still try signing in, or check again.')}
      </AlertDescription>
    </Alert>
  )
}

/** Pure composition: native props/children, form state, SSO and redirects remain owned by the host. */
export function withLoginAvailability<TProps>(Original: React.ComponentType<TProps>): React.ComponentType<TProps> {
  function LoginAvailabilitySection(props: TProps) {
    return (
      <>
        <LoginAvailabilityNotice />
        <Original {...(props as TProps & React.JSX.IntrinsicAttributes)} />
      </>
    )
  }
  LoginAvailabilitySection.displayName = 'LoginAvailabilitySection'
  return LoginAvailabilitySection
}
