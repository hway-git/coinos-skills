import { createHash, randomUUID } from 'node:crypto'
import type {
  StrategyHistoricalDataset,
  StrategyLifecycle,
  StrategyObjectModel,
  StrategyPositionSide,
  StrategyRepositorySnapshot,
  StrategySignalPosition,
} from '@helix/contracts/strategy'
import { assertStrategyHistoricalDataset } from './historical-dataset'
import {
  createStrategyDecisionIdentityFromSnapshot,
} from './repository'
import { strategyTimeframeMilliseconds } from './signal-artifact'

export const STRATEGY_FORWARD_DEPLOYMENT_SCHEMA_VERSION = 'helix.forward-deployment/v1' as const
export const STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION = 'helix.forward-decision-state/v1' as const

const DRY_RUN_LIFECYCLES = new Set<StrategyLifecycle>(['shadow', 'canary', 'production'])
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/

export type StrategyForwardDeploymentPayload = Readonly<{
  schemaVersion: typeof STRATEGY_FORWARD_DEPLOYMENT_SCHEMA_VERSION
  deploymentId: string
  mode: 'dry_run'
  activatedAt: number
  provider: 'okx'
  instrumentId: string
  symbol: string
  walkForwardReportHash?: string
  strategy: Readonly<{
    id: string
    version: string
    repoCommit: string
    configHash: string
    engineCommit: string
    lifecycle: StrategyLifecycle
    objectModel: StrategyObjectModel
    baseTimeframe: string
  }>
}>

export type StrategyForwardDeployment = StrategyForwardDeploymentPayload & Readonly<{
  deploymentHash: string
}>

export type StrategyForwardDecisionStatePayload = Readonly<{
  schemaVersion: typeof STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION
  deploymentHash: string
  decisionTime: number
  marketDataSnapshotId: string
  previousDecisionStateHash: string | null
  evaluatorStateHash: string
  position: StrategySignalPosition | null
  signal: Readonly<{
    signalId: string
    decisionId: string
    object: Readonly<{ model: StrategySignalPosition['object']['model']; id: string }>
    action: 'ENTER' | 'EXIT'
    side: StrategyPositionSide
    reasonCodes: readonly string[]
  }> | null
}>

type UnknownRecord = Record<string, unknown>

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`)
  }
  return value
}

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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('forward deployment canonical numbers must be safe integers')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as UnknownRecord
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  throw new Error(`unsupported forward deployment value ${typeof value}`)
}

export function strategyForwardDeploymentHash(payload: StrategyForwardDeploymentPayload) {
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`
}

export function strategyForwardDecisionStateHash(payload: StrategyForwardDecisionStatePayload) {
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`
}

function normalizeDeploymentPayload(value: unknown): StrategyForwardDeploymentPayload {
  const source = exactRecord(value, 'forward deployment', [
    'schemaVersion', 'deploymentId', 'mode', 'activatedAt', 'provider', 'instrumentId', 'symbol', 'strategy',
    ...(value && typeof value === 'object' && !Array.isArray(value)
      && Object.hasOwn(value, 'walkForwardReportHash') ? ['walkForwardReportHash'] : []),
  ])
  if (source.schemaVersion !== STRATEGY_FORWARD_DEPLOYMENT_SCHEMA_VERSION) {
    throw new Error(`unsupported forward deployment schema ${String(source.schemaVersion)}`)
  }
  if (source.mode !== 'dry_run') throw new Error('forward deployment mode must be dry_run')
  if (source.provider !== 'okx') throw new Error('forward deployment provider must be okx')
  if (!Number.isSafeInteger(source.activatedAt) || Number(source.activatedAt) < 0) {
    throw new Error('forward deployment activatedAt must be a non-negative integer timestamp')
  }
  const strategy = exactRecord(source.strategy, 'forward deployment strategy', [
    'id', 'version', 'repoCommit', 'configHash', 'engineCommit', 'lifecycle', 'objectModel', 'baseTimeframe',
  ])
  const lifecycle = text(strategy.lifecycle, 'strategy.lifecycle') as StrategyLifecycle
  if (!DRY_RUN_LIFECYCLES.has(lifecycle)) throw new Error(`strategy lifecycle ${lifecycle} cannot run forward dry-run`)
  const objectModel = text(strategy.objectModel, 'strategy.objectModel') as StrategyObjectModel
  if (objectModel !== 'PRICE_EVENT' && objectModel !== 'TRADE_THESIS') throw new Error('strategy.objectModel is invalid')
  const repoCommit = text(strategy.repoCommit, 'strategy.repoCommit')
  const engineCommit = text(strategy.engineCommit, 'strategy.engineCommit')
  const configHash = text(strategy.configHash, 'strategy.configHash')
  if (!COMMIT_PATTERN.test(repoCommit) || !COMMIT_PATTERN.test(engineCommit)) {
    throw new Error('forward deployment requires full strategy and Engine commits')
  }
  if (!HASH_PATTERN.test(configHash)) throw new Error('strategy.configHash must be a SHA-256 hash')
  const baseTimeframe = strategyTimeframeMilliseconds(strategy.baseTimeframe).timeframe
  const walkForwardReportHash = source.walkForwardReportHash === undefined
    ? undefined
    : text(source.walkForwardReportHash, 'walkForwardReportHash')
  if (walkForwardReportHash !== undefined && !HASH_PATTERN.test(walkForwardReportHash)) {
    throw new Error('walkForwardReportHash must be a SHA-256 hash')
  }
  return {
    schemaVersion: STRATEGY_FORWARD_DEPLOYMENT_SCHEMA_VERSION,
    deploymentId: text(source.deploymentId, 'deploymentId'),
    mode: 'dry_run',
    activatedAt: Number(source.activatedAt),
    provider: 'okx',
    instrumentId: text(source.instrumentId, 'instrumentId'),
    symbol: text(source.symbol, 'symbol'),
    ...(walkForwardReportHash ? { walkForwardReportHash } : {}),
    strategy: {
      id: text(strategy.id, 'strategy.id'),
      version: text(strategy.version, 'strategy.version'),
      repoCommit,
      configHash,
      engineCommit,
      lifecycle,
      objectModel,
      baseTimeframe,
    },
  }
}

export function assertStrategyForwardDeployment(value: unknown): StrategyForwardDeployment {
  const hasReport = Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'walkForwardReportHash'))
  const source = exactRecord(value, 'forward deployment envelope', [
    'schemaVersion', 'deploymentId', 'mode', 'activatedAt', 'provider', 'instrumentId', 'symbol', 'strategy',
    ...(hasReport ? ['walkForwardReportHash'] : []),
    'deploymentHash',
  ])
  const deploymentHash = text(source.deploymentHash, 'deploymentHash')
  if (!HASH_PATTERN.test(deploymentHash)) throw new Error('deploymentHash must be a SHA-256 hash')
  const payload = normalizeDeploymentPayload(Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== 'deploymentHash'),
  ))
  const expectedHash = strategyForwardDeploymentHash(payload)
  if (deploymentHash !== expectedHash) throw new Error(`forward deployment hash mismatch: expected ${expectedHash}`)
  return Object.freeze({ ...payload, strategy: Object.freeze(payload.strategy), deploymentHash })
}

export function createStrategyForwardDeployment(
  snapshot: StrategyRepositorySnapshot,
  options: {
    strategyId: string
    instrumentId: string
    symbol: string
    activatedAt: number
    deploymentId?: string
    walkForwardReportHash?: string
  },
): StrategyForwardDeployment {
  const manifest = snapshot.manifests.find((candidate) => candidate.id === options.strategyId)
  if (!manifest) throw new Error(`unknown strategy id ${options.strategyId}`)
  const identity = createStrategyDecisionIdentityFromSnapshot(snapshot, {
    strategyId: options.strategyId,
    marketDataSnapshotId: `sha256:${'0'.repeat(64)}`,
  })
  const executionTimeframe = manifest.timeframes.find(({ role }) => role === 'execution')?.timeframe
  if (!executionTimeframe) throw new Error(`${manifest.id} manifest has no execution timeframe`)
  const payload = normalizeDeploymentPayload({
    schemaVersion: STRATEGY_FORWARD_DEPLOYMENT_SCHEMA_VERSION,
    deploymentId: options.deploymentId ?? randomUUID(),
    mode: 'dry_run',
    activatedAt: options.activatedAt,
    provider: 'okx',
    instrumentId: options.instrumentId,
    symbol: options.symbol,
    ...(options.walkForwardReportHash ? { walkForwardReportHash: options.walkForwardReportHash } : {}),
    strategy: {
      id: manifest.id,
      version: manifest.version,
      repoCommit: identity.strategyRepoCommit,
      configHash: identity.strategyConfigHash,
      engineCommit: identity.engineCommit,
      lifecycle: manifest.lifecycle,
      objectModel: manifest.objectModel,
      baseTimeframe: executionTimeframe,
    },
  })
  return assertStrategyForwardDeployment({ ...payload, deploymentHash: strategyForwardDeploymentHash(payload) })
}

export function assertStrategyForwardDataset(
  deploymentValue: StrategyForwardDeployment,
  datasetValue: StrategyHistoricalDataset,
) {
  const deployment = assertStrategyForwardDeployment(deploymentValue)
  const dataset = assertStrategyHistoricalDataset(datasetValue)
  if (dataset.source.provider !== deployment.provider
    || dataset.source.instrumentId !== deployment.instrumentId
    || dataset.source.symbol !== deployment.symbol) {
    throw new Error('forward dataset source does not match the deployment')
  }
  return dataset
}

export function requireCurrentStrategyForwardDeployment(
  deploymentValue: StrategyForwardDeployment,
  snapshot: StrategyRepositorySnapshot,
) {
  const deployment = assertStrategyForwardDeployment(deploymentValue)
  const manifest = snapshot.manifests.find((candidate) => candidate.id === deployment.strategy.id)
  if (!manifest) throw new Error(`deployed strategy ${deployment.strategy.id} is unavailable`)
  const identity = createStrategyDecisionIdentityFromSnapshot(snapshot, {
    strategyId: deployment.strategy.id,
    marketDataSnapshotId: `sha256:${'0'.repeat(64)}`,
  })
  const current = {
    version: manifest.version,
    repoCommit: identity.strategyRepoCommit,
    configHash: identity.strategyConfigHash,
    engineCommit: identity.engineCommit,
    lifecycle: manifest.lifecycle,
    objectModel: manifest.objectModel,
    baseTimeframe: manifest.timeframes.find(({ role }) => role === 'execution')?.timeframe,
  }
  for (const field of Object.keys(current) as Array<keyof typeof current>) {
    if (current[field] !== deployment.strategy[field]) {
      throw new Error(`forward deployment strategy ${field} no longer matches its pin`)
    }
  }
  return manifest
}

export function strategyForwardFirstDecisionTime(deploymentValue: StrategyForwardDeployment) {
  const deployment = assertStrategyForwardDeployment(deploymentValue)
  const { duration } = strategyTimeframeMilliseconds(deployment.strategy.baseTimeframe)
  return (Math.floor(deployment.activatedAt / duration) + 1) * duration
}
