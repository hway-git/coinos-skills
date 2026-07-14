import assert from 'node:assert/strict'
import test from 'node:test'
import type { Candle, IntradaySignalTimeframe } from '@helix/contracts/market'
import { buildIntradaySignal, findConfirmedSwings } from './intraday'

function candle(time: number, close: number, previousClose = close, volume = 100): Candle {
  return {
    time,
    open: previousClose,
    high: Math.max(close, previousClose) + (close >= previousClose ? 0.9 : 0.7),
    low: Math.min(close, previousClose) - (close <= previousClose ? 0.9 : 0.7),
    close,
    volume,
  }
}

function seriesFromCloses(closes: number[], intervalMs: number) {
  return closes.map((close, index) => candle(
    1_700_000_000_000 + index * intervalMs,
    close,
    index === 0 ? close : closes[index - 1],
    index === closes.length - 1 ? 220 : 100,
  ))
}

function compactSeriesFromCloses(closes: number[], intervalMs: number, tail = 0.2) {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1]
    return {
      time: 1_700_000_000_000 + index * intervalMs,
      open,
      high: Math.max(open, close) + tail,
      low: Math.min(open, close) - tail,
      close,
      volume: 100,
    }
  })
}

function hourlyTrend(count = 120) {
  const closes = Array.from({ length: count }, (_, index) => 100 + index * 0.22 + Math.sin((index + 10) / 4) * 1.8)
  return compactSeriesFromCloses(closes, 60 * 60 * 1000)
}

function bullishSecondEntry(intervalMs: number, includeTrigger: boolean) {
  const closes = [100]
  for (let index = 1; index < 114; index += 1) {
    closes.push(closes.at(-1)! + 0.12 + index * 0.0025)
  }
  let price = closes.at(-1)!
  for (const change of [-0.08, 1.2, -0.08, -0.08, 1.2]) {
    price += change
    closes.push(price)
  }
  if (includeTrigger) closes.push(price + 0.6)
  return compactSeriesFromCloses(closes, intervalMs, 0.4)
}

function bullishDivergence(intervalMs: number, count = 120) {
  const closes: number[] = []
  let price = 100
  for (let index = 0; index < count; index += 1) {
    if (index < 60) price += Math.sin(index / 5) * 0.02
    else if (index < 76) price -= 0.65
    else if (index < 86) price += 0.6
    else if (index < 101) price -= 0.44
    else if (index < 111) price += 0.4
    else price += 0.03
    closes.push(price)
  }
  return seriesFromCloses(closes, intervalMs)
}

function inputFromCloses(closes: number[]) {
  return {
    tickSize: 0.1,
    candles: {
      '5m': seriesFromCloses(closes, 5 * 60 * 1000),
      '15m': seriesFromCloses(closes, 15 * 60 * 1000),
      '1h': seriesFromCloses(closes, 60 * 60 * 1000),
    } satisfies Record<IntradaySignalTimeframe, Candle[]>,
  }
}

test('a swing is unavailable until every right-side bar closes', () => {
  const candles = [
    candle(1, 10),
    candle(2, 11),
    { ...candle(3, 12), high: 15 },
    candle(4, 11),
    candle(5, 10),
  ]

  assert.equal(findConfirmedSwings(candles, 2, 2, 3).some((swing) => swing.side === 'high'), false)
  const confirmed = findConfirmedSwings(candles, 2, 2, 4).find((swing) => swing.side === 'high')
  assert.deepEqual(confirmed, { side: 'high', index: 2, knownAtIndex: 4, price: 15 })
})

test('indicator alignment without a PA setup is never actionable', () => {
  const closes = Array.from({ length: 100 }, (_, index) => 100 + index * 0.1)
  const result = buildIntradaySignal(inputFromCloses(closes))

  assert.notEqual(result.signal.status, 'actionable')
  assert.equal(result.signal.confidence, 0)
  assert.equal(result.signal.entry, undefined)
  assert.equal(result.signal.stopLoss, undefined)
  assert.ok(result.signal.logic.some((item) => item.includes('PA setup')))
})

test('MACD histogram divergence uses confirmed price swings', () => {
  const result = buildIntradaySignal({
    tickSize: 0.1,
    candles: {
      '5m': bullishDivergence(5 * 60 * 1000),
      '15m': bullishDivergence(15 * 60 * 1000),
      '1h': bullishDivergence(60 * 60 * 1000),
    },
  })

  assert.equal(result.timeframes['5m']?.macd.divergence, 'bullish')
  assert.ok((result.timeframes['5m']?.macd.divergenceBarsAgo ?? 99) >= 2)
})

test('a missing candle invalidates multi-timeframe evaluation', () => {
  const complete = seriesFromCloses(Array.from({ length: 100 }, (_, index) => 100 + index * 0.1), 5 * 60 * 1000)
  const withGap = complete.filter((_, index) => index !== 50)
  const result = buildIntradaySignal({
    tickSize: 0.1,
    candles: {
      '5m': withGap,
      '15m': seriesFromCloses(Array.from({ length: 100 }, (_, index) => 100 + index * 0.1), 15 * 60 * 1000),
      '1h': seriesFromCloses(Array.from({ length: 100 }, (_, index) => 100 + index * 0.1), 60 * 60 * 1000),
    },
  })

  assert.equal(result.signal.status, 'insufficient-data')
  assert.equal(result.timeframes['5m'], undefined)
})

test('a PA setup waits for a later closed-bar break before becoming actionable', () => {
  const waiting = buildIntradaySignal({
    tickSize: 0.1,
    candles: {
      '5m': bullishSecondEntry(5 * 60 * 1000, false),
      '15m': bullishSecondEntry(15 * 60 * 1000, false),
      '1h': hourlyTrend(),
    },
  })
  assert.equal(waiting.signal.status, 'watch')
  assert.equal(waiting.signal.entry, undefined)
  assert.ok(waiting.signal.logic.some((item) => item.includes('H2 second entry')))
  assert.ok(waiting.signal.warnings.some((item) => item.includes('后续闭合 K')))

  const result = buildIntradaySignal({
    tickSize: 0.1,
    candles: {
      '5m': bullishSecondEntry(5 * 60 * 1000, true),
      '15m': bullishSecondEntry(15 * 60 * 1000, true),
      '1h': hourlyTrend(),
    },
  })

  assert.equal(result.signal.bias.side, 'long')
  assert.equal(result.signal.status, 'actionable')
  assert.equal(result.signal.side, 'long')
  assert.equal(result.signal.confidence, 85)
  assert.ok(result.signal.entry)
  assert.ok(result.signal.stopLoss)
  assert.ok(result.signal.stopLoss.price < result.signal.entry.price)
  assert.ok(result.signal.logic.some((item) => item.includes('PA setup')))
})
