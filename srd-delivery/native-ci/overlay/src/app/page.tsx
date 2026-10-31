import { redirect } from 'next/navigation'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'

function isAutoLoginEnabled(): boolean {
  return Boolean(process.env.OM_AUTOLOGIN_EMAIL?.trim() && process.env.OM_AUTOLOGIN_PASSWORD)
}

// Public entry uses the native session boundary before selecting a destination.
export default async function Home() {
  const auth = await getAuthFromCookies()

  // Demo autologin: when OM_AUTOLOGIN_* credentials are configured and there is
  // no active session, hand off to the autologin route which signs the visitor
  // in and drops them into the app. Fully gated behind env vars — with them
  // unset, visitors use the manual login form. The route falls back to /login when the
  // credentials are invalid, so a misconfigured demo can never loop.
  if (!auth && isAutoLoginEnabled()) {
    redirect('/api/auth/autologin')
  }

  redirect(auth ? '/backend' : '/login')
}
