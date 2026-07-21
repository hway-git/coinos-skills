import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const FUTURES_COST_DATASET_SCHEMA_VERSION = 'helix.futures-cost-dataset/v1';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TIMEFRAME_PATTERN = /^(\d+)([mhdw])$/;
const TIMEFRAME_UNITS_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function exactRecord(value, name, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${name} must contain exactly: ${fields.join(', ')}`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`${name} must be a non-empty trimmed string`);
  }
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function timeframe(value, name) {
  const normalized = text(value, name);
  const match = TIMEFRAME_PATTERN.exec(normalized);
  if (!match || Number(match[1]) < 1) throw new Error(`${name} is invalid`);
  const duration = Number(match[1]) * TIMEFRAME_UNITS_MS[match[2]];
  if (!Number.isSafeInteger(duration)) throw new Error(`${name} is too large`);
  return { value: normalized, duration };
}

export function canonicalFuturesCostJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical futures cost data requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalFuturesCostJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalFuturesCostJson(value[key])}`
    )).join(',')}}`;
  }
  throw new Error(`unsupported futures cost data value ${typeof value}`);
}

function source(value) {
  const parsed = exactRecord(value, 'source', ['provider', 'market', 'instrumentId', 'symbol']);
  return {
    provider: text(parsed.provider, 'source.provider'),
    market: text(parsed.market, 'source.market'),
    instrumentId: text(parsed.instrumentId, 'source.instrumentId'),
    symbol: text(parsed.symbol, 'source.symbol'),
  };
}

function markCandle(value, index, duration) {
  const name = `markPrice.candles[${index}]`;
  const parsed = exactRecord(value, name, ['time', 'open', 'high', 'low', 'close', 'volume']);
  const candle = {
    time: integer(parsed.time, `${name}.time`),
    open: finite(parsed.open, `${name}.open`),
    high: finite(parsed.high, `${name}.high`),
    low: finite(parsed.low, `${name}.low`),
    close: finite(parsed.close, `${name}.close`),
    volume: finite(parsed.volume, `${name}.volume`),
  };
  if (candle.time % duration) throw new Error(`${name}.time must align to markPrice.timeframe`);
  if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0
    || candle.high < Math.max(candle.open, candle.close)
    || candle.low > Math.min(candle.open, candle.close)) {
    throw new Error(`${name} contains incoherent mark OHLCV values`);
  }
  return candle;
}

function fundingRow(value, index, duration) {
  const name = `fundingRate.rows[${index}]`;
  const parsed = exactRecord(value, name, ['time', 'rate']);
  const row = {
    time: integer(parsed.time, `${name}.time`),
    rate: finite(parsed.rate, `${name}.rate`),
  };
  if (row.time % duration) throw new Error(`${name}.time must align to fundingRate.timeframe`);
  if (Math.abs(row.rate) > 1) throw new Error(`${name}.rate is outside [-1, 1]`);
  return row;
}

function jsonData(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  canonicalFuturesCostJson(value);
  return structuredClone(value);
}

function normalizePayload(value) {
  const dataset = exactRecord(value, 'futures cost dataset payload', [
    'schemaVersion', 'source', 'capturedThrough', 'coveredFrom', 'coveredThrough',
    'markPrice', 'fundingRate', 'leverageTiers',
  ]);
  if (dataset.schemaVersion !== FUTURES_COST_DATASET_SCHEMA_VERSION) {
    throw new Error(`unsupported futures cost dataset schema ${String(dataset.schemaVersion)}`);
  }
  const normalizedSource = source(dataset.source);
  const capturedThrough = integer(dataset.capturedThrough, 'capturedThrough');
  const coveredFrom = integer(dataset.coveredFrom, 'coveredFrom');
  const coveredThrough = integer(dataset.coveredThrough, 'coveredThrough');
  if (coveredFrom >= coveredThrough) throw new Error('coveredFrom must precede coveredThrough');
  if (capturedThrough < coveredThrough) throw new Error('capturedThrough must cover the complete cost window');

  const mark = exactRecord(dataset.markPrice, 'markPrice', ['candleType', 'timeframe', 'candles']);
  if (mark.candleType !== 'mark') throw new Error('markPrice.candleType must equal mark');
  const markTimeframe = timeframe(mark.timeframe, 'markPrice.timeframe');
  if (!Array.isArray(mark.candles) || !mark.candles.length) {
    throw new Error('markPrice.candles must be a non-empty array');
  }
  const markCandles = mark.candles.map((candle, index) => markCandle(candle, index, markTimeframe.duration));
  for (let index = 1; index < markCandles.length; index += 1) {
    if (markCandles[index].time - markCandles[index - 1].time !== markTimeframe.duration) {
      throw new Error(`markPrice.candles contains a gap before index ${index}`);
    }
  }
  if (markCandles[0].time > coveredFrom
    || markCandles.at(-1).time + markTimeframe.duration < coveredThrough) {
    throw new Error('markPrice.candles do not cover the declared cost window');
  }

  const funding = exactRecord(dataset.fundingRate, 'fundingRate', [
    'timeframe', 'maximumIntervalMs', 'rows',
  ]);
  const fundingTimeframe = timeframe(funding.timeframe, 'fundingRate.timeframe');
  const maximumIntervalMs = integer(funding.maximumIntervalMs, 'fundingRate.maximumIntervalMs');
  if (maximumIntervalMs < fundingTimeframe.duration || maximumIntervalMs % fundingTimeframe.duration) {
    throw new Error('fundingRate.maximumIntervalMs must be a timeframe-aligned positive interval');
  }
  if (!Array.isArray(funding.rows) || !funding.rows.length) {
    throw new Error('fundingRate.rows must be a non-empty array');
  }
  const fundingRows = funding.rows.map((row, index) => fundingRow(row, index, fundingTimeframe.duration));
  for (let index = 1; index < fundingRows.length; index += 1) {
    const gap = fundingRows[index].time - fundingRows[index - 1].time;
    if (gap <= 0) throw new Error(`fundingRate.rows must be strictly ordered before index ${index}`);
    if (gap > maximumIntervalMs) throw new Error(`fundingRate.rows contains a gap before index ${index}`);
  }
  if (fundingRows[0].time - coveredFrom >= maximumIntervalMs
    || coveredThrough - fundingRows.at(-1).time > maximumIntervalMs) {
    throw new Error('fundingRate.rows do not cover the declared cost window');
  }
  const markTimes = new Set(markCandles.map(({ time }) => time));
  if (fundingRows.some(({ time }) => !markTimes.has(time))) {
    throw new Error('every fundingRate timestamp must have an exact markPrice candle');
  }

  const leverage = exactRecord(dataset.leverageTiers, 'leverageTiers', ['stakeCurrency', 'data']);
  const stakeCurrency = text(leverage.stakeCurrency, 'leverageTiers.stakeCurrency');
  const leverageData = jsonData(leverage.data, 'leverageTiers.data');
  if (!Array.isArray(leverageData[normalizedSource.symbol]) || !leverageData[normalizedSource.symbol].length) {
    throw new Error(`leverageTiers.data is missing ${normalizedSource.symbol}`);
  }

  return {
    schemaVersion: FUTURES_COST_DATASET_SCHEMA_VERSION,
    source: normalizedSource,
    capturedThrough,
    coveredFrom,
    coveredThrough,
    markPrice: { candleType: 'mark', timeframe: markTimeframe.value, candles: markCandles },
    fundingRate: { timeframe: fundingTimeframe.value, maximumIntervalMs, rows: fundingRows },
    leverageTiers: { stakeCurrency, data: leverageData },
  };
}

export function futuresCostDatasetHash(payload) {
  return `sha256:${createHash('sha256').update(canonicalFuturesCostJson(normalizePayload(payload))).digest('hex')}`;
}

export function createFuturesCostDataset(payloadValue) {
  const payload = normalizePayload(payloadValue);
  return { ...payload, costDatasetHash: futuresCostDatasetHash(payload) };
}

export function verifyFuturesCostDataset(value) {
  const sourceValue = exactRecord(value, 'futures cost dataset', [
    'schemaVersion', 'source', 'capturedThrough', 'coveredFrom', 'coveredThrough',
    'markPrice', 'fundingRate', 'leverageTiers', 'costDatasetHash',
  ]);
  const costDatasetHash = text(sourceValue.costDatasetHash, 'costDatasetHash');
  if (!HASH_PATTERN.test(costDatasetHash)) throw new Error('costDatasetHash must be a SHA-256 hash');
  const payload = normalizePayload(Object.fromEntries(
    Object.entries(sourceValue).filter(([field]) => field !== 'costDatasetHash'),
  ));
  const expected = futuresCostDatasetHash(payload);
  if (costDatasetHash !== expected) throw new Error(`futures cost dataset hash mismatch: expected ${expected}`);
  return { ...payload, costDatasetHash };
}

export function loadFuturesCostDataset(file) {
  try {
    return verifyFuturesCostDataset(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    throw new Error(`cannot read futures cost dataset ${file}: ${error.message}`);
  }
}

function pairFileName(symbol) {
  return ['/', ' ', '.', '@', '$', '+', ':'].reduce(
    (filename, character) => filename.replaceAll(character, '_'),
    symbol,
  );
}

function renderedFile(relativePath, value) {
  const content = `${JSON.stringify(value)}\n`;
  return {
    relativePath,
    content,
    dataHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

function renderedCanonicalFile(relativePath, value) {
  const content = `${canonicalFuturesCostJson(value)}\n`;
  return {
    relativePath,
    content,
    dataHash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  };
}

function freqtradeFuturesCostFilesFromVerifiedDataset(dataset) {
  const pair = pairFileName(dataset.source.symbol);
  return {
    mark: renderedFile(
      `futures/${pair}-${dataset.markPrice.timeframe}-mark.json`,
      dataset.markPrice.candles.map((candle) => [
        candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume,
      ]),
    ),
    fundingRate: renderedFile(
      `futures/${pair}-${dataset.fundingRate.timeframe}-funding_rate.json`,
      dataset.fundingRate.rows.map(({ time, rate }) => [time, rate, 0, 0, 0, 0]),
    ),
    leverageTiers: renderedCanonicalFile(
      `futures/leverage_tiers_${dataset.leverageTiers.stakeCurrency}.json`,
      { data: dataset.leverageTiers.data },
    ),
  };
}

export function freqtradeFuturesCostFiles(datasetValue) {
  return freqtradeFuturesCostFilesFromVerifiedDataset(verifyFuturesCostDataset(datasetValue));
}

export function futuresCostDatasetIdentityFromVerifiedDataset(dataset) {
  const files = freqtradeFuturesCostFilesFromVerifiedDataset(dataset);
  return {
    schemaVersion: FUTURES_COST_DATASET_SCHEMA_VERSION,
    costDatasetHash: dataset.costDatasetHash,
    source: dataset.source,
    capturedThrough: dataset.capturedThrough,
    coveredFrom: dataset.coveredFrom,
    coveredThrough: dataset.coveredThrough,
    markPrice: {
      timeframe: dataset.markPrice.timeframe,
      candleCount: dataset.markPrice.candles.length,
      dataHash: files.mark.dataHash,
    },
    fundingRate: {
      timeframe: dataset.fundingRate.timeframe,
      maximumIntervalMs: dataset.fundingRate.maximumIntervalMs,
      rowCount: dataset.fundingRate.rows.length,
      dataHash: files.fundingRate.dataHash,
    },
    leverageTiers: {
      stakeCurrency: dataset.leverageTiers.stakeCurrency,
      dataHash: files.leverageTiers.dataHash,
    },
  };
}

export function futuresCostDatasetIdentity(datasetValue) {
  return futuresCostDatasetIdentityFromVerifiedDataset(verifyFuturesCostDataset(datasetValue));
}

export function requireFuturesCostDatasetWindow(datasetValue, marketDataset, artifact) {
  const dataset = verifyFuturesCostDataset(datasetValue);
  const expectedSource = marketDataset?.source;
  if (!expectedSource || canonicalFuturesCostJson(dataset.source) !== canonicalFuturesCostJson(expectedSource)) {
    throw new Error('futures cost dataset source does not match market_dataset source');
  }
  if (dataset.source.symbol !== artifact?.symbol) {
    throw new Error('futures cost dataset symbol does not match signal artifact');
  }
  const candles = marketDataset?.timeframes?.[artifact?.baseTimeframe];
  if (!Array.isArray(candles) || !candles.length) throw new Error('market_dataset base timeframe is missing');
  const baseDuration = timeframe(artifact.baseTimeframe, 'signal artifact baseTimeframe').duration;
  const requiredFrom = candles[0].time;
  const requiredThrough = candles.at(-1).time + baseDuration;
  if (dataset.coveredFrom > requiredFrom || dataset.coveredThrough < requiredThrough) {
    throw new Error('futures cost dataset does not cover the complete staged market_dataset window');
  }
  return dataset;
}

export function fundingFeesFromVerifiedDataset(summary, dataset, tolerance = 1e-8) {
  const trades = Array.isArray(summary?.trades) ? summary.trades : [];
  const markByTime = new Map(dataset.markPrice.candles.map(({ time, open }) => [time, open]));
  const rows = dataset.fundingRate.rows.map(({ time, rate }) => ({ time, rate, mark: markByTime.get(time) }));
  const observations = trades.map((trade, index) => {
    const openTime = integer(trade.open_timestamp, `trades[${index}].open_timestamp`);
    const closeTime = integer(trade.close_timestamp, `trades[${index}].close_timestamp`);
    const amount = finite(trade.amount, `trades[${index}].amount`);
    const observed = finite(trade.funding_fees, `trades[${index}].funding_fees`);
    if (typeof trade.is_short !== 'boolean') throw new Error(`trades[${index}].is_short must be boolean`);
    const settlements = rows.filter(({ time }) => time >= openTime && time <= closeTime);
    const unsigned = settlements.reduce((total, row) => total + row.rate * row.mark * amount, 0);
    const expected = unsigned === 0 ? 0 : trade.is_short ? unsigned : -unsigned;
    const allowed = Math.max(tolerance, Math.abs(expected) * tolerance);
    return {
      tradeIndex: index,
      openTime,
      closeTime,
      isShort: trade.is_short,
      amount,
      settlements: settlements.length,
      expected,
      observed,
      matches: Math.abs(observed - expected) <= allowed,
    };
  });
  return {
    status: 'OBSERVED',
    trades: observations.length,
    settlements: observations.reduce((total, observation) => total + observation.settlements, 0),
    matches: observations.every(({ matches }) => matches),
    observations,
  };
}

export function verifyFundingFees(summary, datasetValue, tolerance = 1e-8) {
  return fundingFeesFromVerifiedDataset(
    summary,
    verifyFuturesCostDataset(datasetValue),
    tolerance,
  );
}
