import type { Candle } from '@helix/contracts/market'
import type {
  StrategyDecisionIdentity,
  StrategyLifecycle,
  StrategyObjectModel,
  StrategyPositionSide,
  StrategySignalAction,
  StrategySignalArtifact,
} from '@helix/contracts/strategy'
import type { StrategyHistoricalDataset } from '@helix/contracts/strategy'
import { assertStrategyHistoricalDataset } from './historical-dataset'
import { createStrategySignalArtifact, strategyTimeframeMilliseconds } from './signal-artifact'

export type HistoricalSignalDecision = Readonly<{
  signalId: string
  decisionId: string
  object: Readonly<{ model: StrategyObjectModel; id: string }>
  action: StrategySignalAction
  side: StrategyPositionSide
  reasonCodes: readonly string[]
}>

export type HistoricalDecisionContext = Readonly<{
  symbol: string
  baseTimeframe: string
  decisionTime: number
  sourceCandle: Readonly<Candle>
  candles: Readonly<Record<string, readonly Candle[]>>
}>

export type HistoricalStrategyEvaluator = (context: HistoricalDecisionContext) => readonly HistoricalSignalDecision[]

function arrayIndex(property: PropertyKey) {
  if (typeof property !== 'string' || !/^(0|[1-9][0-9]*)$/.test(property)) return null
  const index = Number(property)
  return Number.isSafeInteger(index) ? index : null
}

function closedCandleView(source: readonly Candle[], end: number): readonly Candle[] {
  const target: Candle[] = []
  return new Proxy(target, {
    get(array, property, receiver) {
      if (property === 'length') return end
      const index = arrayIndex(property)
      if (index !== null) return index < end ? source[index] : undefined
      return Reflect.get(array, property, receiver)
    },
    has(array, property) {
      const index = arrayIndex(property)
      if (index !== null) return index < end
      return Reflect.has(array, property)
    },
    ownKeys() {
      return [...Array.from({ length: end }, (_, index) => String(index)), 'length']
    },
    getOwnPropertyDescriptor(array, property) {
      if (property === 'length') return Reflect.getOwnPropertyDescriptor(array, property)
      const index = arrayIndex(property)
      if (index !== null && index < end) {
        return { configurable: true, enumerable: true, writable: false, value: source[index] }
      }
      return Reflect.getOwnPropertyDescriptor(array, property)
    },
    set() {
      throw new Error('historical candle views are read-only')
    },
    deleteProperty() {
      throw new Error('historical candle views are read-only')
    },
    defineProperty() {
      throw new Error('historical candle views are read-only')
    },
  })
}

export function historicalDecisionContexts(options: {
  dataset: StrategyHistoricalDataset
  baseTimeframe: string
  firstDecisionTime?: number
  afterDecisionTime?: number
  requiredTimeframes: readonly string[]
}) {
  const dataset = assertStrategyHistoricalDataset(options.dataset)
  if (!options.requiredTimeframes.includes(options.baseTimeframe)) {
    throw new Error('requiredTimeframes must include baseTimeframe')
  }
  const uniqueTimeframes = [...new Set(options.requiredTimeframes)]
  for (const timeframe of uniqueTimeframes) {
    if (!dataset.timeframes[timeframe]) throw new Error(`historical dataset is missing required timeframe ${timeframe}`)
  }
  const { duration: baseDuration } = strategyTimeframeMilliseconds(options.baseTimeframe)
  const baseCandles = dataset.timeframes[options.baseTimeframe]!
  const firstBaseOpen = baseCandles[0]!.time
  const lastBaseClose = baseCandles.at(-1)!.time + baseDuration
  const firstDecisionTime = options.firstDecisionTime ?? firstBaseOpen + baseDuration
  if (!Number.isSafeInteger(firstDecisionTime)
    || firstDecisionTime % baseDuration !== 0
    || firstDecisionTime < firstBaseOpen + baseDuration
    || firstDecisionTime > lastBaseClose) {
    throw new Error('firstDecisionTime must be an aligned base candle close inside the dataset window')
  }
  const afterDecisionTime = options.afterDecisionTime ?? -1
  if (!Number.isSafeInteger(afterDecisionTime) || afterDecisionTime < -1) {
    throw new Error('afterDecisionTime must be a non-negative integer timestamp or -1')
  }
  for (const timeframe of uniqueTimeframes) {
    const source = dataset.timeframes[timeframe]!
    const { duration } = strategyTimeframeMilliseconds(timeframe)
    if (source[0]!.time > firstBaseOpen) {
      throw new Error(`historical dataset timeframe ${timeframe} starts after the base timeframe window`)
    }
    const requiredClose = Math.floor(lastBaseClose / duration) * duration
    const actualClose = source.at(-1)!.time + duration
    if (actualClose < requiredClose) {
      throw new Error(`historical dataset timeframe ${timeframe} ends before the base timeframe window`)
    }
  }
  const cursors = Object.fromEntries(uniqueTimeframes.map((timeframe) => [timeframe, 0])) as Record<string, number>
  const contexts: HistoricalDecisionContext[] = []

  for (const sourceCandle of baseCandles) {
    const decisionTime = sourceCandle.time + baseDuration
    const contextCandles: Record<string, readonly Candle[]> = {}
    for (const timeframe of uniqueTimeframes) {
      const source = dataset.timeframes[timeframe]!
      const { duration } = strategyTimeframeMilliseconds(timeframe)
      let cursor = cursors[timeframe]!
      while (cursor < source.length && source[cursor]!.time + duration <= decisionTime) {
        cursor += 1
      }
      cursors[timeframe] = cursor
      contextCandles[timeframe] = closedCandleView(source, cursor)
    }
    if (decisionTime < firstDecisionTime || decisionTime <= afterDecisionTime) continue
    const context: HistoricalDecisionContext = Object.freeze({
      symbol: dataset.source.symbol,
      baseTimeframe: options.baseTimeframe,
      decisionTime,
      sourceCandle,
      candles: Object.freeze(contextCandles),
    })
    contexts.push(context)
  }
  return {
    dataset,
    baseDuration,
    firstDecisionTime,
    lastBaseClose,
    contexts: Object.freeze(contexts),
  }
}

export function runHistoricalStrategy(options: {
  dataset: StrategyHistoricalDataset
  identity: StrategyDecisionIdentity
  strategyLifecycle: StrategyLifecycle
  objectModel: StrategyObjectModel
  baseTimeframe: string
  firstDecisionTime?: number
  requiredTimeframes: readonly string[]
  registeredReasonCodes: readonly string[]
  evaluate: HistoricalStrategyEvaluator
}): StrategySignalArtifact {
  const prepared = historicalDecisionContexts(options)
  if (options.identity.marketDataSnapshotId !== prepared.dataset.datasetHash) {
    throw new Error('identity.marketDataSnapshotId must equal the historical dataset hash')
  }
  const registeredReasonCodes = new Set(options.registeredReasonCodes)
  if (registeredReasonCodes.size === 0) throw new Error('registeredReasonCodes must not be empty')
  const signals: Array<HistoricalSignalDecision & {
    sequence: number
    sourceCandleOpenTime: number
    decisionTime: number
  }> = []

  for (const context of prepared.contexts) {
    const decisions = options.evaluate(context)
    if (!Array.isArray(decisions)) throw new Error('historical evaluator must return an array')
    for (const decision of decisions) {
      if (decision.object.model !== options.objectModel) {
        throw new Error('historical decision object model must match the strategy artifact')
      }
      for (const reasonCode of decision.reasonCodes) {
        if (!registeredReasonCodes.has(reasonCode)) {
          throw new Error(`historical decision uses unregistered reason code ${reasonCode}`)
        }
      }
      signals.push({
        ...decision,
        sequence: signals.length,
        sourceCandleOpenTime: context.sourceCandle.time,
        decisionTime: context.decisionTime,
      })
    }
  }

  return createStrategySignalArtifact({
    schemaVersion: 'helix.signal-artifact/v1',
    identity: options.identity,
    strategyLifecycle: options.strategyLifecycle,
    objectModel: options.objectModel,
    symbol: prepared.dataset.source.symbol,
    baseTimeframe: options.baseTimeframe,
    marketData: {
      firstCandleOpenTime: prepared.firstDecisionTime - prepared.baseDuration,
      lastCandleCloseTime: prepared.lastBaseClose,
    },
    signals,
  })
}
