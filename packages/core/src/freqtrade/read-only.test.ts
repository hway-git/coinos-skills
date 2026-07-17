import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFreqtradeDeployCliParams,
  buildFreqtradeDeploymentCandidates,
  freqtradeForwardRuntimeError,
  normalizeFreqtradeDeployRequest,
  runReadOnlyFreqtradeBacktest,
} from './read-only'

const artifactHash = `sha256:${'a'.repeat(64)}`
const reportFile = '/tmp/walk-forward-report.json'

test('normalizes a signal artifact deploy and infers the adapter strategy', () => {
  assert.deepEqual(normalizeFreqtradeDeployRequest({
    signalArtifactHash: artifactHash,
    walkForwardReportFile: reportFile,
    pairs: [' btc/usdt:usdt '],
    maxOpenTrades: '1',
  }), {
    strategy: 'HelixSignalStrategy',
    signalArtifactHash: artifactHash,
    walkForwardReportFile: reportFile,
    pairs: ['BTC/USDT:USDT'],
    maxOpenTrades: 1,
  })

  assert.equal(normalizeFreqtradeDeployRequest({
    strategy: 'HelixSignalStrategy',
    signalArtifactHash: artifactHash,
    walkForwardReportFile: reportFile,
  }).strategy, 'HelixSignalStrategy')
})

test('rejects invalid or conflicting signal artifact deploy requests', () => {
  for (const invalid of [
    '',
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'a'.repeat(63)}`,
    ` sha256:${'a'.repeat(64)}`,
    `md5:${'a'.repeat(64)}`,
  ]) {
    assert.throws(
      () => normalizeFreqtradeDeployRequest({ signalArtifactHash: invalid }),
      /signalArtifactHash 必须是 sha256/,
    )
  }
  assert.throws(
    () => normalizeFreqtradeDeployRequest({ signalArtifactHash: 42 }),
    /signalArtifactHash 必须是 sha256/,
  )

  assert.throws(
    () => normalizeFreqtradeDeployRequest({ strategy: 'SampleStrategy', signalArtifactHash: artifactHash }),
    /signalArtifactHash 只能用于 HelixSignalStrategy/,
  )
  assert.throws(() => normalizeFreqtradeDeployRequest({}), /strategy 必须是有效的策略类名/)
  assert.throws(
    () => normalizeFreqtradeDeployRequest({ strategy: 'HelixSignalStrategy' }),
    /必须选择 exact signalArtifactHash/,
  )
  assert.throws(
    () => normalizeFreqtradeDeployRequest({ signalArtifactHash: artifactHash }),
    /必须选择 exact walkForwardReportFile/,
  )
})

test('keeps ordinary strategy deploys artifact-free', () => {
  const params = normalizeFreqtradeDeployRequest({
    strategy: 'SampleStrategy',
    pairs: ['BTC/USDT:USDT'],
    maxOpenTrades: 2,
  })
  assert.deepEqual(buildFreqtradeDeployCliParams(params, true), {
    strategy: 'SampleStrategy',
    dry_run: true,
    pairs: ['BTC/USDT:USDT'],
    max_open_trades: 2,
  })
})

test('maps browser artifact hash to the deploy CLI parameter', () => {
  const params = normalizeFreqtradeDeployRequest({
    signalArtifactHash: artifactHash,
    walkForwardReportFile: reportFile,
    pairs: ['BTC/USDT:USDT'],
    maxOpenTrades: 2,
  })
  assert.deepEqual(buildFreqtradeDeployCliParams(params, false), {
    strategy: 'HelixSignalStrategy',
    dry_run: false,
    signal_artifact_hash: artifactHash,
    walk_forward_report: reportFile,
    max_open_trades: 2,
  })
})

test('ordinary backtest API rejects Signal Artifact strategies without exact inputs', async () => {
  const result = await runReadOnlyFreqtradeBacktest({
    strategy: 'HelixSignalStrategy',
    timeframe: '1m',
    pairs: ['BTC/USDT:USDT'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /Signal Artifact.*exact market dataset/)
})

test('builds exact artifact candidates and keeps lifecycle gates separate', () => {
  const secondHash = `sha256:${'b'.repeat(64)}`
  const candidates = buildFreqtradeDeploymentCandidates({
    evidence: [
      {
        id: 'scalp-newest',
        strategy: 'HelixSignalStrategy',
        current: false,
        createdAt: '2026-07-16T02:00:00.000Z',
        pairs: ['BTC/USDT:USDT'],
        metrics: { trades: 11, profitPct: -0.0025 },
        signalArtifact: {
          artifactHash,
          strategyLifecycle: 'proposal',
          identity: { strategyId: 'helix_scalp_hunter', strategyVersion: '1.0.1' },
          symbol: 'BTC/USDT:USDT',
          baseTimeframe: '1m',
        },
        walkForwardReport: null,
      },
      {
        id: 'scalp-older-must-not-win',
        strategy: 'HelixSignalStrategy',
        current: true,
        metrics: { trades: 10, profitPct: 0.2 },
        signalArtifact: {
          artifactHash,
          strategyLifecycle: 'production',
          identity: { strategyId: 'helix_scalp_hunter', strategyVersion: '1.0.1' },
          symbol: 'BTC/USDT:USDT',
          baseTimeframe: '1m',
        },
        walkForwardReport: {
          reportHash: `sha256:${'c'.repeat(64)}`,
          reportFile,
        },
      },
      {
        id: 'swing-shadow',
        strategy: 'HelixSignalStrategy',
        current: true,
        metrics: { trades: 12, profitPct: 0.01 },
        signalArtifact: {
          artifactHash: secondHash,
          strategyLifecycle: 'shadow',
          identity: { strategyId: 'helix_swing_hunter', strategyVersion: '1.0.1' },
          symbol: 'ETH/USDT:USDT',
          baseTimeframe: '15m',
        },
        walkForwardReport: {
          reportHash: `sha256:${'d'.repeat(64)}`,
          reportFile: '/tmp/swing-walk-forward-report.json',
        },
      },
    ],
  })

  assert.equal(candidates.length, 2)
  assert.deepEqual(candidates[0].dryRun.blockers, [
    'EVIDENCE_STALE_OR_INVALID',
    'NON_POSITIVE_PROFIT',
    'WALK_FORWARD_REPORT_MISSING',
    'LIFECYCLE_NOT_DRY_RUN',
  ])
  assert.equal(candidates[0].evidenceId, 'scalp-newest')
  assert.equal(candidates[1].dryRun.allowed, true)
  assert.deepEqual(candidates[1].live.blockers, ['LIFECYCLE_NOT_LIVE', 'FORWARD_LIVE_UNAVAILABLE'])
  assert.deepEqual(candidates[1].pairs, ['ETH/USDT:USDT'])
})

test('treats a missing, stopped, or stale Signal forward runtime as unhealthy', () => {
  assert.match(freqtradeForwardRuntimeError('HelixSignalStrategy', null) || '', /is missing/)
  const runtime = {
    deploymentHash: artifactHash,
    pid: 42,
    running: true,
    state: 'ready',
    heartbeatAgeMs: 100,
    lastDecisionTime: null,
    lastMarketSnapshotId: null,
    lastBatchHash: null,
    batches: 0,
    error: null,
  }
  assert.equal(freqtradeForwardRuntimeError('HelixSignalStrategy', runtime), null)
  assert.match(freqtradeForwardRuntimeError('HelixSignalStrategy', {
    ...runtime, running: false, state: 'stopped',
  }) || '', /is stopped/)
  assert.match(freqtradeForwardRuntimeError('HelixSignalStrategy', {
    ...runtime, state: 'stale',
  }) || '', /is stale/)
  assert.equal(freqtradeForwardRuntimeError('SampleStrategy', null), null)
})
