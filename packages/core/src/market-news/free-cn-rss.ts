import type { MarketNewsItem, MarketNewsSnapshot } from '@helix/contracts/market'

type RssSource = {
  name: string
  url: string
}

type SourceResult = {
  source: string
  items: MarketNewsItem[]
  error?: string
}

const REQUEST_TIMEOUT_MS = 10_000
const NEWS_SOURCES: RssSource[] = [
  { name: 'TechFlow', url: 'https://api.techflowpost.com/api/client/common/rss.xml' },
  { name: 'PANews', url: 'https://www.panewslab.com/rss' },
]

const CRYPTO_KEYWORDS = [
  'btc',
  'eth',
  'bitcoin',
  'ethereum',
  'solana',
  'arbitrum',
  'optimism',
  'base',
  'polygon',
  'bnb',
  'xrp',
  'doge',
  'usdt',
  'usdc',
  'stablecoin',
  'defi',
  'cefi',
  'dex',
  'cex',
  'nft',
  'dao',
  'layer2',
  'l2',
  'web3',
  'crypto',
  'binance',
  'okx',
  'bybit',
  'coinbase',
  'kraken',
  'hyperliquid',
  '链上',
  '加密',
  '币安',
  '欧易',
  '交易所',
  '比特币',
  '以太坊',
  '稳定币',
  '代币',
  '通证',
  '山寨币',
  '永续',
  '空投',
  '质押',
  '再质押',
  '主网',
  '公链',
  '跨链',
  '钱包',
  '矿工',
  '矿企',
  '挖矿',
  '爆仓',
  '资金费率',
  '持仓量',
  '多空',
  '灰度',
  '贝莱德',
]

function unwrapCdata(value: string) {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

function decodeXmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    rsquo: '\u2019',
    lsquo: '\u2018',
    rdquo: '\u201d',
    ldquo: '\u201c',
    ndash: '\u2013',
    mdash: '\u2014',
    hellip: '\u2026',
  }

  return unwrapCdata(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => {
      const parsed = Number.parseInt(code, 16)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : ''
    })
    .replace(/&#(\d+);/g, (_, code: string) => {
      const parsed = Number.parseInt(code, 10)
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : ''
    })
    .replace(/&([a-z]+);/gi, (match, key: string) => named[key.toLowerCase()] ?? match)
}

function normalizeText(value: string) {
  return decodeXmlEntities(value).replace(/\s+/g, ' ').trim()
}

function stripHtml(value: string) {
  return normalizeText(value.replace(/<[^>]*>/g, ' '))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getTagValue(xml: string, tagName: string) {
  const tag = escapeRegExp(tagName)
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  return match ? normalizeText(match[1]) : undefined
}

function getTagAttribute(xml: string, tagName: string, attributeName: string) {
  const tag = escapeRegExp(tagName)
  const attribute = escapeRegExp(attributeName)
  const match = new RegExp(`<${tag}\\b[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`, 'i').exec(xml)
  return match ? normalizeText(match[1]) : undefined
}

function asHttpUrl(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function createNewsId(source: string, title: string, url: string, publishedAt: number, index: number) {
  const slug = (url || title).replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80)
  return `${source}:${publishedAt}:${slug}:${index}`
}

function isCryptoNews(item: MarketNewsItem) {
  const haystack = `${item.title} ${item.summary ?? ''} ${item.category ?? ''} ${item.url}`.toLowerCase()
  return CRYPTO_KEYWORDS.some((keyword) => haystack.includes(keyword.toLowerCase()))
}

function parseFeedItems(xml: string, source: string): MarketNewsItem[] {
  const entries = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? []

  return entries
    .map((entry, index): MarketNewsItem | null => {
      const title = getTagValue(entry, 'title')
      const link =
        asHttpUrl(getTagValue(entry, 'link')) ??
        asHttpUrl(getTagAttribute(entry, 'link', 'href')) ??
        asHttpUrl(getTagValue(entry, 'guid')) ??
        asHttpUrl(getTagValue(entry, 'id'))
      if (!title || !link) return null

      const rawDescription =
        getTagValue(entry, 'description') ?? getTagValue(entry, 'summary') ?? getTagValue(entry, 'content:encoded') ?? getTagValue(entry, 'content')
      const summary = rawDescription ? stripHtml(rawDescription).slice(0, 180) : undefined
      const publishedAt =
        Date.parse(getTagValue(entry, 'pubDate') ?? getTagValue(entry, 'published') ?? getTagValue(entry, 'updated') ?? '') || Date.now()
      const imageUrl =
        asHttpUrl(getTagAttribute(entry, 'media:content', 'url')) ??
        asHttpUrl(getTagAttribute(entry, 'media:thumbnail', 'url')) ??
        asHttpUrl(getTagAttribute(entry, 'enclosure', 'url'))
      const category = getTagValue(entry, 'category')
      const newsItem: MarketNewsItem = {
        id: createNewsId(source, title, link, publishedAt, index),
        title,
        url: link,
        source,
        publishedAt,
      }

      if (category) newsItem.category = category
      if (summary) newsItem.summary = summary
      if (imageUrl) newsItem.imageUrl = imageUrl

      return newsItem
    })
    .filter((item): item is MarketNewsItem => item != null)
    .filter(isCryptoNews)
}

async function fetchRssSource(source: RssSource): Promise<SourceResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(source.url, {
      cache: 'no-store',
      headers: { 'User-Agent': 'Helix Dashboard/0.1' },
      signal: controller.signal,
    })

    if (!response.ok) throw new Error(`${source.name} HTTP ${response.status}`)

    const xml = await response.text()
    return { source: source.name, items: parseFeedItems(xml, source.name) }
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? `${source.name} timeout`
        : error instanceof Error
          ? error.message
          : `${source.name} RSS fetch failed`

    return { source: source.name, items: [], error: message }
  } finally {
    clearTimeout(timeout)
  }
}

function uniqueNews(items: MarketNewsItem[]) {
  const seen = new Set<string>()
  const unique: MarketNewsItem[] = []

  for (const item of items) {
    const key = item.url || `${item.source}:${item.title}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }

  return unique
}

export async function getFreeChineseCryptoNews(limit = 24): Promise<MarketNewsSnapshot> {
  const results = await Promise.all(NEWS_SOURCES.map(fetchRssSource))
  const errors = results.flatMap((result) => (result.error ? [result.error] : []))
  const items = uniqueNews(results.flatMap((result) => result.items))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit)
  const status = items.length === 0 ? 'offline' : errors.length > 0 ? 'partial' : 'live'

  return {
    ok: items.length > 0,
    items,
    source: {
      name: NEWS_SOURCES.map((source) => source.name).join(' + '),
      status,
      fetchedAt: Date.now(),
      errors,
    },
  }
}
