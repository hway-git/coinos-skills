import { NextResponse } from 'next/server'
import type { MacroSnapshot } from '@/lib/market-data'
import { getFredMacroSnapshot } from '@/lib/server/macro/fred'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CACHE_TTL_MS = 300_000
const ERROR_CACHE_TTL_MS = 10_000
let macroCache: { expiresAt: number; payload: MacroSnapshot } | null = null

export async function GET() {
  if (macroCache && macroCache.expiresAt > Date.now()) {
    return NextResponse.json(macroCache.payload, { headers: { 'Cache-Control': 'no-store' } })
  }

  const payload = await getFredMacroSnapshot()
  macroCache = {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  }

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
