#!/usr/bin/env node
// Hyperliquid Data CLI - Part 1: ticker, whale, liquidation, OI, taker
import { apiGet, apiPost, cli } from '../lib/aicoin-api.mjs';

cli({
  // P2 #4: tickers 返回里混 "@241" "@248" 这种 HL 内部 spot token id, 跟正常 "BTC" / "ETH" 一起列。
  // agent 不知道 @xxx 是啥, 加 _field_doc 解释。
  tickers: async () => {
    const json = await apiGet('/api/upgrade/v2/hl/tickers');
    if (json && typeof json === 'object') {
      json._field_doc = `coin 字段格式: (1) 大写字母 (BTC/ETH/SOL/HYPE 等) = HL 永续合约的标准命名; (2) "@<数字>" (@241 / @248 等) = HL 现货 spot 的内部 token id, 不是永续, 命名是数字 ID 因为 HL 现货上市的代币太多。完整 spot 映射查 HL 官方 spot metadata。**永续看 BTC/ETH 等大写, 现货走 @xxx**, 别混。`;
    }
    return json;
  },
  ticker: ({ coin }) => apiGet(`/api/upgrade/v2/hl/tickers/coin/${coin}`),
  whale_positions: ({ coin, dir, npnlSide, frSide, topBy, take } = {}) => {
    const p = {};
    if (coin) p.coin = coin; if (dir) p.dir = dir;
    if (npnlSide) p.npnlSide = npnlSide; if (frSide) p.frSide = frSide;
    if (topBy) p.topBy = topBy; if (take) p.take = take;
    return apiGet('/api/upgrade/v2/hl/whales/open-positions', p);
  },
  whale_events: async ({ coin, limit } = {}) => {
    const p = {}; if (coin) p.coin = coin; if (limit) p.limit = limit;
    const json = await apiGet('/api/upgrade/v2/hl/whales/latest-events', p);
    // 实测: 上游 coin 参数过滤不严, 传 BTC 仍可能混入 SOL/其他币的鲸鱼事件。
    // 本地按 coin 严格过滤一次, 保证 agent 拿到的就是请求的币种。
    if (coin && Array.isArray(json?.data)) {
      const before = json.data.length;
      json.data = json.data.filter(ev => String(ev?.coin || '').toUpperCase() === String(coin).toUpperCase());
      if (json.data.length !== before) {
        json._note = `whale_events 上游 coin 参数过滤不严, 本地已剔除 ${before - json.data.length} 条非 ${coin} 事件 (原返 ${before} 条 → 过滤后 ${json.data.length} 条)。`;
      }
    }
    return json;
  },
  whale_directions: ({ coin } = {}) => {
    const p = {}; if (coin) p.coin = coin;
    return apiGet('/api/upgrade/v2/hl/whales/directions', p);
  },
  whale_history_ratio: ({ interval, limit } = {}) => {
    const p = {}; if (interval) p.interval = interval; if (limit) p.limit = limit;
    return apiGet('/api/upgrade/v2/hl/whales/history-long-ratio', p);
  },
  liq_history: ({ coin, interval, limit } = {}) => {
    const p = {}; if (coin) p.coin = coin; if (interval) p.interval = interval; if (limit) p.limit = limit;
    return apiGet('/api/upgrade/v2/hl/liquidations/history', p);
  },
  liq_stats: ({ coin, interval } = {}) => {
    const p = {}; if (coin) p.coin = coin; if (interval) p.interval = interval;
    return apiGet('/api/upgrade/v2/hl/liquidations/stat', p);
  },
  liq_stats_by_coin: ({ interval } = {}) => {
    const p = {}; if (interval) p.interval = interval;
    return apiGet('/api/upgrade/v2/hl/liquidations/stat-by-coin', p);
  },
  liq_top_positions: ({ coin, interval, limit } = {}) => {
    // 实测: interval 必填, 不传 400。默认 1h (滚动窗口分析最常用粒度)。
    const p = { coin, interval: interval || '1h' }; if (limit) p.limit = limit;
    return apiGet('/api/upgrade/v2/hl/liquidations/top-positions', p);
  },
  oi_summary: () => apiGet('/api/upgrade/v2/hl/open-interest/summary'),
  oi_top_coins: ({ limit, interval } = {}) => {
    const p = {}; if (limit) p.limit = limit; if (interval) p.interval = interval;
    return apiGet('/api/upgrade/v2/hl/open-interest/top-coins', p);
  },
  oi_history: ({ coin, interval }) => {
    const p = {}; if (interval) p.interval = interval;
    return apiGet(`/api/upgrade/v2/hl/open-interest/history/${coin}`, p);
  },
  taker_delta: ({ coin, interval } = {}) => {
    // 实测: interval 必填。默认 1h (跟 taker_klines/liq_top_positions 对齐)。
    const p = { interval: interval || '1h' };
    return apiGet(`/api/upgrade/v2/hl/accumulated-taker-delta/${coin}`, p);
  },
  taker_klines: ({ coin, interval = '4h', startTime, endTime, limit } = {}) => {
    const p = {}; if (startTime) p.startTime = startTime; if (endTime) p.endTime = endTime; if (limit) p.limit = limit;
    return apiGet(`/api/upgrade/v2/hl/klines-with-taker-vol/${coin}/${interval}`, p);
  },
  orderbook_history: ({ coin, interval } = {}) => {
    const p = {}; if (interval) p.interval = interval;
    return apiGet(`/api/upgrade/v2/hl/orderbooks/history-summaries/${coin}`, p);
  },
});
