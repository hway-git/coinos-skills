import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { MarketNewsItem, MarketNewsSnapshot } from '@/lib/market-data'

type AiCoinEnvelope = {
  ok?: boolean
  data?: unknown
  error?: {
    code?: string | number
    message?: string
  }
  _hint?: string
}

type AiCoinCall = {
  endpoint: string
  params: Record<string, string | number>
  source: string
}

type AiCoinResult = {
  endpoint: string
  source: string
  items: MarketNewsItem[]
  error?: string
}

const REQUEST_TIMEOUT_MS = 35_000
const AICOIN_HOME = 'https://www.aicoin.com'
const execFile = promisify(execFileCallback)
const AICOIN_CALLS: AiCoinCall[] = [
  { endpoint: 'content/newsflashes/aicoin', params: { locale: 'cn' }, source: 'AiCoin' },
  { endpoint: 'content/newsflashes/industry', params: { locale: 'cn', limit: 50 }, source: 'AiCoin 行业快讯' },
  { endpoint: 'content/articles', params: { limit: 20 }, source: 'AiCoin 资讯' },
]

const COLLECTION_KEYS = ['list', 'items', 'records', 'rows', 'data', 'newsflashes', 'articles', 'results']
const TITLE_KEYS = ['title', 'headline', 'name']
const SUMMARY_KEYS = ['summary', 'description', 'desc', 'content', 'text', 'body']
const URL_KEYS = ['url', 'link', 'jump_url', 'source_url', 'article_url', 'detail_url', 'share_url']
const TIME_KEYS = ['published_at', 'publish_time', 'created_at', 'create_time', 'updated_at', 'update_time', 'time', 'timestamp', 'ts', 'date']
const ID_KEYS = ['id', 'flash_id', 'newsflash_id', 'article_id', 'news_id', 'uuid']
const SOURCE_KEYS = ['source', 'source_name', 'platform', 'author', 'media']
const CATEGORY_KEYS = ['category', 'category_name', 'type', 'tag', 'tab_name']

function findAiCoinSkillDir() {
  const candidates = [
    resolve(process.cwd(), '..', '..', 'skills', 'aicoin-market'),
    resolve(process.cwd(), '..', 'skills', 'aicoin-market'),
    resolve(process.cwd(), 'skills', 'aicoin-market'),
  ]

  let current = process.cwd()
  for (let i = 0; i < 6; i += 1) {
    candidates.push(join(current, 'skills', 'aicoin-market'))
    const next = dirname(current)
    if (next === current) break
    current = next
  }

  return candidates.find((candidate) => existsSync(join(candidate, 'scripts', 'aicoin.mjs')))
}

function cleanText(value: unknown) {
  if (value == null) return undefined
  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || undefined
}

function getString(item: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = item[key]
    if (Array.isArray(value)) {
      const text = cleanText(value.filter(Boolean).join(' / '))
      if (text) return text
    } else {
      const text = cleanText(value)
      if (text) return text
    }
  }
  return undefined
}

function getId(item: Record<string, unknown>, fallback: string) {
  return getString(item, ID_KEYS) ?? fallback
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => item != null && typeof item === 'object' && !Array.isArray(item))
  if (!value || typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  for (const key of COLLECTION_KEYS) {
    const items = asArray(record[key])
    if (items.length > 0) return items
  }

  for (const child of Object.values(record)) {
    const items = asArray(child)
    if (items.length > 0) return items
  }

  return []
}

function asHttpUrl(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value, AICOIN_HOME)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function parseTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value
    if (value > 1e9) return value * 1000
  }

  if (typeof value === 'string') {
    if (/^\d{13}$/.test(value)) return Number(value)
    if (/^\d{10}$/.test(value)) return Number(value) * 1000
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }

  return Date.now()
}

function getTimestamp(item: Record<string, unknown>) {
  for (const key of TIME_KEYS) {
    if (item[key] != null) return parseTimestamp(item[key])
  }
  return Date.now()
}

function normalizeAiCoinError(endpoint: string, envelope: AiCoinEnvelope) {
  const code = envelope.error?.code == null ? '' : String(envelope.error.code)
  const message = envelope.error?.message || `AiCoin ${endpoint} 请求失败`
  if (code === '403') return `${endpoint}: AiCoin 返回 403，请检查 AiCoin key 是否已加载且包含新闻权限`
  if (code === '401') return `${endpoint}: AiCoin 鉴权失败，请检查 AICOIN_ACCESS_KEY_ID / AICOIN_ACCESS_SECRET`
  return `${endpoint}: ${message}`
}

function normalizeItems(data: unknown, source: string, endpoint: string): MarketNewsItem[] {
  return asArray(data)
    .map((item, index): MarketNewsItem | null => {
      const title = getString(item, TITLE_KEYS) ?? getString(item, SUMMARY_KEYS)
      if (!title) return null

      const rawSummary = getString(item, SUMMARY_KEYS)
      const summary = rawSummary && rawSummary !== title ? rawSummary.slice(0, 180) : undefined
      const publishedAt = getTimestamp(item)
      const itemSource = getString(item, SOURCE_KEYS) ?? source
      const category = getString(item, CATEGORY_KEYS)
      const url = asHttpUrl(getString(item, URL_KEYS)) ?? AICOIN_HOME
      const id = getId(item, `${endpoint}:${publishedAt}:${index}`)
      const newsItem: MarketNewsItem = {
        id: `aicoin:${endpoint}:${id}`,
        title: title.slice(0, 180),
        url,
        source: itemSource,
        publishedAt,
      }

      if (summary) newsItem.summary = summary
      if (category) newsItem.category = category

      return newsItem
    })
    .filter((item): item is MarketNewsItem => item != null)
}

async function callAiCoin({ endpoint, params, source }: AiCoinCall, skillDir: string): Promise<AiCoinResult> {
  try {
    const { stdout } = await execFile(process.execPath, ['scripts/aicoin.mjs', endpoint, JSON.stringify(params)], {
      cwd: skillDir,
      timeout: REQUEST_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 2,
      env: process.env,
    })
    const envelope = JSON.parse(stdout) as AiCoinEnvelope

    if (!envelope.ok) {
      return { endpoint, source, items: [], error: normalizeAiCoinError(endpoint, envelope) }
    }

    return { endpoint, source, items: normalizeItems(envelope.data, source, endpoint) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AiCoin 请求失败'
    return { endpoint, source, items: [], error: `${endpoint}: ${message}` }
  }
}

function uniqueNews(items: MarketNewsItem[]) {
  const seen = new Set<string>()
  const unique: MarketNewsItem[] = []

  for (const item of items) {
    const key = `${item.source}:${item.url}:${item.title}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }

  return unique
}

export async function getAiCoinMarketNews(limit = 24): Promise<MarketNewsSnapshot> {
  const skillDir = findAiCoinSkillDir()
  if (!skillDir) {
    return {
      ok: false,
      items: [],
      source: {
        name: 'AiCoin',
        status: 'offline',
        fetchedAt: Date.now(),
        errors: ['未找到 skills/aicoin-market/scripts/aicoin.mjs'],
      },
    }
  }

  const results = await Promise.all(AICOIN_CALLS.map((call) => callAiCoin(call, skillDir)))
  const errors = results.flatMap((result) => (result.error ? [result.error] : []))
  const items = uniqueNews(results.flatMap((result) => result.items))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit)
  const status = items.length === 0 ? 'offline' : errors.length > 0 ? 'partial' : 'live'

  return {
    ok: items.length > 0,
    items,
    source: {
      name: 'AiCoin',
      status,
      fetchedAt: Date.now(),
      errors,
    },
  }
}
