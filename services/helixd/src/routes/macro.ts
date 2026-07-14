import { Hono } from 'hono'
import type { MacroSnapshot } from '@helix/contracts/market'
import { getFredMacroSnapshot } from '@helix/core/macro/fred'

const CACHE_TTL_MS = 300_000
const ERROR_CACHE_TTL_MS = 10_000
let macroCache: { expiresAt: number; payload: MacroSnapshot } | null = null

export const macroRoutes = new Hono()

macroRoutes.get('/snapshot', async (c) => {
  if (macroCache && macroCache.expiresAt > Date.now()) return c.json(macroCache.payload)

  const payload = await getFredMacroSnapshot()
  macroCache = {
    expiresAt: Date.now() + (payload.ok ? CACHE_TTL_MS : ERROR_CACHE_TTL_MS),
    payload,
  }
  return c.json(payload)
})
