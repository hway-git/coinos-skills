import type { FreqtradeSnapshot } from '@helix/contracts/freqtrade'
import { appendAuditEvent, readAuditEvents } from '../audit-store'

const CACHE_TTL_MS = 10_000
const ERROR_CACHE_TTL_MS = 3_000

let cache: { expiresAt: number; payload: FreqtradeSnapshot } | null = null
let pending: Promise<FreqtradeSnapshot> | null = null

export function getCachedFreqtradeSnapshot() {
  if (!cache || cache.expiresAt <= Date.now()) return null
  return cache.payload
}

export function setCachedFreqtradeSnapshot(payload: FreqtradeSnapshot) {
  cache = {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  }
}

export function clearFreqtradeSnapshotCache() {
  cache = null
}

export function appendFreqtradeAuditEvent(event: string, result: string, actor = 'Helix') {
  appendAuditEvent(event, result, actor)
}

export function getFreqtradeAuditRows() {
  return readAuditEvents(50)
}

export async function getOrLoadFreqtradeSnapshot({
  refresh,
  load,
}: {
  refresh: boolean
  load: () => Promise<FreqtradeSnapshot>
}) {
  if (refresh) clearFreqtradeSnapshotCache()

  const cached = refresh ? null : getCachedFreqtradeSnapshot()
  if (cached) return cached
  if (!refresh && pending) return pending

  const next = load()
    .then((payload) => {
      setCachedFreqtradeSnapshot(payload)
      return payload
    })
    .finally(() => {
      if (pending === next) pending = null
    })

  pending = next
  return next
}
