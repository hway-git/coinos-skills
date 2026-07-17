import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {
  Candle,
} from '@helix/contracts/market'
import type {
  StrategyHistoricalDataset,
  StrategyPositionSide,
  StrategyRepositorySnapshot,
  StrategySignalBatch,
  StrategySignalPosition,
} from '@helix/contracts/strategy'
import { assertStrategyHistoricalDataset, createStrategyHistoricalDataset } from './historical-dataset'
import {
  historicalDecisionContexts,
  type HistoricalDecisionContext,
} from './historical-runner'
import {
  assertStrategyForwardDataset,
  requireCurrentStrategyForwardDeployment,
  strategyForwardDecisionStateHash,
  strategyForwardFirstDecisionTime,
  STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
  type StrategyForwardDecisionStatePayload,
  type StrategyForwardDeployment,
} from './forward-runtime'
import { createStrategyDecisionIdentityFromSnapshot } from './repository'
import { createStrategySignalBatch } from './signal-batch'
import { strategyTimeframeMilliseconds } from './signal-artifact'
import {
  createStrategyEvaluator,
  type StrategyEvaluatorCheckpoint,
} from './strategy-evaluator'

export const STRATEGY_FORWARD_CHECKPOINT_SCHEMA_VERSION = 'helix.forward-checkpoint/v1' as const
export const STRATEGY_FORWARD_NO_SIGNAL_JOURNAL_SCHEMA_VERSION = 'helix.forward-no-signal-journal/v1' as const
export const STRATEGY_FORWARD_NO_SIGNAL_CAPACITY = 512

type UnknownRecord = Record<string, unknown>

export type StrategyForwardNoSignalRecord = Readonly<{
  decisionTime: number
  marketDataSnapshotId: string
  previousDecisionStateHash: string | null
  evaluatorStateHash: string
  decisionStateHash: string
  position: StrategySignalPosition | null
}>

export type StrategyForwardNoSignalJournal = Readonly<{
  schemaVersion: typeof STRATEGY_FORWARD_NO_SIGNAL_JOURNAL_SCHEMA_VERSION
  deploymentHash: string
  capacity: typeof STRATEGY_FORWARD_NO_SIGNAL_CAPACITY
  total: number
  discarded: number
  lastDiscardedDecisionStateHash: string | null
  entries: readonly StrategyForwardNoSignalRecord[]
}>


export type StrategyForwardCheckpointPayload = Readonly<{
  schemaVersion: typeof STRATEGY_FORWARD_CHECKPOINT_SCHEMA_VERSION
  deploymentHash: string
  checkpointedAt: number
  lastDecisionTime: number
  processedSnapshotHash: string
  position: StrategySignalPosition | null
  batchCount: number
  lastBatchHash: string | null
  evaluatorStateHash: string
  decisionStateHash: string
  lastDecisionBatchHash: string | null
  lastDecisionBatchDecisionStateHash: string | null
  evaluator: StrategyEvaluatorCheckpoint
  noSignalJournal: StrategyForwardNoSignalJournal
}>

export type StrategyForwardCheckpoint = StrategyForwardCheckpointPayload & Readonly<{
  checkpointHash: string
}>

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('forward checkpoint canonical numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new Error(`unsupported forward checkpoint value ${typeof value}`)
}

export function strategyForwardCheckpointHash(payload: StrategyForwardCheckpointPayload) {
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`
}

export function strategyForwardEvaluatorStateHash(evaluator: StrategyEvaluatorCheckpoint) {
  return `sha256:${createHash('sha256').update(canonicalJson(evaluator)).digest('hex')}`
}

function exactRecord(value: unknown, name: string, fields: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const record = value as UnknownRecord
  const actual = Object.keys(record).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`)
  }
  return record
}

function integer(value: unknown, name: string, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`)
  }
  return Number(value)
}

function hash(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${name} must be a SHA-256 hash`)
  }
  return value
}

function nullableHash(value: unknown, name: string) {
  return value === null ? null : hash(value, name)
}

function normalizePosition(value: unknown, name: string): StrategySignalPosition | null {
  if (value === null) return null
  const source = exactRecord(value, name, ['object', 'side', 'entrySignalId'])
  const object = exactRecord(source.object, `${name}.object`, ['model', 'id'])
  if ((object.model !== 'PRICE_EVENT' && object.model !== 'TRADE_THESIS')
    || typeof object.id !== 'string' || !object.id.trim()
    || (source.side !== 'LONG' && source.side !== 'SHORT')
    || typeof source.entrySignalId !== 'string' || !source.entrySignalId.trim()) {
    throw new Error(`${name} is invalid`)
  }
  return {
    object: { model: object.model, id: object.id },
    side: source.side,
    entrySignalId: source.entrySignalId,
  }
}

function normalizeNoSignalJournal(
  value: unknown,
  deploymentHash: string,
  lastDecisionTime: number,
): StrategyForwardNoSignalJournal {
  const source = exactRecord(value, 'forward no-signal journal', [
    'schemaVersion', 'deploymentHash', 'capacity', 'total', 'discarded',
    'lastDiscardedDecisionStateHash', 'entries',
  ])
  if (source.schemaVersion !== STRATEGY_FORWARD_NO_SIGNAL_JOURNAL_SCHEMA_VERSION) {
    throw new Error('unsupported forward no-signal journal schema')
  }
  if (source.deploymentHash !== deploymentHash) throw new Error('forward no-signal journal deploymentHash mismatch')
  if (source.capacity !== STRATEGY_FORWARD_NO_SIGNAL_CAPACITY) {
    throw new Error(`forward no-signal journal capacity must be ${STRATEGY_FORWARD_NO_SIGNAL_CAPACITY}`)
  }
  const total = integer(source.total, 'forward no-signal journal total')
  const discarded = integer(source.discarded, 'forward no-signal journal discarded')
  const lastDiscardedDecisionStateHash = nullableHash(
    source.lastDiscardedDecisionStateHash,
    'forward no-signal journal lastDiscardedDecisionStateHash',
  )
  if ((discarded === 0) !== (lastDiscardedDecisionStateHash === null)) {
    throw new Error('forward no-signal journal discarded state hash is inconsistent')
  }
  if (!Array.isArray(source.entries) || source.entries.length > STRATEGY_FORWARD_NO_SIGNAL_CAPACITY) {
    throw new Error('forward no-signal journal entries exceed their fixed capacity')
  }
  const entries = source.entries.map((value, index) => {
    const entry = exactRecord(value, `forward no-signal journal entries[${index}]`, [
      'decisionTime', 'marketDataSnapshotId', 'previousDecisionStateHash',
      'evaluatorStateHash', 'decisionStateHash', 'position',
    ])
    const normalized = {
      decisionTime: integer(entry.decisionTime, `forward no-signal journal entries[${index}].decisionTime`),
      marketDataSnapshotId: hash(
        entry.marketDataSnapshotId,
        `forward no-signal journal entries[${index}].marketDataSnapshotId`,
      ),
      previousDecisionStateHash: nullableHash(
        entry.previousDecisionStateHash,
        `forward no-signal journal entries[${index}].previousDecisionStateHash`,
      ),
      evaluatorStateHash: hash(
        entry.evaluatorStateHash,
        `forward no-signal journal entries[${index}].evaluatorStateHash`,
      ),
      decisionStateHash: hash(
        entry.decisionStateHash,
        `forward no-signal journal entries[${index}].decisionStateHash`,
      ),
      position: normalizePosition(entry.position, `forward no-signal journal entries[${index}].position`),
    }
    const expectedHash = strategyForwardDecisionStateHash({
      schemaVersion: STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
      deploymentHash,
      decisionTime: normalized.decisionTime,
      marketDataSnapshotId: normalized.marketDataSnapshotId,
      previousDecisionStateHash: normalized.previousDecisionStateHash,
      evaluatorStateHash: normalized.evaluatorStateHash,
      position: normalized.position,
      signal: null,
    })
    if (normalized.decisionStateHash !== expectedHash) {
      throw new Error(`forward no-signal decision state hash mismatch: expected ${expectedHash}`)
    }
    return normalized
  })
  if (total !== discarded + entries.length) throw new Error('forward no-signal journal counters are inconsistent')
  if (entries.some((entry, index) => (
    entry.decisionTime > lastDecisionTime
    || (index > 0 && entry.decisionTime <= entries[index - 1]!.decisionTime)
  ))) {
    throw new Error('forward no-signal journal decision times are invalid')
  }
  return Object.freeze({
    schemaVersion: STRATEGY_FORWARD_NO_SIGNAL_JOURNAL_SCHEMA_VERSION,
    deploymentHash,
    capacity: STRATEGY_FORWARD_NO_SIGNAL_CAPACITY,
    total,
    discarded,
    lastDiscardedDecisionStateHash,
    entries: Object.freeze(entries),
  })
}

export function assertStrategyForwardCheckpoint(
  value: unknown,
  deployment: StrategyForwardDeployment,
): StrategyForwardCheckpoint {
  const source = exactRecord(value, 'forward checkpoint', [
    'schemaVersion', 'deploymentHash', 'checkpointedAt', 'lastDecisionTime', 'processedSnapshotHash',
    'position', 'batchCount', 'lastBatchHash', 'evaluatorStateHash', 'decisionStateHash',
    'lastDecisionBatchHash', 'lastDecisionBatchDecisionStateHash',
    'evaluator', 'noSignalJournal', 'checkpointHash',
  ])
  if (source.schemaVersion !== STRATEGY_FORWARD_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error('unsupported forward checkpoint schema')
  }
  if (source.deploymentHash !== deployment.deploymentHash) throw new Error('forward checkpoint deploymentHash mismatch')
  const lastDecisionTime = integer(source.lastDecisionTime, 'forward checkpoint lastDecisionTime')
  const batchCount = integer(source.batchCount, 'forward checkpoint batchCount')
  const lastBatchHash = source.lastBatchHash === null ? null : hash(source.lastBatchHash, 'forward checkpoint lastBatchHash')
  if ((batchCount === 0) !== (lastBatchHash === null)) {
    throw new Error('forward checkpoint batchCount and lastBatchHash are inconsistent')
  }
  const position = normalizePosition(source.position, 'forward checkpoint position')
  const evaluator = source.evaluator as StrategyEvaluatorCheckpoint
  if (!evaluator || typeof evaluator !== 'object' || Array.isArray(evaluator)) {
    throw new Error('forward checkpoint evaluator is invalid')
  }
  const noSignalJournal = normalizeNoSignalJournal(source.noSignalJournal, deployment.deploymentHash, lastDecisionTime)
  const payload: StrategyForwardCheckpointPayload = {
    schemaVersion: STRATEGY_FORWARD_CHECKPOINT_SCHEMA_VERSION,
    deploymentHash: deployment.deploymentHash,
    checkpointedAt: integer(source.checkpointedAt, 'forward checkpoint checkpointedAt'),
    lastDecisionTime,
    processedSnapshotHash: hash(source.processedSnapshotHash, 'forward checkpoint processedSnapshotHash'),
    position: structuredClone(position),
    batchCount,
    lastBatchHash,
    evaluatorStateHash: hash(source.evaluatorStateHash, 'forward checkpoint evaluatorStateHash'),
    decisionStateHash: hash(source.decisionStateHash, 'forward checkpoint decisionStateHash'),
    lastDecisionBatchHash: nullableHash(source.lastDecisionBatchHash, 'forward checkpoint lastDecisionBatchHash'),
    lastDecisionBatchDecisionStateHash: nullableHash(
      source.lastDecisionBatchDecisionStateHash,
      'forward checkpoint lastDecisionBatchDecisionStateHash',
    ),
    evaluator: structuredClone(evaluator),
    noSignalJournal,
  }
  const expectedEvaluatorStateHash = strategyForwardEvaluatorStateHash(payload.evaluator)
  if (payload.evaluatorStateHash !== expectedEvaluatorStateHash) {
    throw new Error(`forward checkpoint evaluator state hash mismatch: expected ${expectedEvaluatorStateHash}`)
  }
  const evaluatorPosition = 'position' in evaluator ? evaluator.position : null
  const evaluatorObject = evaluatorPosition && 'event' in evaluatorPosition
    ? { model: 'PRICE_EVENT', id: evaluatorPosition.event.id, side: evaluatorPosition.side }
    : evaluatorPosition && 'thesis' in evaluatorPosition
      ? { model: 'TRADE_THESIS', id: evaluatorPosition.thesis.id, side: evaluatorPosition.side }
      : null
  const sessionObject = payload.position
    ? { model: payload.position.object.model, id: payload.position.object.id, side: payload.position.side }
    : null
  if (!isDeepStrictEqual(sessionObject, evaluatorObject)) {
    throw new Error('forward checkpoint position does not match its evaluator state')
  }
  if (payload.checkpointedAt < payload.lastDecisionTime) {
    throw new Error('forward checkpoint checkpointedAt precedes its last decision')
  }
  const lastNoSignal = payload.noSignalJournal.entries.at(-1)
  if (lastNoSignal?.decisionTime === payload.lastDecisionTime) {
    if (lastNoSignal.decisionStateHash !== payload.decisionStateHash) {
      throw new Error('forward checkpoint decision state does not match its final no-signal record')
    }
    if (payload.lastDecisionBatchHash !== null || payload.lastDecisionBatchDecisionStateHash !== null) {
      throw new Error('forward checkpoint final no-signal decision cannot reference a batch')
    }
  } else if (payload.lastDecisionBatchHash !== payload.lastBatchHash
    || payload.lastDecisionBatchDecisionStateHash !== payload.decisionStateHash) {
    throw new Error('forward checkpoint final signal decision does not match its batch/state tip')
  }
  const checkpointHash = hash(source.checkpointHash, 'forward checkpoint checkpointHash')
  const expectedHash = strategyForwardCheckpointHash(payload)
  if (checkpointHash !== expectedHash) throw new Error(`forward checkpoint hash mismatch: expected ${expectedHash}`)
  return Object.freeze({ ...payload, checkpointHash })
}

function snapshotAt(
  dataset: StrategyHistoricalDataset,
  context: HistoricalDecisionContext,
  requiredTimeframes: readonly string[],
  retentionMsByTimeframe: Readonly<Record<string, number>>,
) {
  const timeframes = Object.fromEntries(requiredTimeframes.map((timeframe) => {
    const candles = context.candles[timeframe]
    if (!candles?.length) throw new Error(`forward snapshot has no closed ${timeframe} warm-up candle`)
    const { duration } = strategyTimeframeMilliseconds(timeframe)
    const retentionMs = integer(retentionMsByTimeframe[timeframe], `forward ${timeframe} retention`, 1)
    const cutoff = Math.floor(Math.max(0, context.decisionTime - retentionMs) / duration) * duration
    const retained = [...candles].filter((candle) => candle.time >= cutoff)
    if (!retained.length) throw new Error(`forward snapshot retained no closed ${timeframe} candle`)
    return [timeframe, retained]
  }))
  return createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: dataset.source,
    capturedThrough: context.decisionTime,
    timeframes,
  })
}

export function compactStrategyForwardDataset(
  datasetValue: StrategyHistoricalDataset,
  lastDecisionTime: number,
  retentionMsByTimeframe: Readonly<Record<string, number>>,
) {
  const dataset = assertStrategyHistoricalDataset(datasetValue)
  if (!Number.isSafeInteger(lastDecisionTime) || lastDecisionTime < 0) {
    throw new Error('forward compaction lastDecisionTime must be a non-negative integer')
  }
  const timeframes = Object.fromEntries(Object.entries(dataset.timeframes).map(([timeframe, candles]) => {
    const { duration } = strategyTimeframeMilliseconds(timeframe)
    const retentionMs = integer(retentionMsByTimeframe[timeframe], `forward ${timeframe} retention`, 1)
    const cutoff = Math.floor(Math.max(0, lastDecisionTime - retentionMs) / duration) * duration
    const retained = candles.filter((candle) => candle.time >= cutoff)
    if (!retained.length) throw new Error(`forward compaction retained no ${timeframe} candles`)
    return [timeframe, retained]
  }))
  return createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: dataset.source,
    capturedThrough: dataset.capturedThrough,
    timeframes,
  })
}

function sameCandle(left: Candle, right: Candle) {
  return left.time === right.time
    && left.open === right.open
    && left.high === right.high
    && left.low === right.low
    && left.close === right.close
    && left.volume === right.volume
}

export function mergeStrategyForwardDatasets(
  currentValue: StrategyHistoricalDataset,
  deltaValue: StrategyHistoricalDataset,
) {
  const current = assertStrategyHistoricalDataset(currentValue)
  const delta = assertStrategyHistoricalDataset(deltaValue)
  if (JSON.stringify(current.source) !== JSON.stringify(delta.source)) {
    throw new Error('forward dataset delta source changed')
  }
  if (delta.capturedThrough < current.capturedThrough) {
    throw new Error('forward dataset delta moves capturedThrough backwards')
  }
  const currentTimeframes = Object.keys(current.timeframes).sort()
  const deltaTimeframes = Object.keys(delta.timeframes).sort()
  if (JSON.stringify(currentTimeframes) !== JSON.stringify(deltaTimeframes)) {
    throw new Error('forward dataset delta timeframes changed')
  }
  const timeframes: Record<string, Candle[]> = {}
  for (const timeframe of currentTimeframes) {
    const merged = new Map(current.timeframes[timeframe]!.map((candle) => [candle.time, candle]))
    for (const candle of delta.timeframes[timeframe]!) {
      const existing = merged.get(candle.time)
      if (existing && !sameCandle(existing, candle)) {
        throw new Error(`forward dataset delta changed closed ${timeframe} candle ${candle.time}`)
      }
      merged.set(candle.time, candle)
    }
    timeframes[timeframe] = [...merged.values()].sort((left, right) => left.time - right.time)
  }
  return createStrategyHistoricalDataset({
    schemaVersion: 'helix.market-dataset/v1',
    source: current.source,
    capturedThrough: delta.capturedThrough,
    timeframes,
  })
}

function nextPosition(
  current: StrategySignalPosition | null,
  decision: {
    signalId: string
    object: { model: StrategySignalPosition['object']['model']; id: string }
    action: 'ENTER' | 'EXIT'
    side: StrategyPositionSide
  },
) {
  if (decision.action === 'ENTER') {
    if (current) throw new Error(`forward ENTER overlaps open position ${current.object.id}`)
    return { object: decision.object, side: decision.side, entrySignalId: decision.signalId }
  }
  if (!current || current.object.id !== decision.object.id || current.side !== decision.side) {
    throw new Error(`forward EXIT does not match its open position ${decision.object.id}`)
  }
  return null
}

export class StrategyForwardSession {
  private readonly evaluator
  private readonly registeredReasonCodes: Set<string>
  private readonly batches: StrategySignalBatch[] = []
  private position: StrategySignalPosition | null = null
  private processedSnapshotHash: string | null = null
  private lastDecisionTime = -1
  private batchCount = 0
  private lastBatchHash: string | null = null
  private evaluatorStateHash: string | null = null
  private decisionStateHash: string | null = null
  private lastDecisionBatchHash: string | null = null
  private lastDecisionBatchDecisionStateHash: string | null = null
  private noSignalTotal = 0
  private noSignalDiscarded = 0
  private lastDiscardedDecisionStateHash: string | null = null
  private noSignalEntries: StrategyForwardNoSignalRecord[] = []

  constructor(
    readonly deployment: StrategyForwardDeployment,
    snapshot: StrategyRepositorySnapshot,
    checkpointValue?: StrategyForwardCheckpoint,
  ) {
    const manifest = requireCurrentStrategyForwardDeployment(deployment, snapshot)
    const checkpoint = checkpointValue
      ? assertStrategyForwardCheckpoint(checkpointValue, deployment)
      : null
    this.evaluator = createStrategyEvaluator(manifest, undefined, checkpoint?.evaluator)
    this.registeredReasonCodes = new Set(manifest.reasonCodes)
    if (checkpoint) {
      this.position = structuredClone(checkpoint.position)
      this.processedSnapshotHash = checkpoint.processedSnapshotHash
      this.lastDecisionTime = checkpoint.lastDecisionTime
      this.batchCount = checkpoint.batchCount
      this.lastBatchHash = checkpoint.lastBatchHash
      this.evaluatorStateHash = checkpoint.evaluatorStateHash
      this.decisionStateHash = checkpoint.decisionStateHash
      this.lastDecisionBatchHash = checkpoint.lastDecisionBatchHash
      this.lastDecisionBatchDecisionStateHash = checkpoint.lastDecisionBatchDecisionStateHash
      this.noSignalTotal = checkpoint.noSignalJournal.total
      this.noSignalDiscarded = checkpoint.noSignalJournal.discarded
      this.lastDiscardedDecisionStateHash = checkpoint.noSignalJournal.lastDiscardedDecisionStateHash
      this.noSignalEntries = structuredClone([...checkpoint.noSignalJournal.entries])
    }
  }

  advance(snapshot: StrategyRepositorySnapshot, datasetValue: StrategyHistoricalDataset) {
    const manifest = requireCurrentStrategyForwardDeployment(this.deployment, snapshot)
    const dataset = assertStrategyForwardDataset(this.deployment, datasetValue)
    const deploymentFirstDecisionTime = strategyForwardFirstDecisionTime(this.deployment)
    const { duration: baseDuration } = strategyTimeframeMilliseconds(this.evaluator.baseTimeframe)
    const availableFirstDecisionTime = dataset.timeframes[this.evaluator.baseTimeframe]![0]!.time + baseDuration
    if (this.lastDecisionTime >= 0 && this.lastDecisionTime < availableFirstDecisionTime) {
      throw new Error('forward checkpoint precedes the retained market-data window')
    }
    const firstDecisionTime = Math.max(deploymentFirstDecisionTime, availableFirstDecisionTime)
    const prepared = historicalDecisionContexts({
      dataset,
      baseTimeframe: this.evaluator.baseTimeframe,
      firstDecisionTime,
      afterDecisionTime: this.lastDecisionTime,
      requiredTimeframes: this.evaluator.requiredTimeframes,
    })
    if (this.lastDecisionTime >= deploymentFirstDecisionTime) {
      const prior = historicalDecisionContexts({
        dataset,
        baseTimeframe: this.evaluator.baseTimeframe,
        firstDecisionTime,
        afterDecisionTime: this.lastDecisionTime - 1,
        requiredTimeframes: this.evaluator.requiredTimeframes,
      }).contexts[0]
      if (!prior || prior.decisionTime !== this.lastDecisionTime) {
        throw new Error('forward dataset no longer contains the last processed decision')
      }
      const priorSnapshot = snapshotAt(
        dataset,
        prior,
        this.evaluator.requiredTimeframes,
        this.evaluator.retentionMsByTimeframe,
      )
      if (priorSnapshot.datasetHash !== this.processedSnapshotHash) {
        throw new Error('forward market history changed after a decision was processed')
      }
    }

    const appended: StrategySignalBatch[] = []
    for (const context of prepared.contexts) {
      const decisionSnapshot = snapshotAt(
        dataset,
        context,
        this.evaluator.requiredTimeframes,
        this.evaluator.retentionMsByTimeframe,
      )
      const identity = createStrategyDecisionIdentityFromSnapshot(snapshot, {
        strategyId: this.deployment.strategy.id,
        marketDataSnapshotId: decisionSnapshot.datasetHash,
      })
      const decisions = this.evaluator.evaluate(context)
      if (!Array.isArray(decisions)) throw new Error('forward evaluator must return an array')
      if (decisions.length > 1) throw new Error('forward evaluator returned multiple signals for one decision time')
      const decision = decisions[0]
      const positionBefore = this.position
      let positionAfter = positionBefore
      if (decision) {
        if (decision.object.model !== this.deployment.strategy.objectModel) {
          throw new Error('forward decision object model does not match the deployment')
        }
        for (const reasonCode of decision.reasonCodes) {
          if (!this.registeredReasonCodes.has(reasonCode)) {
            throw new Error(`forward decision uses unregistered reason code ${reasonCode}`)
          }
        }
        positionAfter = nextPosition(positionBefore, decision)
      }
      const evaluatorCheckpoint = this.evaluator.checkpoint()
      const evaluatorStateHash = strategyForwardEvaluatorStateHash(evaluatorCheckpoint)
      const decisionStatePayload: StrategyForwardDecisionStatePayload = {
        schemaVersion: STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
        deploymentHash: this.deployment.deploymentHash,
        decisionTime: context.decisionTime,
        marketDataSnapshotId: decisionSnapshot.datasetHash,
        previousDecisionStateHash: this.decisionStateHash,
        evaluatorStateHash,
        position: positionAfter,
        signal: decision ? {
          signalId: decision.signalId,
          decisionId: decision.decisionId,
          object: decision.object,
          action: decision.action,
          side: decision.side,
          reasonCodes: decision.reasonCodes,
        } : null,
      }
      const decisionStateHash = strategyForwardDecisionStateHash(decisionStatePayload)
      if (decision) {
        const batchSequence = this.batchCount
        const batch = createStrategySignalBatch({
          schemaVersion: 'helix.signal-batch/v1',
          deploymentHash: this.deployment.deploymentHash,
          batchSequence,
          previousBatchHash: this.lastBatchHash,
          previousDecisionStateHash: this.decisionStateHash,
          evaluatorStateHash,
          decisionStateHash,
          identity,
          strategyLifecycle: manifest.lifecycle,
          objectModel: manifest.objectModel,
          symbol: this.deployment.symbol,
          baseTimeframe: this.evaluator.baseTimeframe,
          positionBefore,
          positionAfter,
          signal: {
            ...decision,
            sequence: batchSequence,
            sourceCandleOpenTime: context.sourceCandle.time,
            decisionTime: context.decisionTime,
          },
        })
        this.batches.push(batch)
        appended.push(batch)
        this.batchCount += 1
        this.lastBatchHash = batch.batchHash
        this.lastDecisionBatchHash = batch.batchHash
        this.lastDecisionBatchDecisionStateHash = decisionStateHash
        this.position = positionAfter
      } else {
        this.lastDecisionBatchHash = null
        this.lastDecisionBatchDecisionStateHash = null
        this.noSignalTotal += 1
        this.noSignalEntries.push({
          decisionTime: context.decisionTime,
          marketDataSnapshotId: decisionSnapshot.datasetHash,
          previousDecisionStateHash: this.decisionStateHash,
          evaluatorStateHash,
          decisionStateHash,
          position: positionAfter,
        })
        if (this.noSignalEntries.length > STRATEGY_FORWARD_NO_SIGNAL_CAPACITY) {
          const discarded = this.noSignalEntries.length - STRATEGY_FORWARD_NO_SIGNAL_CAPACITY
          const removed = this.noSignalEntries.splice(0, discarded)
          this.noSignalDiscarded += discarded
          this.lastDiscardedDecisionStateHash = removed.at(-1)!.decisionStateHash
        }
      }
      this.evaluatorStateHash = evaluatorStateHash
      this.decisionStateHash = decisionStateHash
      this.lastDecisionTime = context.decisionTime
      this.processedSnapshotHash = decisionSnapshot.datasetHash
    }
    return Object.freeze([...appended])
  }

  state() {
    return Object.freeze({
      deploymentHash: this.deployment.deploymentHash,
      lastDecisionTime: this.lastDecisionTime,
      processedSnapshotHash: this.processedSnapshotHash,
      position: this.position,
      batches: Object.freeze([...this.batches]),
      batchCount: this.batchCount,
      lastBatchHash: this.lastBatchHash,
      evaluatorStateHash: this.evaluatorStateHash,
      decisionStateHash: this.decisionStateHash,
      lastDecisionBatchHash: this.lastDecisionBatchHash,
      lastDecisionBatchDecisionStateHash: this.lastDecisionBatchDecisionStateHash,
      noSignalJournal: this.noSignalJournal(),
      marketRetentionMsByTimeframe: Object.freeze({ ...this.evaluator.retentionMsByTimeframe }),
      statistics: this.evaluator.statistics(),
    })
  }

  noSignalJournal(): StrategyForwardNoSignalJournal {
    return Object.freeze({
      schemaVersion: STRATEGY_FORWARD_NO_SIGNAL_JOURNAL_SCHEMA_VERSION,
      deploymentHash: this.deployment.deploymentHash,
      capacity: STRATEGY_FORWARD_NO_SIGNAL_CAPACITY,
      total: this.noSignalTotal,
      discarded: this.noSignalDiscarded,
      lastDiscardedDecisionStateHash: this.lastDiscardedDecisionStateHash,
      entries: Object.freeze(structuredClone(this.noSignalEntries)),
    })
  }

  checkpoint(checkpointedAt = Date.now()): StrategyForwardCheckpoint {
    if (this.lastDecisionTime < 0 || !this.processedSnapshotHash
      || !this.evaluatorStateHash || !this.decisionStateHash) {
      throw new Error('forward session cannot checkpoint before its first decision')
    }
    const payload: StrategyForwardCheckpointPayload = {
      schemaVersion: STRATEGY_FORWARD_CHECKPOINT_SCHEMA_VERSION,
      deploymentHash: this.deployment.deploymentHash,
      checkpointedAt: integer(checkpointedAt, 'forward checkpoint checkpointedAt'),
      lastDecisionTime: this.lastDecisionTime,
      processedSnapshotHash: this.processedSnapshotHash,
      position: structuredClone(this.position),
      batchCount: this.batchCount,
      lastBatchHash: this.lastBatchHash,
      evaluatorStateHash: this.evaluatorStateHash,
      decisionStateHash: this.decisionStateHash,
      lastDecisionBatchHash: this.lastDecisionBatchHash,
      lastDecisionBatchDecisionStateHash: this.lastDecisionBatchDecisionStateHash,
      evaluator: this.evaluator.checkpoint(),
      noSignalJournal: this.noSignalJournal(),
    }
    return assertStrategyForwardCheckpoint(
      { ...payload, checkpointHash: strategyForwardCheckpointHash(payload) },
      this.deployment,
    )
  }
}
