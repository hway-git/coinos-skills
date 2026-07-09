import type { MacroDataGroup, MacroDataPoint, MacroSnapshot } from '@/lib/market-data'

type FredSeries = {
  id: string
  label: string
  shortLabel: string
  group: MacroDataGroup
  unit: string
  frequency: 'daily' | 'weekly' | 'monthly'
  valueKind: 'percent' | 'index' | 'usd'
  changeKind: 'bp' | 'number' | 'pct'
  precision?: number
}

type FredObservation = {
  date: string
  value: string
}

type FredResponse = {
  observations?: FredObservation[]
  error_code?: number
  error_message?: string
}

type FredResult = {
  item?: MacroDataPoint
  error?: string
}

const FRED_BASE_URL = 'https://api.stlouisfed.org/fred/series/observations'
const REQUEST_TIMEOUT_MS = 10_000
const SERIES: FredSeries[] = [
  { id: 'DGS10', label: '美国 10 年期国债', shortLabel: 'US10Y', group: 'rates', unit: '%', frequency: 'daily', valueKind: 'percent', changeKind: 'bp', precision: 2 },
  { id: 'DGS2', label: '美国 2 年期国债', shortLabel: 'US02Y', group: 'rates', unit: '%', frequency: 'daily', valueKind: 'percent', changeKind: 'bp', precision: 2 },
  { id: 'T10Y2Y', label: '10Y-2Y 利差', shortLabel: '10Y-2Y', group: 'rates', unit: '%', frequency: 'daily', valueKind: 'percent', changeKind: 'bp', precision: 2 },
  { id: 'DFF', label: '联邦基金有效利率', shortLabel: 'Fed Funds', group: 'rates', unit: '%', frequency: 'daily', valueKind: 'percent', changeKind: 'bp', precision: 2 },
  { id: 'SOFR', label: 'SOFR', shortLabel: 'SOFR', group: 'rates', unit: '%', frequency: 'daily', valueKind: 'percent', changeKind: 'bp', precision: 2 },
  { id: 'VIXCLS', label: 'VIX 波动率指数', shortLabel: 'VIX', group: 'risk', unit: 'index', frequency: 'daily', valueKind: 'index', changeKind: 'number', precision: 2 },
  { id: 'SP500', label: '标普 500', shortLabel: 'S&P 500', group: 'risk', unit: 'index', frequency: 'daily', valueKind: 'index', changeKind: 'pct', precision: 2 },
  { id: 'DTWEXBGS', label: '美元广义指数', shortLabel: 'USD Broad', group: 'risk', unit: 'index', frequency: 'daily', valueKind: 'index', changeKind: 'pct', precision: 2 },
  { id: 'DCOILWTICO', label: 'WTI 原油', shortLabel: 'WTI', group: 'commodities', unit: 'USD', frequency: 'daily', valueKind: 'usd', changeKind: 'pct', precision: 2 },
  { id: 'GOLDAMGBD228NLBM', label: '伦敦黄金定盘价', shortLabel: 'Gold', group: 'commodities', unit: 'USD', frequency: 'daily', valueKind: 'usd', changeKind: 'pct', precision: 2 },
  { id: 'CPIAUCSL', label: '美国 CPI', shortLabel: 'CPI', group: 'inflation', unit: 'index', frequency: 'monthly', valueKind: 'index', changeKind: 'pct', precision: 1 },
  { id: 'UNRATE', label: '美国失业率', shortLabel: 'Unemployment', group: 'labor', unit: '%', frequency: 'monthly', valueKind: 'percent', changeKind: 'bp', precision: 1 },
]

function formatValue(value: number, series: FredSeries) {
  const precision = series.precision ?? 2
  if (series.valueKind === 'percent') return `${value.toFixed(precision)}%`
  if (series.valueKind === 'usd') return `$${value.toLocaleString('en-US', { maximumFractionDigits: precision })}`
  return value.toLocaleString('en-US', { maximumFractionDigits: precision })
}

function formatChange(value: number, previous: number, series: FredSeries) {
  const change = value - previous
  const sign = change >= 0 ? '+' : ''

  if (series.changeKind === 'bp') return `${sign}${(change * 100).toFixed(0)}bp`
  if (series.changeKind === 'pct') {
    if (!Number.isFinite(previous) || previous === 0) return undefined
    const percent = (change / previous) * 100
    return `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`
  }

  return `${sign}${change.toFixed(series.precision ?? 2)}`
}

function parseObservationValue(observation: FredObservation) {
  if (!observation.value || observation.value === '.') return null
  const value = Number(observation.value)
  return Number.isFinite(value) ? value : null
}

async function fetchSeries(series: FredSeries, apiKey: string): Promise<FredResult> {
  const url = new URL(FRED_BASE_URL)
  url.searchParams.set('series_id', series.id)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('file_type', 'json')
  url.searchParams.set('sort_order', 'desc')
  url.searchParams.set('limit', '14')

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const payload = (await response.json()) as FredResponse

    if (!response.ok || payload.error_code) {
      return {
        error: `${series.id}: ${payload.error_message ?? `FRED HTTP ${response.status}`}`,
      }
    }

    const valid = (payload.observations ?? [])
      .map((observation) => ({ observation, value: parseObservationValue(observation) }))
      .filter((entry): entry is { observation: FredObservation; value: number } => entry.value != null)

    const latest = valid[0]
    if (!latest) return { error: `${series.id}: 无有效观测值` }

    const previous = valid[1]?.value
    const change = previous == null ? undefined : latest.value - previous
    const changeLabel = previous == null ? undefined : formatChange(latest.value, previous, series)
    const item: MacroDataPoint = {
      id: series.id,
      label: series.label,
      shortLabel: series.shortLabel,
      group: series.group,
      value: latest.value,
      valueLabel: formatValue(latest.value, series),
      date: latest.observation.date,
      unit: series.unit,
      frequency: series.frequency,
      source: 'FRED',
    }

    if (previous != null) item.previous = previous
    if (change != null) item.change = change
    if (changeLabel) item.changeLabel = changeLabel

    return { item }
  } catch (error) {
    return { error: `${series.id}: ${error instanceof Error ? error.message : 'FRED 请求失败'}` }
  }
}

export async function getFredMacroSnapshot(): Promise<MacroSnapshot> {
  const apiKey = process.env.FRED_API_KEY?.trim()
  if (!apiKey) {
    return {
      ok: false,
      items: [],
      source: {
        name: 'FRED',
        status: 'offline',
        fetchedAt: Date.now(),
        errors: ['未配置 FRED_API_KEY'],
      },
    }
  }

  const results = await Promise.all(SERIES.map((series) => fetchSeries(series, apiKey)))
  const items = results.flatMap((result) => (result.item ? [result.item] : []))
  const errors = results.flatMap((result) => (result.error ? [result.error] : []))
  const status = items.length === 0 ? 'offline' : errors.length > 0 ? 'partial' : 'live'

  return {
    ok: items.length > 0,
    items,
    source: {
      name: 'FRED',
      status,
      fetchedAt: Date.now(),
      errors,
    },
  }
}
