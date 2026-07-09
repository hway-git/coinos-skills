import { NextResponse, type NextRequest } from 'next/server'
import type { MarketNewsSnapshot } from '@/lib/market-data'
import { getFreeChineseCryptoNews } from '@/lib/server/market-news/free-cn-rss'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const CACHE_TTL_MS = 60_000
const ERROR_CACHE_TTL_MS = 10_000
const newsCache = new Map<string, { expiresAt: number; payload: MarketNewsSnapshot }>()

function clampLimit(value: string | null) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed)) return 24
  return Math.min(Math.max(parsed, 1), 50)
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const limit = clampLimit(url.searchParams.get('limit'))
  const cacheKey = `free-cn-v3:${limit}`
  const cached = newsCache.get(cacheKey)

  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json(cached.payload, { headers: { 'Cache-Control': 'no-store' } })
  }

  const payload = await getFreeChineseCryptoNews(limit)
  newsCache.set(cacheKey, {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  })

  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
