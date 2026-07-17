import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  StrategyHistoricalRiskTracePayload,
  StrategyHistoricalScalpRiskTraceEntry,
  StrategyHistoricalSwingRiskTraceEntry,
  StrategyObjectModel,
  StrategyPositionSide,
  StrategySignalRecord,
} from '@helix/contracts/strategy'
import {
  assertStrategyHistoricalRiskTrace,
  createStrategyHistoricalRiskTrace,
} from './historical-risk'
import { createStrategySignalArtifact } from './signal-artifact'

const minute = 60_000

function signalArtifact(options: {
  objectModel?: StrategyObjectModel
  side?: StrategyPositionSide
  twoEntries?: boolean
} = {}) {
  const objectModel = options.objectModel ?? 'PRICE_EVENT'
  const side = options.side ?? 'LONG'
  const signal = (
    sequence: number,
    signalId: string,
    objectId: string,
    action: 'ENTER' | 'EXIT',
    sourceCandleOpenTime: number,
  ): StrategySignalRecord => ({
    sequence,
    signalId,
    decisionId: `${signalId}:decision`,
    object: { model: objectModel, id: objectId },
    action,
    side,
    sourceCandleOpenTime,
    decisionTime: sourceCandleOpenTime + minute,
    reasonCodes: [action === 'ENTER' ? 'EXECUTION_TRIGGERED' : 'TARGET_HIT'],
  })
  const signals = options.twoEntries
    ? [
        signal(0, 'entry-1', 'object-1', 'ENTER', 0),
        signal(1, 'exit-1', 'object-1', 'EXIT', minute),
        signal(2, 'entry-2', 'object-2', 'ENTER', 2 * minute),
      ]
    : [signal(0, 'entry-1', 'object-1', 'ENTER', 0)]
  return createStrategySignalArtifact({
    schemaVersion: 'helix.signal-artifact/v1',
    identity: {
      strategyId: objectModel === 'PRICE_EVENT' ? 'helix_scalp_hunter' : 'helix_swing_hunter',
      strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: `sha256:${'d'.repeat(64)}`,
    },
    strategyLifecycle: 'proposal',
    objectModel,
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    marketData: {
      firstCandleOpenTime: 0,
      lastCandleCloseTime: options.twoEntries ? 3 * minute : minute,
    },
    signals,
  })
}

function scalpEntry(
  overrides: Partial<StrategyHistoricalScalpRiskTraceEntry> = {},
): StrategyHistoricalScalpRiskTraceEntry {
  return {
    entrySignalId: 'entry-1',
    family: 'scalp',
    object: { model: 'PRICE_EVENT', id: 'object-1' },
    side: 'LONG',
    entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: 100 },
    initialStop: 95,
    initialTarget: 110,
    riskDistance: 5,
    riskR: 0.35,
    scalp: {
      eventType: 'LIQUIDITY_SWEEP',
      grade: 'A_PLUS',
      regime: { id: 'regime-1', type: 'RANGING' },
    },
    ...overrides,
  }
}

function swingEntry(
  overrides: Partial<StrategyHistoricalSwingRiskTraceEntry> = {},
): StrategyHistoricalSwingRiskTraceEntry {
  return {
    entrySignalId: 'entry-1',
    family: 'swing',
    object: { model: 'TRADE_THESIS', id: 'object-1' },
    side: 'SHORT',
    entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: 100 },
    initialStop: 105,
    initialTarget: 90,
    riskDistance: 5,
    riskR: 0.4,
    swing: {
      stage: 'CONFIRMED',
      context: { id: 'context-1', state: 'BEARISH_TREND', bias: 'BEARISH' },
    },
    ...overrides,
  }
}

function payload(
  artifact: ReturnType<typeof signalArtifact>,
  entries: StrategyHistoricalRiskTracePayload['entries'],
): StrategyHistoricalRiskTracePayload {
  return {
    schemaVersion: 'helix.historical-risk-trace/v1',
    signalArtifactHash: artifact.artifactHash,
    entries,
  }
}

test('creates a hash-pinned trace and rejects valid-shape hash tampering', () => {
  const artifact = signalArtifact()
  const trace = createStrategyHistoricalRiskTrace(payload(artifact, [scalpEntry()]), artifact)

  assert.match(trace.traceHash, /^sha256:[a-f0-9]{64}$/)
  assert.equal(Object.isFrozen(trace.entries[0]!.entryPrice), true)
  assert.deepEqual(assertStrategyHistoricalRiskTrace(structuredClone(trace), artifact), trace)

  const tampered = structuredClone(trace) as unknown as {
    entries: Array<{ scalp: { grade: string } }>
  }
  tampered.entries[0]!.scalp.grade = 'A'
  assert.throws(
    () => assertStrategyHistoricalRiskTrace(tampered, artifact),
    /historical risk trace hash mismatch/,
  )
})

test('requires exactly one ordered, unique risk entry for every Artifact ENTER', () => {
  const artifact = signalArtifact({ twoEntries: true })
  const entries = [
    scalpEntry(),
    scalpEntry({ entrySignalId: 'entry-2', object: { model: 'PRICE_EVENT', id: 'object-2' } }),
  ]

  assert.doesNotThrow(() => createStrategyHistoricalRiskTrace(payload(artifact, entries), artifact))
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, entries.slice(0, 1)), artifact),
    /exactly one entry for every signal Artifact ENTER/,
  )
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [
      ...entries,
      scalpEntry({ entrySignalId: 'entry-3', object: { model: 'PRICE_EVENT', id: 'object-3' } }),
    ]), artifact),
    /exactly one entry for every signal Artifact ENTER/,
  )
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [entries[0]!, entries[0]!]), artifact),
    /duplicate historical risk entrySignalId/,
  )
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [...entries].reverse()), artifact),
    /must follow signal Artifact ENTER order/,
  )
})

test('enforces entry geometry, finite positive risk, and Artifact linkage', () => {
  const artifact = signalArtifact()
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [scalpEntry({ riskDistance: 4 })]), artifact),
    /riskDistance must equal/,
  )
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [scalpEntry({
      initialStop: 105,
      riskDistance: 5,
    })]), artifact),
    /LONG risk/,
  )
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [scalpEntry({ riskR: 0 })]), artifact),
    /riskR must be finite and positive/,
  )
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [scalpEntry({
      object: { model: 'PRICE_EVENT', id: 'other-object' },
    })]), artifact),
    /object does not match/,
  )
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [scalpEntry({
      side: 'SHORT', initialStop: 105, initialTarget: 90,
    })]), artifact),
    /side does not match/,
  )
})

test('enforces the Swing family/model and SHORT direction', () => {
  const artifact = signalArtifact({ objectModel: 'TRADE_THESIS', side: 'SHORT' })
  assert.doesNotThrow(() => createStrategyHistoricalRiskTrace(payload(artifact, [swingEntry()]), artifact))
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [swingEntry({
      initialStop: 95,
      riskDistance: 5,
    })]), artifact),
    /SHORT risk/,
  )

  const wrongFamily = scalpEntry({
    side: 'SHORT',
    initialStop: 105,
    initialTarget: 90,
  })
  assert.throws(
    () => createStrategyHistoricalRiskTrace(payload(artifact, [wrongFamily]), artifact),
    /family\/model does not match/,
  )
})
