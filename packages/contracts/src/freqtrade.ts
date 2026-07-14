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
  strategy: string
  pairs?: string[]
  maxOpenTrades?: number
}

export type FreqtradeDryRunDeployResult = {
  strategy: string
  mode: string
  dryRun: true
  pairs: string[]
  maxOpenTrades?: number
  note: string
}

export type FreqtradeLiveDeployResult = {
  strategy: string
  mode: string
  dryRun: false
  pairs: string[]
  maxOpenTrades: number
  note: string
}

export type FreqtradeEmergencyStopResult = {
  success: boolean
  openTradesBefore: number | null
  forceExitError: string | null
  stopError: string | null
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
    version: string
  }
  profit: {
    closed: string
    total: string
    floating: string
    closedTrades: number | string
  }
  tables: {
    positions: FreqtradeTableRow[]
    history: FreqtradeTableRow[]
    strategies: FreqtradeTableRow[]
    backtests: FreqtradeTableRow[]
    risk: FreqtradeTableRow[]
    audit: FreqtradeTableRow[]
  }
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
