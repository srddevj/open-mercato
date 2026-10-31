import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { resolveLocalizedAppMetadata } from '@/lib/metadata'

export async function generateMetadata(): Promise<Metadata> {
  return resolveLocalizedAppMetadata()
}

// Preserve the legacy entry URL without exposing installation diagnostics.
export default async function StartPage() {
  const auth = await getAuthFromCookies()
  redirect(auth ? '/backend' : '/login')
}
