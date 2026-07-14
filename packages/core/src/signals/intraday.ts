import type {
  Candle,
  IntradayConfidenceLevel,
  IntradaySignalDirection,
  IntradaySignalTimeframe,
  IntradayTimeframeAnalysis,
  IntradayTradeSignal,
} from '@helix/contracts/market'
import {
  calculateAtrSeries,
  calculateMacdSeries,
  calculateRsiSeries,
  type NullableSeries,
} from '../technical-indicators/calculate'

const TIMEFRAMES: IntradaySignalTimeframe[] = ['5m', '15m', '1h']
const ENTRY_TIMEFRAMES: Array<Exclude<IntradaySignalTimeframe, '1h'>> = ['15m', '5m']
const MIN_BARS = 80
const CROSS_LOOKBACK = 3
const PA_EVENT_LOOKBACK = 3
const DIVERGENCE_MAX_AGE = 24
const DIVERGENCE_TRIGGER_MAX_AGE = 6
const RETEST_WINDOW = 6
const SETUP_MAX_AGE = 2
const MIN_STOP_DISTANCE_ATR = 1
const MAX_STOP_DISTANCE_ATR = 3
const MAX_ENTRY_DRIFT_ATR = 1
const TIMEFRAME_MS: Record<IntradaySignalTimeframe, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
}
type SwingSide = 'high' | 'low'
type SwingPoint = {
  side: SwingSide
  index: number
  knownAtIndex: number
  price: number
}
type DirectionalEvent = 'bullish' | 'bearish' | 'none'
type TimedEvent = { direction: DirectionalEvent; index?: number }
type PriceActionEvent = {
  type: IntradayTimeframeAnalysis['priceAction']['event']
  index: number
  level?: number
}
type MarketCycle = 'trend' | 'channel' | 'trading-range' | 'breakout-mode'
type MarketContext = {
  cycle: MarketCycle
  direction: IntradaySignalDirection
  confidence: number
  logic: string[]
}
type PaSetupType = 'second-entry' | 'breakout-pullback' | 'failed-breakout'
type PaExpectation = 'second-leg' | 'continuation' | 'range-rotation'
type PaSetup = {
  type: PaSetupType
  expectation: PaExpectation
  direction: Exclude<IntradaySignalDirection, 'neutral'>
  index: number
  quality: 1 | 2
  invalidation: number
  signalHigh: number
  signalLow: number
}
type SetupEvaluation = {
  timeframe: Exclude<IntradaySignalTimeframe, '1h'>
  setup: PaSetup
  armed: boolean
  triggered: boolean
  confidence: number
  logic: string[]
  warnings: string[]
}

export type IntradaySignalInput = {
  tickSize: number
  candles: Record<IntradaySignalTimeframe, Candle[]>
}

export type IntradaySignalResult = {
  signal: IntradayTradeSignal
  timeframes: Partial<Record<IntradaySignalTimeframe, IntradayTimeframeAnalysis>>
}

function lastNumber(series: NullableSeries) {
  for (let index = series.length - 1; index >= 0; index -= 1) {
    const value = series[index]
    if (value != null && Number.isFinite(value)) return value
  }
  return null
}

function validClosedCandles(timeframe: IntradaySignalTimeframe, candles: Candle[]) {
  if (candles.length < MIN_BARS) return false
  const interval = TIMEFRAME_MS[timeframe]
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]
    if (!Number.isFinite(candle.time)
      || !Number.isFinite(candle.open)
      || !Number.isFinite(candle.high)
      || !Number.isFinite(candle.low)
      || !Number.isFinite(candle.close)
      || !Number.isFinite(candle.volume)
      || candle.time <= 0
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < Math.max(candle.open, candle.close)
      || candle.volume < 0) {
      return false
    }
    if (index > 0 && candle.time - candles[index - 1].time !== interval) return false
  }
  return true
}

export function findConfirmedSwings(
  candles: Candle[],
  leftBars = 2,
  rightBars = 2,
  evaluationIndex = candles.length - 1,
) {
  const swings: SwingPoint[] = []
  const lastCandidate = Math.min(evaluationIndex - rightBars, candles.length - rightBars - 1)

  for (let index = leftBars; index <= lastCandidate; index += 1) {
    let swingHigh = true
    let swingLow = true
    for (let offset = 1; offset <= leftBars; offset += 1) {
      swingHigh = swingHigh && candles[index].high > candles[index - offset].high
      swingLow = swingLow && candles[index].low < candles[index - offset].low
    }
    for (let offset = 1; offset <= rightBars; offset += 1) {
      swingHigh = swingHigh && candles[index].high > candles[index + offset].high
      swingLow = swingLow && candles[index].low < candles[index + offset].low
    }
    if (swingHigh) swings.push({ side: 'high', index, knownAtIndex: index + rightBars, price: candles[index].high })
    if (swingLow) swings.push({ side: 'low', index, knownAtIndex: index + rightBars, price: candles[index].low })
  }

  return swings.sort((left, right) => left.knownAtIndex - right.knownAtIndex || left.index - right.index)
}

function recentCross(macd: number[], signal: number[], lookback = CROSS_LOOKBACK): TimedEvent {
  const start = Math.max(1, macd.length - lookback)
  for (let index = macd.length - 1; index >= start; index -= 1) {
    if (macd[index - 1] <= signal[index - 1] && macd[index] > signal[index]) {
      return { direction: 'bullish', index }
    }
    if (macd[index - 1] >= signal[index - 1] && macd[index] < signal[index]) {
      return { direction: 'bearish', index }
    }
  }
  return { direction: 'none' }
}

function recentRsiRecovery(rsi: NullableSeries, lookback = CROSS_LOOKBACK): TimedEvent {
  const start = Math.max(1, rsi.length - lookback)
  for (let index = rsi.length - 1; index >= start; index -= 1) {
    const previous = rsi[index - 1]
    const current = rsi[index]
    if (previous == null || current == null) continue
    if (previous <= 30 && current > 30) return { direction: 'bullish', index }
    if (previous >= 70 && current < 70) return { direction: 'bearish', index }
  }
  return { direction: 'none' }
}

function latestStructureRelation(swings: SwingPoint[], side: SwingSide, epsilon: number) {
  const sameSide = swings.filter((swing) => swing.side === side)
  if (sameSide.length < 2) return 'unknown' as const
  const previous = sameSide.at(-2)!
  const current = sameSide.at(-1)!
  if (current.price > previous.price + epsilon) return 'higher' as const
  if (current.price < previous.price - epsilon) return 'lower' as const
  return 'equal' as const
}

function divergence(
  swings: SwingPoint[],
  histogram: number[],
  lastIndex: number,
  epsilon: number,
): TimedEvent {
  const candidates: Array<{ direction: Exclude<DirectionalEvent, 'none'>; index: number }> = []

  for (const side of ['low', 'high'] as const) {
    const sameSide = swings.filter((swing) => swing.side === side)
    for (let index = sameSide.length - 1; index >= 1; index -= 1) {
      const current = sameSide[index]
      const previous = sameSide[index - 1]
      if (lastIndex - current.knownAtIndex > DIVERGENCE_MAX_AGE) break

      const currentHistogram = histogram[current.index]
      const previousHistogram = histogram[previous.index]
      if (side === 'low'
        && current.price < previous.price - epsilon
        && currentHistogram < 0
        && previousHistogram < 0
        && currentHistogram > previousHistogram) {
        candidates.push({ direction: 'bullish', index: current.knownAtIndex })
        break
      }
      if (side === 'high'
        && current.price > previous.price + epsilon
        && currentHistogram > 0
        && previousHistogram > 0
        && currentHistogram < previousHistogram) {
        candidates.push({ direction: 'bearish', index: current.knownAtIndex })
        break
      }
    }
  }

  const latest = candidates.sort((left, right) => right.index - left.index)[0]
  return latest ?? { direction: 'none' }
}

function latestSwingAt(swings: SwingPoint[], side: SwingSide, index: number) {
  for (let cursor = swings.length - 1; cursor >= 0; cursor -= 1) {
    const swing = swings[cursor]
    if (swing.side === side && swing.knownAtIndex <= index) return swing
  }
  return undefined
}

function breakAt(
  candles: Candle[],
  swings: SwingPoint[],
  index: number,
  direction: 'bullish' | 'bearish',
  epsilon: number,
) {
  if (index < 1) return undefined
  const swing = latestSwingAt(swings, direction === 'bullish' ? 'high' : 'low', index)
  if (!swing) return undefined

  if (direction === 'bullish'
    && candles[index - 1].close <= swing.price + epsilon
    && candles[index].close > swing.price + epsilon) {
    return swing.price
  }
  if (direction === 'bearish'
    && candles[index - 1].close >= swing.price - epsilon
    && candles[index].close < swing.price - epsilon) {
    return swing.price
  }
  return undefined
}

function retestAt(
  candles: Candle[],
  swings: SwingPoint[],
  index: number,
  direction: 'bullish' | 'bearish',
  epsilon: number,
) {
  let breakIndex: number | undefined
  let level: number | undefined
  for (let cursor = index - 1; cursor >= Math.max(1, index - RETEST_WINDOW); cursor -= 1) {
    const candidate = breakAt(candles, swings, cursor, direction, epsilon)
    if (candidate != null) {
      breakIndex = cursor
      level = candidate
      break
    }
  }
  if (breakIndex == null || level == null) return undefined

  for (let cursor = breakIndex + 1; cursor <= index; cursor += 1) {
    const matched = direction === 'bullish'
      ? candles[cursor].low <= level + epsilon && candles[cursor].close > level + epsilon
      : candles[cursor].high >= level - epsilon && candles[cursor].close < level - epsilon
    if (matched) return cursor === index ? level : undefined
  }
  return undefined
}

function directionalPaEvent(
  candles: Candle[],
  swings: SwingPoint[],
  index: number,
  direction: 'bullish' | 'bearish',
  epsilon: number,
): PriceActionEvent | null {
  const breakLevel = breakAt(candles, swings, index, direction, epsilon)
  if (breakLevel != null) {
    return { type: direction === 'bullish' ? 'bullish-break' : 'bearish-break', index, level: breakLevel }
  }

  const support = latestSwingAt(swings, 'low', index)
  const resistance = latestSwingAt(swings, 'high', index)
  const candle = candles[index]
  const level = direction === 'bullish' ? support?.price : resistance?.price
  if (level == null) return null

  const swept = direction === 'bullish'
    ? candle.low < level - epsilon && candle.close >= level - epsilon
    : candle.high > level + epsilon && candle.close <= level + epsilon
  if (swept) {
    return { type: direction === 'bullish' ? 'bullish-sweep' : 'bearish-sweep', index, level }
  }

  const retestLevel = retestAt(candles, swings, index, direction, epsilon)
  if (retestLevel != null) {
    return { type: direction === 'bullish' ? 'bullish-retest' : 'bearish-retest', index, level: retestLevel }
  }

  const rejected = direction === 'bullish'
    ? candle.low <= level + epsilon && candle.close > level + epsilon
    : candle.high >= level - epsilon && candle.close < level - epsilon
  if (rejected) {
    return { type: direction === 'bullish' ? 'bullish-rejection' : 'bearish-rejection', index, level }
  }
  return null
}

function paEventAt(candles: Candle[], swings: SwingPoint[], index: number, epsilon: number): PriceActionEvent {
  const bullish = directionalPaEvent(candles, swings, index, 'bullish', epsilon)
  const bearish = directionalPaEvent(candles, swings, index, 'bearish', epsilon)
  if (bullish && bearish) return { type: 'ambiguous', index }
  return bullish ?? bearish ?? { type: 'none', index }
}

function recentPaEvent(candles: Candle[], swings: SwingPoint[], epsilon: number) {
  const lastIndex = candles.length - 1
  for (let index = lastIndex; index >= Math.max(0, lastIndex - PA_EVENT_LOOKBACK + 1); index -= 1) {
    const event = paEventAt(candles, swings, index, epsilon)
    if (event.type !== 'none') return event
  }
  return { type: 'none', index: lastIndex } as PriceActionEvent
}

function analyzeTimeframe(
  timeframe: IntradaySignalTimeframe,
  candles: Candle[],
  tickSize: number,
): IntradayTimeframeAnalysis | null {
  if (!validClosedCandles(timeframe, candles)) return null

  const lastIndex = candles.length - 1
  const macd = calculateMacdSeries(candles)
  const rsi = calculateRsiSeries(candles)
  const atr = calculateAtrSeries(candles)
  const rsiValue = lastNumber(rsi)
  const atrValue = lastNumber(atr)
  if (rsiValue == null || atrValue == null || atrValue <= 0) return null

  const swings = findConfirmedSwings(candles)
  const cross = recentCross(macd.macd, macd.signal)
  const divergenceEvent = divergence(swings, macd.histogram, lastIndex, tickSize)
  const recovery = recentRsiRecovery(rsi)
  const paEvent = recentPaEvent(candles, swings, tickSize)
  const latest = candles[lastIndex]
  const volumeWindow = candles.slice(-20)
  const averageVolume = volumeWindow.reduce((sum, candle) => sum + candle.volume, 0) / volumeWindow.length
  const volumeRatio = averageVolume > 0 ? latest.volume / averageVolume : 0

  return {
    timeframe,
    latestTime: latest.time + TIMEFRAME_MS[timeframe],
    close: latest.close,
    atr: atrValue,
    macd: {
      value: macd.macd[lastIndex],
      signal: macd.signal[lastIndex],
      histogram: macd.histogram[lastIndex],
      momentum: macd.histogram[lastIndex] > 0 ? 'bullish' : macd.histogram[lastIndex] < 0 ? 'bearish' : 'mixed',
      cross: cross.direction,
      crossBarsAgo: cross.index == null ? undefined : lastIndex - cross.index,
      divergence: divergenceEvent.direction,
      divergenceBarsAgo: divergenceEvent.index == null ? undefined : lastIndex - divergenceEvent.index,
    },
    rsi: {
      value: rsiValue,
      state: rsiValue >= 70 ? 'overbought' : rsiValue <= 30 ? 'oversold' : 'neutral',
      recovery: recovery.direction,
      recoveryBarsAgo: recovery.index == null ? undefined : lastIndex - recovery.index,
    },
    volume: {
      value: latest.volume,
      average: averageVolume,
      ratio: volumeRatio,
      state: volumeRatio >= 1.2 ? 'expanding' : volumeRatio < 0.7 ? 'weak' : 'normal',
    },
    priceAction: {
      structureHigh: latestStructureRelation(swings, 'high', tickSize),
      structureLow: latestStructureRelation(swings, 'low', tickSize),
      event: paEvent.type,
      eventBarsAgo: paEvent.type === 'none' ? undefined : lastIndex - paEvent.index,
      eventLevel: paEvent.level,
      latestSwingHigh: latestSwingAt(swings, 'high', lastIndex)?.price,
      latestSwingLow: latestSwingAt(swings, 'low', lastIndex)?.price,
    },
  }
}

function emaSeries(candles: Candle[], period = 20) {
  const alpha = 2 / (period + 1)
  const values: number[] = []
  for (const candle of candles) {
    values.push(values.length === 0 ? candle.close : candle.close * alpha + values.at(-1)! * (1 - alpha))
  }
  return values
}

function mean(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function buildMarketContext(
  candles: Candle[],
  analysis: IntradayTimeframeAnalysis,
): MarketContext {
  const lastIndex = candles.length - 1
  const atrSeries = calculateAtrSeries(candles)
  const atr = analysis.atr
  const progress = (candles[lastIndex].close - candles[Math.max(0, lastIndex - 10)].close) / atr
  const overlap = mean(candles.slice(-10).map((candle, offset, window) => {
    if (offset === 0) return 0
    const previous = window[offset - 1]
    const range = Math.max(candle.high - candle.low, Number.EPSILON)
    return Math.max(0, Math.min(candle.high, previous.high) - Math.max(candle.low, previous.low)) / range
  }))
  const atrBaseline = mean(atrSeries.slice(-50).filter((value): value is number => value != null))

  const { structureHigh, structureLow } = analysis.priceAction
  const structureDirection: IntradaySignalDirection = structureHigh === 'higher' && structureLow !== 'lower'
    ? 'long'
    : structureHigh !== 'higher' && structureLow === 'lower'
      ? 'short'
      : 'neutral'
  let direction: IntradaySignalDirection = structureDirection !== 'neutral'
    ? structureDirection
    : progress >= 1
      ? 'long'
      : progress <= -1
        ? 'short'
        : 'neutral'

  const breakoutDirection = analysis.priceAction.eventBarsAgo === 0
    ? analysis.priceAction.event === 'bullish-break'
      ? 'long'
      : analysis.priceAction.event === 'bearish-break'
        ? 'short'
        : 'neutral'
    : 'neutral'
  const contraction = atrBaseline > 0 && atr <= atrBaseline * 0.75 && overlap >= 0.55
  let cycle: MarketCycle
  if (breakoutDirection !== 'neutral') {
    cycle = 'trend'
    direction = breakoutDirection
  } else if (contraction) {
    cycle = 'breakout-mode'
    direction = 'neutral'
  } else if (structureDirection !== 'neutral' && Math.abs(progress) >= 2 && overlap <= 0.45) {
    cycle = 'trend'
  } else if (direction !== 'neutral' && Math.abs(progress) >= 0.8 && overlap < 0.65) {
    cycle = 'channel'
  } else {
    cycle = 'trading-range'
    if (Math.abs(progress) < 0.75) direction = 'neutral'
  }

  const cycleLabel: Record<MarketCycle, string> = {
    trend: '趋势',
    channel: '通道',
    'trading-range': '交易区间',
    'breakout-mode': '突破模式',
  }
  const directionLabel = direction === 'long' ? '偏多' : direction === 'short' ? '偏空' : '中性'
  const structureLogic = structureDirection === 'long'
    ? '1h PA 形成更高高点/低点结构'
    : structureDirection === 'short'
      ? '1h PA 形成更低高点/低点结构'
      : `1h 最近 10 根 K 推进 ${progress.toFixed(2)} ATR`

  return {
    cycle,
    direction,
    confidence: direction === 'neutral' ? 0 : cycle === 'trend' ? 85 : cycle === 'channel' ? 70 : 50,
    logic: [`1h 市场状态：${cycleLabel[cycle]} · ${directionLabel}`, structureLogic],
  }
}

function barQuality(candle: Candle, atr: number, direction: Exclude<IntradaySignalDirection, 'neutral'>): 0 | 1 | 2 {
  const range = candle.high - candle.low
  if (!(range > 0) || !(atr > 0)) return 0
  const bodyRatio = Math.abs(candle.close - candle.open) / range
  const closeLocation = (candle.close - candle.low) / range
  const directional = direction === 'long' ? candle.close > candle.open : candle.close < candle.open
  if (!directional) return 0
  const goodClose = direction === 'long' ? closeLocation >= 0.75 : closeLocation <= 0.25
  if (bodyRatio >= 0.55 && goodClose && range <= atr * 1.8) return 2
  const acceptableClose = direction === 'long' ? closeLocation >= 0.6 : closeLocation <= 0.4
  return bodyRatio >= 0.3 && acceptableClose && range <= atr * 2 ? 1 : 0
}

function setupLabel(setup: PaSetup) {
  if (setup.type === 'second-entry') return setup.direction === 'long' ? 'H2 second entry' : 'L2 second entry'
  if (setup.type === 'breakout-pullback') return 'breakout pullback'
  return 'range-edge failed breakout'
}

function detectBreakoutSetup(
  candles: Candle[],
  atrSeries: NullableSeries,
  context: MarketContext,
): PaSetup | undefined {
  type ActiveBreakout = {
    direction: Exclude<IntradaySignalDirection, 'neutral'>
    level: number
    index: number
    close: number
    followed: boolean
  }
  let active: ActiveBreakout | undefined
  let latest: PaSetup | undefined

  for (let index = 20; index < candles.length; index += 1) {
    const atr = atrSeries[index]
    if (atr == null || atr <= 0) continue
    const candle = candles[index]
    const prior = candles.slice(index - 20, index)
    const priorHigh = Math.max(...prior.map((item) => item.high))
    const priorLow = Math.min(...prior.map((item) => item.low))
    const bullBreakout = candle.close > priorHigh + atr * 0.1 && barQuality(candle, atr, 'long') === 2
    const bearBreakout = candle.close < priorLow - atr * 0.1 && barQuality(candle, atr, 'short') === 2

    if (bullBreakout !== bearBreakout && (bullBreakout || bearBreakout)) {
      active = {
        direction: bullBreakout ? 'long' : 'short',
        level: bullBreakout ? priorHigh : priorLow,
        index,
        close: candle.close,
        followed: false,
      }
      continue
    }
    if (!active) continue

    const age = index - active.index
    if (age > 10) {
      active = undefined
      continue
    }
    const direction = active.direction
    const quality = barQuality(candle, atr, direction)
    const opposite = direction === 'long' ? 'short' : 'long'
    const oppositeQuality = barQuality(candle, atr, opposite)

    if (!active.followed) {
      const followed = direction === 'long'
        ? candle.close > active.close && quality === 2
        : candle.close < active.close && quality === 2
      if (followed) {
        active.followed = true
        continue
      }

      const failed = age <= 3 && oppositeQuality === 2 && (direction === 'long'
        ? candle.close < active.level - atr * 0.25
        : candle.close > active.level + atr * 0.25)
      if (failed && (context.cycle === 'trading-range' || context.cycle === 'breakout-mode')) {
        latest = {
          type: 'failed-breakout',
          expectation: 'range-rotation',
          direction: opposite,
          index,
          quality: 2,
          invalidation: opposite === 'long' ? candle.low : candle.high,
          signalHigh: candle.high,
          signalLow: candle.low,
        }
        active = undefined
      }
      continue
    }

    const pullback = quality === 2 && (direction === 'long'
      ? candle.low <= active.level + atr * 0.25 && candle.close > active.level
      : candle.high >= active.level - atr * 0.25 && candle.close < active.level)
    if (pullback) {
      latest = {
        type: 'breakout-pullback',
        expectation: 'continuation',
        direction,
        index,
        quality: 2,
        invalidation: direction === 'long'
          ? Math.min(candle.low, active.level)
          : Math.max(candle.high, active.level),
        signalHigh: candle.high,
        signalLow: candle.low,
      }
      active = undefined
    }
  }
  return latest
}

function detectSecondEntrySetup(
  candles: Candle[],
  atrSeries: NullableSeries,
  context: MarketContext,
  tickSize: number,
): PaSetup | undefined {
  if ((context.cycle !== 'trend' && context.cycle !== 'channel') || context.direction === 'neutral') return undefined

  const direction = context.direction
  let inPullback = false
  let attempts = 0
  let lastAttempt = -10
  let invalidation = direction === 'long' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  let latest: PaSetup | undefined
  const swings = findConfirmedSwings(candles)

  for (let index = Math.max(1, candles.length - 50); index < candles.length; index += 1) {
    const candle = candles[index]
    const previous = candles[index - 1]
    const atr = atrSeries[index]
    if (atr == null || atr <= 0) continue
    const pullingBack = direction === 'long'
      ? candle.close < candle.open || candle.low < previous.low
      : candle.close > candle.open || candle.high > previous.high
    if (pullingBack) {
      inPullback = true
      invalidation = direction === 'long'
        ? Math.min(invalidation, candle.low)
        : Math.max(invalidation, candle.high)
    }

    const quality = barQuality(candle, atr, direction)
    const continuationAttempt = inPullback
      && quality >= 1
      && (direction === 'long' ? candle.high > previous.high + tickSize : candle.low < previous.low - tickSize)
      && index - lastAttempt > 1
    if (continuationAttempt) {
      attempts += 1
      lastAttempt = index
      inPullback = false
      if (attempts >= 2) {
        latest = {
          type: 'second-entry',
          expectation: 'second-leg',
          direction,
          index,
          quality: quality === 2 ? 2 : 1,
          invalidation,
          signalHigh: candle.high,
          signalLow: candle.low,
        }
      }
    }

    const boundary = latestSwingAt(swings, direction === 'long' ? 'high' : 'low', index)
    const clearedPriorLeg = boundary != null && (direction === 'long'
      ? candle.close > boundary.price + atr * 0.1
      : candle.close < boundary.price - atr * 0.1)
    if (clearedPriorLeg) {
      inPullback = false
      attempts = 0
      invalidation = direction === 'long' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
    }
  }
  return latest
}

function detectLatestSetup(
  candles: Candle[],
  context: MarketContext,
  tickSize: number,
) {
  const atrSeries = calculateAtrSeries(candles)
  const setups = [
    detectBreakoutSetup(candles, atrSeries, context),
    detectSecondEntrySetup(candles, atrSeries, context, tickSize),
  ].filter((setup): setup is PaSetup => setup != null)
  const latest = setups.sort((left, right) => right.index - left.index)[0]
  return latest && candles.length - 1 - latest.index <= SETUP_MAX_AGE ? latest : undefined
}

function contextSupportsSetup(context: MarketContext, setup: PaSetup) {
  if (setup.type === 'failed-breakout') {
    return context.cycle === 'trading-range'
      || context.cycle === 'breakout-mode'
      || (context.cycle === 'channel' && context.direction === setup.direction)
  }
  return (context.cycle === 'trend' || context.cycle === 'channel') && context.direction === setup.direction
}

function evaluateSetup(
  timeframe: Exclude<IntradaySignalTimeframe, '1h'>,
  candles: Candle[],
  analysis: IntradayTimeframeAnalysis,
  hourlyCandles: Candle[],
  hourly: IntradayTimeframeAnalysis,
  context: MarketContext,
  setup: PaSetup,
  tickSize: number,
): SetupEvaluation {
  const lastIndex = candles.length - 1
  const hourlyLastIndex = hourlyCandles.length - 1
  const ema = emaSeries(candles)
  const hourlyEma = emaSeries(hourlyCandles)
  const emaSlope = ema[lastIndex] - ema[Math.max(0, lastIndex - 3)]
  const hourlyEmaSlope = hourlyEma[hourlyLastIndex] - hourlyEma[Math.max(0, hourlyLastIndex - 3)]
  const contextAligned = contextSupportsSetup(context, setup)
  const emaSupports = setup.direction === 'long'
    ? analysis.close >= ema[lastIndex] && emaSlope >= 0 && hourly.close >= hourlyEma[hourlyLastIndex] && hourlyEmaSlope >= 0
    : analysis.close <= ema[lastIndex] && emaSlope <= 0 && hourly.close <= hourlyEma[hourlyLastIndex] && hourlyEmaSlope <= 0
  const alignedMomentum = setup.direction === 'long' ? 'bullish' : 'bearish'
  const oppositeMomentum = setup.direction === 'long' ? 'bearish' : 'bullish'
  const momentumSupports = analysis.macd.momentum === alignedMomentum || analysis.macd.divergence === alignedMomentum
  const rsiSupports = setup.direction === 'long'
    ? analysis.rsi.value > 55 && hourly.rsi.value > 55
    : analysis.rsi.value < 45 && hourly.rsi.value < 45
  const opposingDivergence = analysis.macd.divergence === oppositeMomentum
    && (analysis.macd.divergenceBarsAgo ?? DIVERGENCE_MAX_AGE + 1) <= DIVERGENCE_TRIGGER_MAX_AGE
  const armed = contextAligned && setup.quality === 2 && emaSupports && momentumSupports && rsiSupports && !opposingDivergence
  const age = lastIndex - setup.index
  const triggered = age >= 1 && (setup.direction === 'long'
    ? candles[lastIndex].close > setup.signalHigh + tickSize
    : candles[lastIndex].close < setup.signalLow - tickSize)
  const logic = [
    `${timeframe} PA setup：${setupLabel(setup)}`,
    `${timeframe} expectation：${setup.expectation}`,
  ]
  const warnings: string[] = []

  if (contextAligned) logic.push('PA setup 与 1h market context 语义一致')
  else warnings.push(`${timeframe} PA setup 与 1h market context 不一致`)
  if (setup.quality === 2) logic.push(`${timeframe} signal bar 质量为 good`)
  else warnings.push(`${timeframe} signal bar 质量不足`)
  if (emaSupports) logic.push(`${timeframe}/1h 价格位置与 EMA20 slope 支持 expectation`)
  else warnings.push(`${timeframe}/1h EMA20 位置或 slope 反对 expectation`)
  if (momentumSupports) logic.push(`${timeframe} MACD 动能或背离支持 expectation`)
  else warnings.push(`${timeframe} MACD 未支持 expectation`)
  if (rsiSupports) logic.push(`${timeframe}/1h RSI 控制权支持 expectation`)
  else warnings.push(`${timeframe}/1h RSI 控制权未支持 expectation`)
  if (opposingDivergence) warnings.push(`${timeframe} 存在有效窗口内的反向 MACD 背离`)
  if (armed && !triggered) warnings.push(`等待后续闭合 K 突破 ${timeframe} signal bar ${setup.direction === 'long' ? 'high' : 'low'}`)

  return {
    timeframe,
    setup,
    armed,
    triggered,
    confidence: armed ? setup.type === 'failed-breakout' ? 80 : 85 : contextAligned ? 45 : 25,
    logic,
    warnings,
  }
}

function confidenceLevel(score: number): IntradayConfidenceLevel {
  if (score >= 85) return 'very-high'
  if (score >= 70) return 'high'
  if (score >= 55) return 'medium'
  return 'low'
}

function roundToTick(value: number, tickSize: number, mode: 'nearest' | 'down' | 'up' = 'nearest') {
  const scaled = value / tickSize
  const rounded = mode === 'down' ? Math.floor(scaled) : mode === 'up' ? Math.ceil(scaled) : Math.round(scaled)
  return Number((rounded * tickSize).toPrecision(14))
}

function fallbackStopBase(candles: Candle[], side: Exclude<IntradaySignalDirection, 'neutral'>) {
  const window = candles.slice(-10)
  return side === 'long'
    ? Math.min(...window.map((candle) => candle.low))
    : Math.max(...window.map((candle) => candle.high))
}

function insufficientSignal(): IntradayTradeSignal {
  return {
    status: 'insufficient-data',
    side: 'neutral',
    bias: { side: 'neutral', confidence: 0, logic: [] },
    confidence: 0,
    confidenceLevel: 'low',
    logic: [],
    warnings: ['5m、15m 或 1h 已闭合 K 线不足，暂不生成信号'],
  }
}

export function buildIntradaySignal(input: IntradaySignalInput): IntradaySignalResult {
  if (!Number.isFinite(input.tickSize) || input.tickSize <= 0) {
    return { signal: insufficientSignal(), timeframes: {} }
  }

  const timeframes: Partial<Record<IntradaySignalTimeframe, IntradayTimeframeAnalysis>> = {}
  for (const timeframe of TIMEFRAMES) {
    const analysis = analyzeTimeframe(timeframe, input.candles[timeframe], input.tickSize)
    if (analysis) timeframes[timeframe] = analysis
  }

  const hourly = timeframes['1h']
  const fiveMinute = timeframes['5m']
  const fifteenMinute = timeframes['15m']
  if (!hourly || !fiveMinute || !fifteenMinute) {
    return { signal: insufficientSignal(), timeframes }
  }

  const context = buildMarketContext(input.candles['1h'], hourly)
  const evaluations = ENTRY_TIMEFRAMES.flatMap((timeframe) => {
    const setup = detectLatestSetup(input.candles[timeframe], context, input.tickSize)
    if (!setup) return []
    return [evaluateSetup(
      timeframe,
      input.candles[timeframe],
      timeframes[timeframe]!,
      input.candles['1h'],
      hourly,
      context,
      setup,
      input.tickSize,
    )]
  })
  const selected = evaluations.find((evaluation) => evaluation.armed && evaluation.triggered)
    ?? evaluations.find((evaluation) => evaluation.armed)
    ?? evaluations[0]
  const score = selected?.confidence ?? 0
  const logic = [...context.logic, ...(selected?.logic ?? [])]
  const warnings = [...(selected?.warnings ?? [])]
  if (!selected) logic.push('等待 15m 或 5m 出现有效 PA setup 与 expectation')

  let entry: IntradayTradeSignal['entry']
  let stopLoss: IntradayTradeSignal['stopLoss']
  let riskAcceptable = false
  let entryFresh = false

  if (selected?.armed && selected.triggered) {
    const { setup, timeframe } = selected
    const analysis = timeframes[timeframe]!
    const candles = input.candles[timeframe]
    const entryPrice = analysis.close
    const validInvalidation = Number.isFinite(setup.invalidation)
      && (setup.direction === 'long' ? setup.invalidation < entryPrice : setup.invalidation > entryPrice)
    const stopBase = validInvalidation ? setup.invalidation : fallbackStopBase(candles, setup.direction)
    const buffer = Math.max(analysis.atr * 0.25, input.tickSize * 2)
    const structuralStop = setup.direction === 'long' ? stopBase - buffer : stopBase + buffer
    const rawStop = setup.direction === 'long'
      ? Math.min(structuralStop, entryPrice - analysis.atr * MIN_STOP_DISTANCE_ATR)
      : Math.max(structuralStop, entryPrice + analysis.atr * MIN_STOP_DISTANCE_ATR)
    const stopPrice = roundToTick(rawStop, input.tickSize, setup.direction === 'long' ? 'down' : 'up')
    const zonePadding = analysis.atr * 0.1
    entry = {
      price: roundToTick(entryPrice, input.tickSize),
      zoneLow: roundToTick(entryPrice - zonePadding, input.tickSize, 'down'),
      zoneHigh: roundToTick(entryPrice + zonePadding, input.tickSize, 'up'),
      timeframe,
    }
    stopLoss = {
      price: stopPrice,
      basis: validInvalidation
        ? `${timeframe} PA hypothesis invalidation 外侧 0.25 ATR`
        : `${timeframe} 最近 10 根 K 极值外侧 0.25 ATR`,
    }

    const riskInAtr = Math.abs(entryPrice - stopPrice) / analysis.atr
    riskAcceptable = riskInAtr <= MAX_STOP_DISTANCE_ATR
    if (!riskAcceptable) warnings.push(`结构止损距离为 ${riskInAtr.toFixed(2)} ATR，超过 ${MAX_STOP_DISTANCE_ATR} ATR，不建议开单`)
    const triggerLevel = setup.direction === 'long' ? setup.signalHigh : setup.signalLow
    const entryDriftInAtr = Math.abs(entryPrice - triggerLevel) / analysis.atr
    entryFresh = entryDriftInAtr <= MAX_ENTRY_DRIFT_ATR
    if (!entryFresh) warnings.push(`当前价已偏离触发价 ${entryDriftInAtr.toFixed(2)} ATR，等待新的入场信号`)
  }

  const actionable = selected?.armed === true
    && selected.triggered
    && entry != null
    && stopLoss != null
    && riskAcceptable
    && entryFresh

  return {
    timeframes,
    signal: {
      status: actionable ? 'actionable' : 'watch',
      side: actionable ? selected.setup.direction : 'neutral',
      bias: { side: context.direction, confidence: context.confidence, logic: context.logic },
      confidence: score,
      confidenceLevel: confidenceLevel(score),
      entry: actionable ? entry : undefined,
      stopLoss: actionable ? stopLoss : undefined,
      triggeredAt: actionable
        ? input.candles[selected.timeframe].at(-1)!.time + TIMEFRAME_MS[selected.timeframe]
        : undefined,
      logic,
      warnings: [...new Set(warnings)],
    },
  }
}
