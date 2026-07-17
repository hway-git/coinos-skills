export type FreqtradeSourceStatus = 'live' | 'partial' | 'offline'

export type FreqtradeTableRow = Record<string, string | number>

export type FreqtradeBacktestRequest = {
  strategy: string
  timeframe: string
  timerange?: string
  pairs?: string[]
}

export type FreqtradeStrategyCreateRequest = {
  name: string
  timeframe: string
  direction: 'long' | 'short' | 'both'
  indicators: string[]
}

export type FreqtradeStrategyCreateResult = {
  strategy: string
  timeframe: string
  direction: string
  indicators: string[]
  note: string
  next: string
}

export type FreqtradeDryRunDeployRequest = {
  strategy?: string
  signalArtifactHash?: string
  walkForwardReportFile?: string
  pairs?: string[]
  maxOpenTrades?: number
}

export type FreqtradeDryRunDeployResult = {
  strategy: string
  signalArtifactHash?: string
  walkForwardReportHash?: string
  mode: string
  dryRun: true
  pairs: string[]
  maxOpenTrades?: number
  forwardRuntime?: {
    deploymentHash: string
    activatedAt: number
    workerPid: number
    state: string
  }
  note: string
}

export type FreqtradeLiveDeployResult = {
  strategy: string
  signalArtifactHash?: string
  walkForwardReportHash?: string
  mode: string
  dryRun: false
  pairs: string[]
  maxOpenTrades: number
  note: string
}

export type FreqtradeEmergencyStopResult = {
  success: boolean
  operationError: string | null
  openTradesBefore: number | null
  openTradesAfter: number | null
  forceExitError: string | null
  stopError: string | null
  reconciliationStatus: FreqtradeReconciliationResult['status'] | null
  reconciliationError: string | null
  reconciliationMismatches: FreqtradeReconciliationResult['mismatches']
}

export type FreqtradeDeploymentBlocker =
  | 'EVIDENCE_STALE_OR_INVALID'
  | 'NO_TRADES'
  | 'NON_POSITIVE_PROFIT'
  | 'WALK_FORWARD_REPORT_MISSING'
  | 'LIFECYCLE_NOT_DRY_RUN'
  | 'LIFECYCLE_NOT_LIVE'
  | 'FORWARD_LIVE_UNAVAILABLE'

export type FreqtradeDeploymentGate = {
  allowed: boolean
  blockers: FreqtradeDeploymentBlocker[]
}

export type FreqtradeDeploymentCandidate = {
  key: string
  strategy: string
  evidenceId: string
  createdAt: string
  current: boolean
  signalArtifact: {
    artifactHash: string
    strategyId: string
    strategyVersion: string
    lifecycle: string
    symbol: string
    baseTimeframe: string
  } | null
  walkForwardReport: {
    reportHash: string
    reportFile: string
  } | null
  pairs: string[]
  metrics: {
    trades: number | null
    profitRatio: number | null
    profitAbs: number | null
    winRate: number | null
    drawdownRatio: number | null
  }
  dryRun: FreqtradeDeploymentGate
  live: FreqtradeDeploymentGate
}

export type FreqtradeReconciliationResult = {
  status: 'matched' | 'mismatch' | 'not_applicable' | 'offline'
  checkedAt: number
  botPositions: number
  exchangePositions: number
  mismatches: Array<{
    symbol: string
    side: string
    orderId?: string
    issue: string
    botAmount: number
    exchangeAmount: number
  }>
  detail: string
}

export type FreqtradeBacktestResult = {
  strategy: string
  timeframe: string
  timerange: string
  output: string
}

export type FreqtradeSnapshot = {
  ok: boolean
  mode: 'read_only'
  daemon: {
    online: boolean
    strategy: string
    timeframe: string
    dryRun: boolean | null
    tradingMode: string
    openTrades: number
    maxOpenTrades: number | string
    stakeCurrency: string
    pairs: string[]
    signalArtifactHash: string | null
    version: string
  }
  profit: {
    closed: string
    total: string
    floating: string
    closedTrades: number | string
  }
  forwardRuntime: {
    deploymentHash: string | null
    pid: number | null
    running: boolean
    state: string
    heartbeatAgeMs: number | null
    lastDecisionTime: number | null
    lastMarketSnapshotId: string | null
    lastBatchHash: string | null
    batches: number
    error: string | null
  } | null
  tables: {
    positions: FreqtradeTableRow[]
    history: FreqtradeTableRow[]
    strategies: FreqtradeTableRow[]
    backtests: FreqtradeTableRow[]
    risk: FreqtradeTableRow[]
    audit: FreqtradeTableRow[]
  }
  deployments: FreqtradeDeploymentCandidate[]
  source: {
    name: 'Freqtrade'
    status: FreqtradeSourceStatus
    fetchedAt: number
    errors: string[]
    permissions: {
      read: boolean
      trade: false
    }
  }
}
