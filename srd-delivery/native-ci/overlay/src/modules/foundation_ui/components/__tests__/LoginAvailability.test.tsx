/** @jest-environment jsdom */
/** Controlled component fixtures only; healthy native recovery is not verified by these tests. */
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@open-mercato/shared/lib/i18n/context'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import type { ApiCallResult } from '@open-mercato/ui/backend/utils/apiCall'
import { AVAILABILITY_TIMEOUT_MS, LoginAvailabilityNotice, withLoginAvailability } from '../LoginAvailability'
import { classifyAvailability } from '../../lib/availability'
import { componentOverrides } from '../../widgets/components'

jest.mock('@open-mercato/ui/backend/utils/apiCall', () => ({ apiCall: jest.fn() }))
const mockApiCall = jest.mocked(apiCall)

function response(status: number, result: unknown): ApiCallResult<unknown> {
  return { ok: status >= 200 && status < 300, status, result, response: {} as Response, cacheStatus: null }
}
function deferred() {
  let resolve!: (value: ApiCallResult<unknown>) => void
  const promise = new Promise<ApiCallResult<unknown>>((done) => { resolve = done })
  return { promise, resolve }
}
async function flush() { await act(async () => { await Promise.resolve() }) }
function mountNotice(children: React.ReactNode = <LoginAvailabilityNotice />) {
  return render(<I18nProvider locale="en" dict={{}}>{children}</I18nProvider>)
}

beforeEach(() => { jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }); mockApiCall.mockReset() })
afterEach(() => { cleanup(); jest.useRealTimers() })

describe('public availability contract', () => {
  test('only HTTP 200 with status ok is healthy; 503 is degraded and all other shapes are unknown', () => {
    expect(classifyAvailability(200, { status: 'ok' })).toBe('healthy')
    expect(classifyAvailability(503, { status: 'ok', error: 'SENTINEL_DIAGNOSTIC' })).toBe('degraded')
    for (const value of [null, 'ok', [], { status: 'degraded' }, { status: true }, {}]) expect(classifyAvailability(200, value)).toBe('unknown')
    for (const status of [0, 201, 204, 401, 403, 500]) expect(classifyAvailability(status, { status: 'ok' })).toBe('unknown')
  })

  test('the exact native section is wrapped once without replacing props or starting checks at composition time', () => {
    expect(componentOverrides).toHaveLength(1)
    const override = componentOverrides[0]
    expect(override.target.componentId).toBe('section:auth.login.form')
    expect(override.metadata?.module).toBe('foundation_ui')
    expect('wrapper' in override).toBe(true)
    expect('replacement' in override).toBe(false)
    const Original = () => null
    withLoginAvailability(Original)
    expect(mockApiCall).not.toHaveBeenCalled()
  })

  test('one initial uncached, cancellable read hides the banner on a healthy fixture without polling', async () => {
    mockApiCall.mockResolvedValue(response(200, { status: 'ok' }))
    mountNotice()
    await flush()
    expect(mockApiCall).toHaveBeenCalledTimes(1)
    expect(mockApiCall).toHaveBeenCalledWith('/api/healthz', expect.objectContaining({ method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal) }))
    expect(screen.queryByRole('alert')).toBeNull()
    act(() => { jest.advanceTimersByTime(60000) })
    expect(mockApiCall).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  test('degraded to retry to healthy keeps the mounted native form, inputs, children and submit behavior intact', async () => {
    const retry = deferred()
    mockApiCall.mockResolvedValueOnce(response(503, { error: 'SENTINEL_CONNECTION_PASSWORD', status: 'degraded' })).mockReturnValueOnce(retry.promise)
    const submit = jest.fn<(event: React.FormEvent<HTMLFormElement>) => void>((event) => { event.preventDefault() })
    let mounts = 0
    function Original(values: { children?: React.ReactNode; redirect: string }) {
      React.useEffect(() => { mounts++ }, [])
      return <form onSubmit={submit} data-testid="native-form" data-redirect={values.redirect}>
        <label>Email<input name="email" /></label><label>Password<input name="password" type="password" /></label>
        {values.children}<button type="submit">Sign in</button>
      </form>
    }
    const Wrapped = withLoginAvailability(Original)
    mountNotice(<Wrapped redirect="/backend/customers/people"><a href="https://sso.srd.invalid/existing">Existing SSO</a></Wrapped>)
    const form = screen.getByTestId('native-form')
    const email = screen.getByLabelText('Email') as HTMLInputElement
    const password = screen.getByLabelText('Password') as HTMLInputElement
    fireEvent.change(email, { target: { value: 'synthetic@srd.invalid' } })
    fireEvent.change(password, { target: { value: 'SENTINEL_TYPED_PASSWORD' } })
    email.focus()
    await flush()
    expect(document.activeElement).toBe(email)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveAttribute('aria-live', 'polite')
    expect(alert).toHaveAttribute('data-status', 'warning')
    expect(alert.textContent).toContain('Some services are temporarily unavailable')
    expect(alert.textContent).not.toContain('SENTINEL')
    const button = screen.getByRole('button', { name: 'Retry availability check' })
    expect(button).toHaveAttribute('type', 'button')
    expect(form.contains(button)).toBe(false)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mockApiCall).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Sign in' })).not.toBeDisabled()
    email.focus()
    await act(async () => { retry.resolve(response(200, { status: 'ok' })) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('native-form')).toBe(form)
    expect(screen.getByLabelText('Email')).toBe(email)
    expect(email.value).toBe('synthetic@srd.invalid')
    expect(password.value).toBe('SENTINEL_TYPED_PASSWORD')
    expect(document.activeElement).toBe(email)
    expect(mounts).toBe(1)
    expect(form).toHaveAttribute('data-redirect', '/backend/customers/people')
    expect(screen.getByRole('link', { name: 'Existing SSO' })).toHaveAttribute('href', 'https://sso.srd.invalid/existing')
    fireEvent.submit(form)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(mockApiCall).toHaveBeenCalledTimes(2)
  })

  test('network failure and malformed healthy payload show generic check warnings without diagnostic body/error text', async () => {
    mockApiCall.mockRejectedValueOnce(new Error('SENTINEL_SECRET_DATABASE_URL')).mockResolvedValueOnce(response(200, { status: 'SENTINEL_BAD_STATUS', details: 'SENTINEL_SECRET' }))
    mountNotice()
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('We could not check service availability')
    expect(screen.getByRole('alert').textContent).not.toContain('SENTINEL')
    fireEvent.click(screen.getByRole('button', { name: 'Retry availability check' }))
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('We could not check service availability')
    expect(screen.getByRole('alert').textContent).not.toContain('SENTINEL')
    expect(mockApiCall).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
  })

  test('timeout aborts the check, allows manual retry, and ignores the old late healthy result', async () => {
    const first = deferred()
    const retry = deferred()
    mockApiCall.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
    mountNotice()
    const firstSignal = mockApiCall.mock.calls[0][1]?.signal
    act(() => { jest.advanceTimersByTime(AVAILABILITY_TIMEOUT_MS) })
    expect(firstSignal?.aborted).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('We could not check service availability')
    fireEvent.click(screen.getByRole('button', { name: 'Retry availability check' }))
    await act(async () => { first.resolve(response(200, { status: 'ok' })) })
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled()
    await act(async () => { retry.resolve(response(503, { status: 'degraded' })) })
    expect(screen.getByRole('alert').textContent).toContain('Some services are temporarily unavailable')
    expect(screen.getByRole('button', { name: 'Retry availability check' })).not.toBeDisabled()
    expect(jest.getTimerCount()).toBe(0)
  })

  test('unmount cancels the read and timer; a later result cannot mount a notice', async () => {
    const pending = deferred()
    mockApiCall.mockReturnValueOnce(pending.promise)
    const view = mountNotice()
    const signal = mockApiCall.mock.calls[0][1]?.signal
    view.unmount()
    expect(signal?.aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
    await act(async () => { pending.resolve(response(503, { status: 'degraded' })) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mockApiCall).toHaveBeenCalledTimes(1)
  })

  test('StrictMode cleanup aborts the first effect and ignores its stale result after remount', async () => {
    const old = deferred()
    const current = deferred()
    mockApiCall.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    render(<React.StrictMode><I18nProvider locale="en" dict={{}}><LoginAvailabilityNotice /></I18nProvider></React.StrictMode>)
    expect(mockApiCall).toHaveBeenCalledTimes(2)
    expect(mockApiCall.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(mockApiCall.mock.calls[1][1]?.signal?.aborted).toBe(false)
    await act(async () => { current.resolve(response(503, { status: 'degraded' })) })
    await act(async () => { old.resolve(response(200, { status: 'ok' })) })
    expect(screen.getByRole('alert').textContent).toContain('Some services are temporarily unavailable')
    expect(jest.getTimerCount()).toBe(0)
  })

  test('notice and retry copy resolve through module translation keys', async () => {
    mockApiCall.mockResolvedValue(response(503, null))
    render(<I18nProvider locale="pl" dict={{
      'foundation_ui.login.availability.degraded': 'Kontrolowany komunikat testowy',
      'foundation_ui.login.availability.retry': 'Ponów sprawdzanie',
    }}><LoginAvailabilityNotice /></I18nProvider>)
    await flush()
    expect(screen.getByRole('alert').textContent).toContain('Kontrolowany komunikat testowy')
    expect(screen.getByRole('button', { name: 'Ponów sprawdzanie' })).toBeInTheDocument()
  })
})
