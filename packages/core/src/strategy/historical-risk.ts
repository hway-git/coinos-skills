import { createHash } from 'node:crypto'
import {
  STRATEGY_HISTORICAL_RISK_TRACE_SCHEMA_VERSION,
  type StrategyHistoricalRiskTrace,
  type StrategyHistoricalRiskTraceEntry,
  type StrategyHistoricalRiskTracePayload,
  type StrategyHistoricalScalpRiskTraceEntry,
  type StrategyHistoricalSwingRiskTraceEntry,
  type StrategySignalArtifact,
} from '@helix/contracts/strategy'
import { assertStrategySignalArtifact } from './signal-artifact'

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const FAMILIES = new Set(['scalp', 'swing'])
const POSITION_SIDES = new Set(['LONG', 'SHORT'])
const SCALP_EVENT_TYPES = new Set(['LIQUIDITY_SWEEP', 'BREAKOUT_FAILURE', 'MOMENTUM_BURST'])
const SCALP_GRADES = new Set(['A_PLUS', 'A', 'B'])
const SCALP_REGIME_TYPES = new Set([
  'TRENDING', 'RANGING', 'COMPRESSED', 'EXPANDING', 'EXHAUSTED', 'CHAOTIC',
])
const SWING_STAGES = new Set(['EARLY', 'STANDARD', 'CONFIRMED'])
const SWING_CONTEXT_STATES = new Set([
  'BULLISH_TREND', 'BEARISH_TREND', 'RANGE', 'TRANSITION', 'UNCLEAR',
])
const SWING_CONTEXT_BIASES = new Set(['BULLISH', 'BEARISH', 'NEUTRAL'])

type UnknownRecord = Record<string, unknown>

function exactRecord(value: unknown, name: string, fields: readonly string[]): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  const result = value as UnknownRecord
  const actual = Object.keys(result).sort()
  const expected = [...fields].sort()
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`)
  }
  return result
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`)
  }
  return value
}

function member(value: unknown, name: string, allowed: ReadonlySet<string>) {
  const normalized = text(value, name)
  if (!allowed.has(normalized)) throw new Error(`${name} is invalid`)
  return normalized
}

function positiveNumber(value: unknown, name: string) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be finite and positive`)
  }
  return value
}

function commonEntryFields(source: UnknownRecord, name: string) {
  const entryPriceSource = exactRecord(source.entryPrice, `${name}.entryPrice`, ['source', 'price'])
  if (entryPriceSource.source !== 'DECISION_CANDLE_CLOSE') {
    throw new Error(`${name}.entryPrice.source must be DECISION_CANDLE_CLOSE`)
  }
  const objectSource = exactRecord(source.object, `${name}.object`, ['model', 'id'])
  const side = member(source.side, `${name}.side`, POSITION_SIDES) as 'LONG' | 'SHORT'
  const entryPrice = positiveNumber(entryPriceSource.price, `${name}.entryPrice.price`)
  const initialStop = positiveNumber(source.initialStop, `${name}.initialStop`)
  const initialTarget = positiveNumber(source.initialTarget, `${name}.initialTarget`)
  const riskDistance = positiveNumber(source.riskDistance, `${name}.riskDistance`)
  const riskR = positiveNumber(source.riskR, `${name}.riskR`)

  if (riskDistance !== Math.abs(entryPrice - initialStop)) {
    throw new Error(`${name}.riskDistance must equal the absolute entry-to-stop distance`)
  }
  if (side === 'LONG' && !(initialStop < entryPrice && entryPrice < initialTarget)) {
    throw new Error(`${name} LONG risk must have initialStop < entryPrice < initialTarget`)
  }
  if (side === 'SHORT' && !(initialTarget < entryPrice && entryPrice < initialStop)) {
    throw new Error(`${name} SHORT risk must have initialTarget < entryPrice < initialStop`)
  }
  return {
    entrySignalId: text(source.entrySignalId, `${name}.entrySignalId`),
    side,
    objectId: text(objectSource.id, `${name}.object.id`),
    objectModel: text(objectSource.model, `${name}.object.model`),
    entryPrice: { source: 'DECISION_CANDLE_CLOSE' as const, price: entryPrice },
    initialStop,
    initialTarget,
    riskDistance,
    riskR,
  }
}

function normalizeScalpEntry(source: UnknownRecord, name: string): StrategyHistoricalScalpRiskTraceEntry {
  const common = commonEntryFields(source, name)
  if (common.objectModel !== 'PRICE_EVENT') {
    throw new Error(`${name}.object.model must be PRICE_EVENT for scalp`)
  }
  const scalpSource = exactRecord(source.scalp, `${name}.scalp`, ['eventType', 'grade', 'regime'])
  const regimeSource = exactRecord(scalpSource.regime, `${name}.scalp.regime`, ['id', 'type'])
  return {
    entrySignalId: common.entrySignalId,
    family: 'scalp',
    object: { model: 'PRICE_EVENT', id: common.objectId },
    side: common.side,
    entryPrice: common.entryPrice,
    initialStop: common.initialStop,
    initialTarget: common.initialTarget,
    riskDistance: common.riskDistance,
    riskR: common.riskR,
    scalp: {
      eventType: member(scalpSource.eventType, `${name}.scalp.eventType`, SCALP_EVENT_TYPES) as StrategyHistoricalScalpRiskTraceEntry['scalp']['eventType'],
      grade: member(scalpSource.grade, `${name}.scalp.grade`, SCALP_GRADES) as StrategyHistoricalScalpRiskTraceEntry['scalp']['grade'],
      regime: {
        id: text(regimeSource.id, `${name}.scalp.regime.id`),
        type: member(regimeSource.type, `${name}.scalp.regime.type`, SCALP_REGIME_TYPES) as StrategyHistoricalScalpRiskTraceEntry['scalp']['regime']['type'],
      },
    },
  }
}

function normalizeSwingEntry(source: UnknownRecord, name: string): StrategyHistoricalSwingRiskTraceEntry {
  const common = commonEntryFields(source, name)
  if (common.objectModel !== 'TRADE_THESIS') {
    throw new Error(`${name}.object.model must be TRADE_THESIS for swing`)
  }
  const swingSource = exactRecord(source.swing, `${name}.swing`, ['stage', 'context'])
  const contextSource = exactRecord(swingSource.context, `${name}.swing.context`, ['id', 'state', 'bias'])
  return {
    entrySignalId: common.entrySignalId,
    family: 'swing',
    object: { model: 'TRADE_THESIS', id: common.objectId },
    side: common.side,
    entryPrice: common.entryPrice,
    initialStop: common.initialStop,
    initialTarget: common.initialTarget,
    riskDistance: common.riskDistance,
    riskR: common.riskR,
    swing: {
      stage: member(swingSource.stage, `${name}.swing.stage`, SWING_STAGES) as StrategyHistoricalSwingRiskTraceEntry['swing']['stage'],
      context: {
        id: text(contextSource.id, `${name}.swing.context.id`),
        state: member(contextSource.state, `${name}.swing.context.state`, SWING_CONTEXT_STATES) as StrategyHistoricalSwingRiskTraceEntry['swing']['context']['state'],
        bias: member(contextSource.bias, `${name}.swing.context.bias`, SWING_CONTEXT_BIASES) as StrategyHistoricalSwingRiskTraceEntry['swing']['context']['bias'],
      },
    },
  }
}

function normalizeEntry(value: unknown, index: number): StrategyHistoricalRiskTraceEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`entries[${index}] must be an object`)
  }
  const name = `entries[${index}]`
  const family = member((value as UnknownRecord).family, `${name}.family`, FAMILIES)
  if (family === 'scalp') {
    return normalizeScalpEntry(exactRecord(value, name, [
      'entrySignalId', 'family', 'object', 'side', 'entryPrice', 'initialStop', 'initialTarget',
      'riskDistance', 'riskR', 'scalp',
    ]), name)
  }
  return normalizeSwingEntry(exactRecord(value, name, [
    'entrySignalId', 'family', 'object', 'side', 'entryPrice', 'initialStop', 'initialTarget',
    'riskDistance', 'riskR', 'swing',
  ]), name)
}

function normalizePayload(value: unknown): StrategyHistoricalRiskTracePayload {
  const source = exactRecord(value, 'historical risk trace payload', [
    'schemaVersion', 'signalArtifactHash', 'entries',
  ])
  if (source.schemaVersion !== STRATEGY_HISTORICAL_RISK_TRACE_SCHEMA_VERSION) {
    throw new Error(`unsupported historical risk trace schema ${String(source.schemaVersion)}`)
  }
  const signalArtifactHash = text(source.signalArtifactHash, 'signalArtifactHash')
  if (!HASH_PATTERN.test(signalArtifactHash)) throw new Error('signalArtifactHash must be a SHA-256 hash')
  if (!Array.isArray(source.entries)) throw new Error('entries must be an array')
  const entries = source.entries.map(normalizeEntry)
  const entrySignalIds = new Set<string>()
  for (const entry of entries) {
    if (entrySignalIds.has(entry.entrySignalId)) {
      throw new Error(`duplicate historical risk entrySignalId ${entry.entrySignalId}`)
    }
    entrySignalIds.add(entry.entrySignalId)
  }
  return {
    schemaVersion: STRATEGY_HISTORICAL_RISK_TRACE_SCHEMA_VERSION,
    signalArtifactHash,
    entries,
  }
}

function assertArtifactLinkage(
  payload: StrategyHistoricalRiskTracePayload,
  signalArtifactValue: unknown,
): StrategySignalArtifact {
  const artifact = assertStrategySignalArtifact(signalArtifactValue)
  if (payload.signalArtifactHash !== artifact.artifactHash) {
    throw new Error('historical risk trace signalArtifactHash does not match the signal Artifact')
  }
  const enterSignals = artifact.signals.filter((signal) => signal.action === 'ENTER')
  if (payload.entries.length !== enterSignals.length) {
    throw new Error('historical risk trace must contain exactly one entry for every signal Artifact ENTER')
  }
  const expectedFamily = artifact.objectModel === 'PRICE_EVENT' ? 'scalp' : 'swing'
  for (const [index, entry] of payload.entries.entries()) {
    const signal = enterSignals[index]!
    if (entry.entrySignalId !== signal.signalId) {
      if (!enterSignals.some((candidate) => candidate.signalId === entry.entrySignalId)) {
        throw new Error(`historical risk entry ${entry.entrySignalId} does not link to an Artifact ENTER`)
      }
      throw new Error('historical risk entries must follow signal Artifact ENTER order')
    }
    if (entry.family !== expectedFamily || entry.object.model !== artifact.objectModel) {
      throw new Error(`historical risk entry ${entry.entrySignalId} family/model does not match the signal Artifact`)
    }
    if (entry.object.id !== signal.object.id) {
      throw new Error(`historical risk entry ${entry.entrySignalId} object does not match its Artifact ENTER`)
    }
    if (entry.side !== signal.side) {
      throw new Error(`historical risk entry ${entry.entrySignalId} side does not match its Artifact ENTER`)
    }
  }
  return artifact
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical historical risk traces require finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new Error(`unsupported canonical JSON value ${typeof value}`)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as UnknownRecord)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

export function strategyHistoricalRiskTraceHash(payload: StrategyHistoricalRiskTracePayload) {
  const normalized = normalizePayload(payload)
  return `sha256:${createHash('sha256').update(canonicalJson(normalized)).digest('hex')}`
}

export function createStrategyHistoricalRiskTrace(
  payload: StrategyHistoricalRiskTracePayload,
  signalArtifact: StrategySignalArtifact,
): StrategyHistoricalRiskTrace {
  const normalized = normalizePayload(payload)
  assertArtifactLinkage(normalized, signalArtifact)
  return deepFreeze({
    ...normalized,
    traceHash: strategyHistoricalRiskTraceHash(normalized),
  })
}

export function assertStrategyHistoricalRiskTrace(
  value: unknown,
  signalArtifact: StrategySignalArtifact,
): StrategyHistoricalRiskTrace {
  const source = exactRecord(value, 'historical risk trace', [
    'schemaVersion', 'signalArtifactHash', 'entries', 'traceHash',
  ])
  const traceHash = text(source.traceHash, 'traceHash')
  if (!HASH_PATTERN.test(traceHash)) throw new Error('traceHash must be a SHA-256 hash')
  const payload = normalizePayload({
    schemaVersion: source.schemaVersion,
    signalArtifactHash: source.signalArtifactHash,
    entries: source.entries,
  })
  assertArtifactLinkage(payload, signalArtifact)
  const expectedHash = strategyHistoricalRiskTraceHash(payload)
  if (traceHash !== expectedHash) throw new Error(`historical risk trace hash mismatch: expected ${expectedHash}`)
  return deepFreeze({ ...payload, traceHash })
}
