import { createHash } from 'node:crypto'
import {
  STRATEGY_SIGNAL_BATCH_SCHEMA_VERSION,
  type StrategyDecisionIdentity,
  type StrategyLifecycle,
  type StrategyObjectModel,
  type StrategySignalBatch,
  type StrategySignalBatchPayload,
  type StrategySignalPosition,
  type StrategySignalRecord,
} from '@helix/contracts/strategy'
import {
  assertStrategyForwardDeployment,
  strategyForwardDecisionStateHash,
  strategyForwardFirstDecisionTime,
  STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
  type StrategyForwardDeployment,
} from './forward-runtime'
import { strategyTimeframeMilliseconds } from './signal-artifact'

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/
type UnknownRecord = Record<string, unknown>

function exactRecord(value: unknown, name: string, fields: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const record = value as UnknownRecord
  const actual = Object.keys(record).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`)
  }
  return record
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`)
  }
  return value
}

function integer(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return Number(value)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('signal batch canonical numbers must be safe integers')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new Error(`unsupported signal batch value ${typeof value}`)
}

function normalizeIdentity(value: unknown): StrategyDecisionIdentity {
  const source = exactRecord(value, 'signal batch identity', [
    'strategyId', 'strategyVersion', 'strategyRepoCommit', 'strategyConfigHash', 'engineCommit', 'marketDataSnapshotId',
  ])
  const identity = {
    strategyId: text(source.strategyId, 'identity.strategyId'),
    strategyVersion: text(source.strategyVersion, 'identity.strategyVersion'),
    strategyRepoCommit: text(source.strategyRepoCommit, 'identity.strategyRepoCommit'),
    strategyConfigHash: text(source.strategyConfigHash, 'identity.strategyConfigHash'),
    engineCommit: text(source.engineCommit, 'identity.engineCommit'),
    marketDataSnapshotId: text(source.marketDataSnapshotId, 'identity.marketDataSnapshotId'),
  }
  if (!COMMIT_PATTERN.test(identity.strategyRepoCommit) || !COMMIT_PATTERN.test(identity.engineCommit)) {
    throw new Error('signal batch identity requires full strategy and Engine commits')
  }
  if (!HASH_PATTERN.test(identity.strategyConfigHash) || !HASH_PATTERN.test(identity.marketDataSnapshotId)) {
    throw new Error('signal batch identity hashes must be SHA-256 hashes')
  }
  return identity
}

function normalizeObject(value: unknown, name: string, objectModel: StrategyObjectModel) {
  const source = exactRecord(value, name, ['model', 'id'])
  if (source.model !== objectModel) throw new Error(`${name}.model must match objectModel`)
  return { model: objectModel, id: text(source.id, `${name}.id`) }
}

function normalizePosition(value: unknown, name: string, objectModel: StrategyObjectModel): StrategySignalPosition | null {
  if (value === null) return null
  const source = exactRecord(value, name, ['object', 'side', 'entrySignalId'])
  const side = text(source.side, `${name}.side`)
  if (side !== 'LONG' && side !== 'SHORT') throw new Error(`${name}.side is invalid`)
  return {
    object: normalizeObject(source.object, `${name}.object`, objectModel),
    side,
    entrySignalId: text(source.entrySignalId, `${name}.entrySignalId`),
  }
}

function normalizeSignal(
  value: unknown,
  batchSequence: number,
  objectModel: StrategyObjectModel,
  baseTimeframe: string,
): StrategySignalRecord {
  const source = exactRecord(value, 'signal batch signal', [
    'sequence', 'signalId', 'decisionId', 'object', 'action', 'side',
    'sourceCandleOpenTime', 'decisionTime', 'reasonCodes',
  ])
  const sequence = integer(source.sequence, 'signal.sequence')
  if (sequence !== batchSequence) throw new Error('signal.sequence must equal batchSequence')
  const action = text(source.action, 'signal.action')
  const side = text(source.side, 'signal.side')
  if (action !== 'ENTER' && action !== 'EXIT') throw new Error('signal.action is invalid')
  if (side !== 'LONG' && side !== 'SHORT') throw new Error('signal.side is invalid')
  const sourceCandleOpenTime = integer(source.sourceCandleOpenTime, 'signal.sourceCandleOpenTime')
  const decisionTime = integer(source.decisionTime, 'signal.decisionTime')
  const { duration } = strategyTimeframeMilliseconds(baseTimeframe)
  if (sourceCandleOpenTime % duration !== 0 || decisionTime !== sourceCandleOpenTime + duration) {
    throw new Error('signal decision must equal its aligned source candle close')
  }
  if (!Array.isArray(source.reasonCodes) || source.reasonCodes.length === 0) {
    throw new Error('signal.reasonCodes must be a non-empty array')
  }
  const reasonCodes = source.reasonCodes.map((code, index) => text(code, `signal.reasonCodes[${index}]`))
  if (new Set(reasonCodes).size !== reasonCodes.length || reasonCodes.some((code) => !REASON_CODE_PATTERN.test(code))) {
    throw new Error('signal.reasonCodes must be unique registered-style codes')
  }
  return {
    sequence,
    signalId: text(source.signalId, 'signal.signalId'),
    decisionId: text(source.decisionId, 'signal.decisionId'),
    object: normalizeObject(source.object, 'signal.object', objectModel),
    action,
    side,
    sourceCandleOpenTime,
    decisionTime,
    reasonCodes,
  }
}

function samePosition(left: StrategySignalPosition | null, right: StrategySignalPosition | null) {
  return left === null || right === null
    ? left === right
    : left.object.model === right.object.model
      && left.object.id === right.object.id
      && left.side === right.side
      && left.entrySignalId === right.entrySignalId
}

function normalizePayload(value: unknown): StrategySignalBatchPayload {
  const source = exactRecord(value, 'signal batch', [
    'schemaVersion', 'deploymentHash', 'batchSequence', 'previousBatchHash',
    'previousDecisionStateHash', 'evaluatorStateHash', 'decisionStateHash', 'identity',
    'strategyLifecycle', 'objectModel', 'symbol', 'baseTimeframe', 'positionBefore', 'positionAfter', 'signal',
  ])
  if (source.schemaVersion !== STRATEGY_SIGNAL_BATCH_SCHEMA_VERSION) {
    throw new Error(`unsupported signal batch schema ${String(source.schemaVersion)}`)
  }
  const deploymentHash = text(source.deploymentHash, 'deploymentHash')
  if (!HASH_PATTERN.test(deploymentHash)) throw new Error('deploymentHash must be a SHA-256 hash')
  const batchSequence = integer(source.batchSequence, 'batchSequence')
  const previousBatchHash = source.previousBatchHash === null
    ? null
    : text(source.previousBatchHash, 'previousBatchHash')
  if (previousBatchHash !== null && !HASH_PATTERN.test(previousBatchHash)) {
    throw new Error('previousBatchHash must be a SHA-256 hash')
  }
  const previousDecisionStateHash = source.previousDecisionStateHash === null
    ? null
    : text(source.previousDecisionStateHash, 'previousDecisionStateHash')
  if (previousDecisionStateHash !== null && !HASH_PATTERN.test(previousDecisionStateHash)) {
    throw new Error('previousDecisionStateHash must be a SHA-256 hash')
  }
  const evaluatorStateHash = text(source.evaluatorStateHash, 'evaluatorStateHash')
  const decisionStateHash = text(source.decisionStateHash, 'decisionStateHash')
  if (!HASH_PATTERN.test(evaluatorStateHash) || !HASH_PATTERN.test(decisionStateHash)) {
    throw new Error('signal batch decision state hashes must be SHA-256 hashes')
  }
  const strategyLifecycle = text(source.strategyLifecycle, 'strategyLifecycle') as StrategyLifecycle
  const objectModel = text(source.objectModel, 'objectModel') as StrategyObjectModel
  if (objectModel !== 'PRICE_EVENT' && objectModel !== 'TRADE_THESIS') throw new Error('objectModel is invalid')
  const baseTimeframe = strategyTimeframeMilliseconds(source.baseTimeframe).timeframe
  const signal = normalizeSignal(source.signal, batchSequence, objectModel, baseTimeframe)
  const positionBefore = normalizePosition(source.positionBefore, 'positionBefore', objectModel)
  const positionAfter = normalizePosition(source.positionAfter, 'positionAfter', objectModel)
  const signalPosition = { object: signal.object, side: signal.side, entrySignalId: signal.signalId }
  if (signal.action === 'ENTER') {
    if (positionBefore !== null || !samePosition(positionAfter, signalPosition)) {
      throw new Error('ENTER batch must transition a flat position to its signal position')
    }
  } else if (positionAfter !== null || positionBefore === null
    || positionBefore.object.id !== signal.object.id || positionBefore.side !== signal.side) {
    throw new Error('EXIT batch must close its matching prior position')
  }
  return {
    schemaVersion: STRATEGY_SIGNAL_BATCH_SCHEMA_VERSION,
    deploymentHash,
    batchSequence,
    previousBatchHash,
    previousDecisionStateHash,
    evaluatorStateHash,
    decisionStateHash,
    identity: normalizeIdentity(source.identity),
    strategyLifecycle,
    objectModel,
    symbol: text(source.symbol, 'symbol'),
    baseTimeframe,
    positionBefore,
    positionAfter,
    signal,
  }
}

export function strategySignalBatchHash(payload: StrategySignalBatchPayload) {
  const normalized = normalizePayload(payload)
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`
}

export function createStrategySignalBatch(payload: StrategySignalBatchPayload): StrategySignalBatch {
  const normalized = normalizePayload(payload)
  return Object.freeze({ ...normalized, batchHash: strategySignalBatchHash(normalized) })
}

export function assertStrategySignalBatch(value: unknown): StrategySignalBatch {
  const source = exactRecord(value, 'signal batch envelope', [
    'schemaVersion', 'deploymentHash', 'batchSequence', 'previousBatchHash',
    'previousDecisionStateHash', 'evaluatorStateHash', 'decisionStateHash', 'identity',
    'strategyLifecycle', 'objectModel', 'symbol', 'baseTimeframe', 'positionBefore', 'positionAfter', 'signal', 'batchHash',
  ])
  const batchHash = text(source.batchHash, 'batchHash')
  if (!HASH_PATTERN.test(batchHash)) throw new Error('batchHash must be a SHA-256 hash')
  const payload = normalizePayload(Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'batchHash')))
  const expectedHash = strategySignalBatchHash(payload)
  if (batchHash !== expectedHash) throw new Error(`signal batch hash mismatch: expected ${expectedHash}`)
  return Object.freeze({ ...payload, batchHash })
}

export function assertStrategySignalBatchChain(
  deploymentValue: StrategyForwardDeployment,
  values: readonly unknown[],
) {
  const deployment = assertStrategyForwardDeployment(deploymentValue)
  const batches = values.map(assertStrategySignalBatch)
  let previousHash: string | null = null
  let position: StrategySignalPosition | null = null
  let priorDecisionTime = -1
  let priorDecisionStateHash: string | null = null
  const { duration: baseDuration } = strategyTimeframeMilliseconds(deployment.strategy.baseTimeframe)
  const signalIds = new Set<string>()
  const decisionIds = new Set<string>()
  const decisionStateHashes = new Set<string>()
  for (const [index, batch] of batches.entries()) {
    if (batch.deploymentHash !== deployment.deploymentHash) throw new Error('signal batch deploymentHash does not match')
    if (batch.batchSequence !== index || batch.previousBatchHash !== previousHash) {
      throw new Error(`signal batch chain is broken at sequence ${index}`)
    }
    const pin = deployment.strategy
    if (batch.identity.strategyId !== pin.id
      || batch.identity.strategyVersion !== pin.version
      || batch.identity.strategyRepoCommit !== pin.repoCommit
      || batch.identity.strategyConfigHash !== pin.configHash
      || batch.identity.engineCommit !== pin.engineCommit
      || batch.strategyLifecycle !== pin.lifecycle
      || batch.objectModel !== pin.objectModel
      || batch.symbol !== deployment.symbol
      || batch.baseTimeframe !== pin.baseTimeframe) {
      throw new Error(`signal batch identity does not match deployment at sequence ${index}`)
    }
    if (!samePosition(batch.positionBefore, position)) throw new Error(`signal batch position chain is broken at sequence ${index}`)
    if (batch.signal.decisionTime < strategyForwardFirstDecisionTime(deployment)
      || batch.signal.decisionTime <= priorDecisionTime) {
      throw new Error(`signal batch decision time is invalid at sequence ${index}`)
    }
    const expectedDecisionStateHash = strategyForwardDecisionStateHash({
      schemaVersion: STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
      deploymentHash: batch.deploymentHash,
      decisionTime: batch.signal.decisionTime,
      marketDataSnapshotId: batch.identity.marketDataSnapshotId,
      previousDecisionStateHash: batch.previousDecisionStateHash,
      evaluatorStateHash: batch.evaluatorStateHash,
      position: batch.positionAfter,
      signal: {
        signalId: batch.signal.signalId,
        decisionId: batch.signal.decisionId,
        object: batch.signal.object,
        action: batch.signal.action,
        side: batch.signal.side,
        reasonCodes: batch.signal.reasonCodes,
      },
    })
    if (batch.decisionStateHash !== expectedDecisionStateHash) {
      throw new Error(`signal batch decision state hash mismatch at sequence ${index}`)
    }
    if (priorDecisionTime >= 0 && batch.signal.decisionTime === priorDecisionTime + baseDuration
      && batch.previousDecisionStateHash !== priorDecisionStateHash) {
      throw new Error(`signal batch decision state chain is broken at sequence ${index}`)
    }
    if (batch.previousDecisionStateHash === batch.decisionStateHash) {
      throw new Error(`signal batch decision state self-cycle at sequence ${index}`)
    }
    if (signalIds.has(batch.signal.signalId) || decisionIds.has(batch.signal.decisionId)) {
      throw new Error(`signal batch chain contains a duplicate decision at sequence ${index}`)
    }
    if (decisionStateHashes.has(batch.decisionStateHash)) {
      throw new Error(`signal batch chain contains a duplicate decision state at sequence ${index}`)
    }
    signalIds.add(batch.signal.signalId)
    decisionIds.add(batch.signal.decisionId)
    decisionStateHashes.add(batch.decisionStateHash)
    position = batch.positionAfter
    previousHash = batch.batchHash
    priorDecisionTime = batch.signal.decisionTime
    priorDecisionStateHash = batch.decisionStateHash
  }
  return Object.freeze([...batches])
}
