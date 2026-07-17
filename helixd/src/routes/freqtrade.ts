import { Hono } from 'hono'
import type { FreqtradeEmergencyStopResult, FreqtradeReconciliationResult } from '@helix/contracts/freqtrade'
import {
  createFreqtradeStrategy,
  deployFreqtradeDryRun,
  deployFreqtradeLive,
  emergencyStopFreqtrade,
  getReadOnlyFreqtradeSnapshot,
  runReadOnlyFreqtradeBacktest,
} from '@helix/core/freqtrade/read-only'
import { reconcileFreqtradeAccount } from '@helix/core/freqtrade/reconciliation'
import {
  appendFreqtradeAuditEvent,
  clearFreqtradeSnapshotCache,
  getOrLoadFreqtradeSnapshot,
} from '@helix/core/freqtrade/snapshot-cache'
import { numberField, readJson, stringField, stringList } from '../http'
import { requireControlAccess } from '../security/control-access'
import {
  clearLiveSession,
  createLiveSession,
  getLiveSessionStatus,
  requireLiveAccess,
} from '../security/live-access'

export const freqtradeRoutes = new Hono()

type EmergencyStopActionResult =
  | { ok: true; data: FreqtradeEmergencyStopResult }
  | { ok: false; error: string }

export function finalizeFreqtradeEmergencyStop(
  result: EmergencyStopActionResult,
  reconciliation: FreqtradeReconciliationResult,
) {
  const operationError = result.ok ? null : result.error
  const base: FreqtradeEmergencyStopResult = result.ok ? result.data : {
    success: false,
    operationError,
    openTradesBefore: null,
    openTradesAfter: null,
    forceExitError: null,
    stopError: null,
    reconciliationStatus: null,
    reconciliationError: null,
    reconciliationMismatches: [],
  }
  const exchangeFlat = reconciliation.status === 'not_applicable'
    ? reconciliation.botPositions === 0
      && reconciliation.exchangePositions === 0
      && reconciliation.mismatches.length === 0
    : reconciliation.status === 'matched'
      && reconciliation.botPositions === 0
      && reconciliation.exchangePositions === 0
  return {
    ...base,
    success: base.success && exchangeFlat,
    operationError,
    reconciliationStatus: reconciliation.status,
    reconciliationError: exchangeFlat ? null : reconciliation.detail,
    reconciliationMismatches: reconciliation.mismatches,
  } satisfies FreqtradeEmergencyStopResult
}

freqtradeRoutes.get('/snapshot', async (c) => {
  const refresh = c.req.query('refresh') === '1'
  const payload = await getOrLoadFreqtradeSnapshot({ refresh, load: getReadOnlyFreqtradeSnapshot })
  return c.json(payload)
})

freqtradeRoutes.post('/backtest', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const result = await runReadOnlyFreqtradeBacktest({
    strategy: stringField(body.strategy),
    timeframe: stringField(body.timeframe),
    timerange: stringField(body.timerange),
    pairs: stringList(body.pairs),
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent('backtest_error', `${stringField(body.strategy) ?? 'unknown'} · ${result.error}`)
    clearFreqtradeSnapshotCache()
    return c.json({ ok: false, error: result.error }, 400)
  }

  clearFreqtradeSnapshotCache()
  appendFreqtradeAuditEvent(
    'backtest_finished',
    `${result.data.strategy} · ${result.data.timeframe} · ${result.data.timerange}`,
  )
  return c.json({ ok: true, result: result.data })
})

freqtradeRoutes.post('/deploy', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const result = await deployFreqtradeDryRun({
    strategy: stringField(body.strategy),
    signalArtifactHash: body.signalArtifactHash,
    walkForwardReportFile: body.walkForwardReportFile,
    pairs: stringList(body.pairs),
    maxOpenTrades: numberField(body.maxOpenTrades),
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent('dry_run_deploy_error', `${stringField(body.strategy) ?? 'unknown'} · ${result.error}`)
    clearFreqtradeSnapshotCache()
    return c.json({ ok: false, error: result.error }, 400)
  }

  clearFreqtradeSnapshotCache()
  appendFreqtradeAuditEvent(
    'dry_run_deployed',
    `${result.data.strategy} · ${result.data.signalArtifactHash ?? 'no-artifact'} · ${result.data.forwardRuntime?.state ?? 'static'} · ${result.data.pairs.length || 'existing'} pairs · max ${result.data.maxOpenTrades ?? '--'}`,
  )
  return c.json({ ok: true, result: result.data })
})

freqtradeRoutes.post('/strategy', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const result = await createFreqtradeStrategy({
    name: stringField(body.name),
    timeframe: stringField(body.timeframe),
    direction: body.direction === 'short' || body.direction === 'both' ? body.direction : 'long',
    indicators: stringList(body.indicators),
  })

  if (!result.ok) {
    appendFreqtradeAuditEvent('strategy_error', `${stringField(body.name) ?? 'unknown'} · ${result.error}`)
    clearFreqtradeSnapshotCache()
    return c.json({ ok: false, error: result.error }, 400)
  }

  clearFreqtradeSnapshotCache()
  appendFreqtradeAuditEvent(
    'strategy_created',
    `${result.data.strategy} · ${result.data.timeframe} · ${result.data.direction}`,
  )
  return c.json({ ok: true, result: result.data })
})

freqtradeRoutes.post('/emergency-stop', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const result = await emergencyStopFreqtrade()
  clearFreqtradeSnapshotCache()
  const reconciliation = await reconcileFreqtradeAccount().catch((error) => ({
    status: 'offline' as const,
    checkedAt: Date.now(),
    botPositions: 0,
    exchangePositions: 0,
    mismatches: [],
    detail: error instanceof Error ? error.message : 'reconciliation failed',
  }))
  const emergency = finalizeFreqtradeEmergencyStop(result, reconciliation)
  const operationError = emergency.operationError
  const summary = `operation ${emergency.operationError ?? 'ok'} · open ${emergency.openTradesBefore ?? '--'} -> ${emergency.openTradesAfter ?? '--'} · force ${emergency.forceExitError ?? 'ok'} · stop ${emergency.stopError ?? 'ok'} · reconcile ${emergency.reconciliationError ?? emergency.reconciliationStatus}`
  appendFreqtradeAuditEvent(emergency.success ? 'emergency_stop' : 'emergency_stop_error', summary, 'Operator')
  return c.json(
    { ok: emergency.success, ...(operationError ? { error: operationError } : {}), result: emergency },
    emergency.success ? 200 : 502,
  )
})

freqtradeRoutes.post('/reconcile', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const result = await reconcileFreqtradeAccount()
  appendFreqtradeAuditEvent(
    'reconciliation',
    `${result.status} · bot ${result.botPositions} · exchange ${result.exchangePositions} · mismatch ${result.mismatches.length}`,
    'Operator',
  )
  return c.json(
    { ok: result.status !== 'offline', result },
    result.status === 'offline' ? 503 : 200,
  )
})

freqtradeRoutes.get('/live/session', (c) => c.json({ ok: true, session: getLiveSessionStatus(c) }))

freqtradeRoutes.post('/live/session', async (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  const body = await readJson(c)
  const response = createLiveSession(c, body.token)
  appendFreqtradeAuditEvent(
    response.status < 400 ? 'live_authorized' : 'live_authorization_denied',
    response.status < 400 ? '10 minute session' : `HTTP ${response.status}`,
    'Operator',
  )
  return response
})

freqtradeRoutes.delete('/live/session', (c) => {
  const denied = requireControlAccess(c)
  if (denied) return denied

  appendFreqtradeAuditEvent('live_authorization_revoked', 'session cleared', 'Operator')
  return clearLiveSession(c)
})

freqtradeRoutes.post('/live/deploy', async (c) => {
  const denied = requireControlAccess(c) || requireLiveAccess(c)
  if (denied) {
    appendFreqtradeAuditEvent('live_deploy_denied', `HTTP ${denied.status}`, 'Operator')
    return denied
  }

  const body = await readJson(c)
  const result = await deployFreqtradeLive({
    strategy: stringField(body.strategy),
    signalArtifactHash: body.signalArtifactHash,
    walkForwardReportFile: body.walkForwardReportFile,
    pairs: stringList(body.pairs),
    maxOpenTrades: numberField(body.maxOpenTrades),
  })
  clearFreqtradeSnapshotCache()

  if (!result.ok) {
    appendFreqtradeAuditEvent('live_deploy_denied', result.error, 'Operator')
    return c.json({ ok: false, error: result.error }, 400)
  }

  appendFreqtradeAuditEvent(
    'live_deployed',
    `${result.data.strategy} · ${result.data.signalArtifactHash ?? 'no-artifact'} · ${result.data.pairs.length || 'existing'} pairs · max ${result.data.maxOpenTrades}`,
    'Operator',
  )
  return c.json({ ok: true, result: result.data })
})
