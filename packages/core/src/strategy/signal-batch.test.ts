import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  STRATEGY_FORWARD_DEPLOYMENT_SCHEMA_VERSION,
  STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
  strategyForwardDecisionStateHash,
  strategyForwardDeploymentHash,
  type StrategyForwardDeploymentPayload,
} from './forward-runtime'
import {
  assertStrategySignalBatch,
  assertStrategySignalBatchChain,
  createStrategySignalBatch,
} from './signal-batch'
import { reconcileStrategyForwardBatchStore } from './forward-worker'

const minute = 60_000

function deployment() {
  const payload: StrategyForwardDeploymentPayload = {
    schemaVersion: STRATEGY_FORWARD_DEPLOYMENT_SCHEMA_VERSION,
    deploymentId: 'batch-test',
    mode: 'dry_run',
    activatedAt: 30_000,
    provider: 'okx',
    instrumentId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
    strategy: {
      id: 'helix_scalp_hunter', version: '1.0.1', repoCommit: 'a'.repeat(40),
      configHash: `sha256:${'b'.repeat(64)}`, engineCommit: 'c'.repeat(40),
      lifecycle: 'shadow', objectModel: 'PRICE_EVENT', baseTimeframe: '1m',
    },
  }
  return { ...payload, deploymentHash: strategyForwardDeploymentHash(payload) }
}

function identity(snapshot: string) {
  return {
    strategyId: 'helix_scalp_hunter', strategyVersion: '1.0.1', strategyRepoCommit: 'a'.repeat(40),
    strategyConfigHash: `sha256:${'b'.repeat(64)}`, engineCommit: 'c'.repeat(40),
    marketDataSnapshotId: `sha256:${snapshot.repeat(64)}`,
  }
}

function decisionStateHash(
  forward: ReturnType<typeof deployment>,
  snapshot: string,
  previousDecisionStateHash: string | null,
  evaluatorStateHash: string,
  position: ReturnType<typeof createStrategySignalBatch>['positionAfter'],
  signal: ReturnType<typeof createStrategySignalBatch>['signal'],
) {
  return strategyForwardDecisionStateHash({
    schemaVersion: STRATEGY_FORWARD_DECISION_STATE_SCHEMA_VERSION,
    deploymentHash: forward.deploymentHash,
    decisionTime: signal.decisionTime,
    marketDataSnapshotId: identity(snapshot).marketDataSnapshotId,
    previousDecisionStateHash,
    evaluatorStateHash,
    position,
    signal: {
      signalId: signal.signalId,
      decisionId: signal.decisionId,
      object: signal.object,
      action: signal.action,
      side: signal.side,
      reasonCodes: signal.reasonCodes,
    },
  })
}

test('builds an immutable ENTER/EXIT batch chain with per-decision market identity', () => {
  const forward = deployment()
  const position = {
    object: { model: 'PRICE_EVENT' as const, id: 'event-1' }, side: 'LONG' as const, entrySignalId: 'enter-1',
  }
  const enterSignal = {
    sequence: 0, signalId: 'enter-1', decisionId: 'decision-1', object: position.object,
    action: 'ENTER' as const, side: 'LONG' as const, sourceCandleOpenTime: minute, decisionTime: 2 * minute,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  }
  const enterEvaluatorStateHash = `sha256:${'1'.repeat(64)}`
  const enterDecisionStateHash = decisionStateHash(
    forward, 'd', null, enterEvaluatorStateHash, position, enterSignal,
  )
  const enter = createStrategySignalBatch({
    schemaVersion: 'helix.signal-batch/v1', deploymentHash: forward.deploymentHash,
    batchSequence: 0, previousBatchHash: null, identity: identity('d'), strategyLifecycle: 'shadow',
    previousDecisionStateHash: null, evaluatorStateHash: enterEvaluatorStateHash,
    decisionStateHash: enterDecisionStateHash,
    objectModel: 'PRICE_EVENT', symbol: forward.symbol, baseTimeframe: '1m',
    positionBefore: null, positionAfter: position,
    signal: enterSignal,
  })
  const exitSignal = {
    sequence: 1, signalId: 'exit-1', decisionId: 'decision-2', object: position.object,
    action: 'EXIT' as const, side: 'LONG' as const, sourceCandleOpenTime: 2 * minute, decisionTime: 3 * minute,
    reasonCodes: ['TIME_STOP'],
  }
  const exitEvaluatorStateHash = `sha256:${'3'.repeat(64)}`
  const exit = createStrategySignalBatch({
    schemaVersion: 'helix.signal-batch/v1', deploymentHash: forward.deploymentHash,
    batchSequence: 1, previousBatchHash: enter.batchHash, identity: identity('e'), strategyLifecycle: 'shadow',
    previousDecisionStateHash: enter.decisionStateHash, evaluatorStateHash: exitEvaluatorStateHash,
    decisionStateHash: decisionStateHash(
      forward, 'e', enter.decisionStateHash, exitEvaluatorStateHash, null, exitSignal,
    ),
    objectModel: 'PRICE_EVENT', symbol: forward.symbol, baseTimeframe: '1m',
    positionBefore: position, positionAfter: null,
    signal: exitSignal,
  })

  assert.deepEqual(assertStrategySignalBatchChain(forward, [enter, exit]), [enter, exit])
  const { batchHash: _enterHash, ...enterPayload } = enter
  const forgedState = createStrategySignalBatch({
    ...enterPayload,
    decisionStateHash: `sha256:${'f'.repeat(64)}`,
  })
  assert.throws(
    () => assertStrategySignalBatchChain(forward, [forgedState]),
    /decision state hash mismatch/,
  )
  assert.notEqual(enter.identity.marketDataSnapshotId, exit.identity.marketDataSnapshotId)
  assert.equal(Object.isFrozen(enter), true)
})

test('rejects batch tampering and broken hash or position continuity', () => {
  const forward = deployment()
  const position = {
    object: { model: 'PRICE_EVENT' as const, id: 'event-1' }, side: 'LONG' as const, entrySignalId: 'enter-1',
  }
  const enterSignal = {
    sequence: 0, signalId: 'enter-1', decisionId: 'decision-1', object: position.object,
    action: 'ENTER' as const, side: 'LONG' as const, sourceCandleOpenTime: minute, decisionTime: 2 * minute,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  }
  const evaluatorStateHash = `sha256:${'1'.repeat(64)}`
  const enter = createStrategySignalBatch({
    schemaVersion: 'helix.signal-batch/v1', deploymentHash: forward.deploymentHash,
    batchSequence: 0, previousBatchHash: null, identity: identity('d'), strategyLifecycle: 'shadow',
    previousDecisionStateHash: null, evaluatorStateHash,
    decisionStateHash: decisionStateHash(forward, 'd', null, evaluatorStateHash, position, enterSignal),
    objectModel: 'PRICE_EVENT', symbol: forward.symbol, baseTimeframe: '1m',
    positionBefore: null, positionAfter: position,
    signal: enterSignal,
  })
  const tampered = {
    ...structuredClone(enter),
    signal: { ...structuredClone(enter.signal), reasonCodes: ['CHANGED'] },
  }
  assert.throws(() => assertStrategySignalBatch(tampered), /hash mismatch/)

  const { batchHash: _batchHash, ...enterPayload } = enter
  const wrongPrevious = createStrategySignalBatch({
    ...enterPayload,
    batchSequence: 1,
    previousBatchHash: `sha256:${'f'.repeat(64)}`,
    positionBefore: position,
    positionAfter: null,
    signal: {
      ...enter.signal, sequence: 1, signalId: 'exit-1', decisionId: 'decision-2', action: 'EXIT',
      sourceCandleOpenTime: 2 * minute, decisionTime: 3 * minute, reasonCodes: ['TIME_STOP'],
    },
  })
  assert.throws(() => assertStrategySignalBatchChain(forward, [enter, wrongPrevious]), /chain is broken/)
  assert.throws(() => createStrategySignalBatch({
    ...enterPayload, batchSequence: 1, previousBatchHash: enter.batchHash,
    signal: { ...enter.signal, sequence: 1, signalId: 'exit-1', decisionId: 'decision-2', action: 'EXIT' },
  }), /EXIT batch must close/)
})

test('batch store appends deterministic replay once and rejects disk tampering', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-forward-batches-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const forward = deployment()
  const position = {
    object: { model: 'PRICE_EVENT' as const, id: 'event-store' }, side: 'LONG' as const, entrySignalId: 'enter-store',
  }
  const enterSignal = {
    sequence: 0, signalId: 'enter-store', decisionId: 'decision-store', object: position.object,
    action: 'ENTER' as const, side: 'LONG' as const, sourceCandleOpenTime: minute, decisionTime: 2 * minute,
    reasonCodes: ['EXECUTION_TRIGGERED'],
  }
  const evaluatorStateHash = `sha256:${'1'.repeat(64)}`
  const enter = createStrategySignalBatch({
    schemaVersion: 'helix.signal-batch/v1', deploymentHash: forward.deploymentHash,
    batchSequence: 0, previousBatchHash: null, identity: identity('d'), strategyLifecycle: 'shadow',
    previousDecisionStateHash: null, evaluatorStateHash,
    decisionStateHash: decisionStateHash(forward, 'd', null, evaluatorStateHash, position, enterSignal),
    objectModel: 'PRICE_EVENT', symbol: forward.symbol, baseTimeframe: '1m',
    positionBefore: null, positionAfter: position,
    signal: enterSignal,
  })

  assert.deepEqual(await reconcileStrategyForwardBatchStore(forward, [enter], directory), {
    existing: 0, appended: 1, total: 1,
  })
  assert.deepEqual(await reconcileStrategyForwardBatchStore(forward, [enter], directory), {
    existing: 1, appended: 0, total: 1,
  })
  const files = await readdir(directory)
  assert.equal(files.length, 1)
  const file = join(directory, files[0]!)
  const tampered = JSON.parse(await readFile(file, 'utf8'))
  tampered.signal.reasonCodes = ['CHANGED']
  await writeFile(file, JSON.stringify(tampered))
  await assert.rejects(
    reconcileStrategyForwardBatchStore(forward, [enter], directory),
    /signal batch hash mismatch/,
  )
})
