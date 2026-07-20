import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  futuresCostDatasetHash,
  futuresCostDatasetIdentity,
} from '../../lib/futures-cost-dataset.mjs';

const hour = 3_600_000;
const tierSymbols = ['BTC/USDT:USDT', 'ETH/USDT:USDT', 'XRP/USDT:USDT'];

export function futuresCostDatasetFixture({
  source = {
    provider: 'okx',
    market: 'futures',
    instrumentId: 'BTC-USDT-SWAP',
    symbol: 'BTC/USDT:USDT',
  },
  coveredFrom = 0,
  coveredThrough = 4 * hour,
  fundingRate = 0,
  maxLeverage = 20,
  leverageData = null,
} = {}) {
  const firstMark = Math.floor(coveredFrom / hour) * hour;
  const lastMark = Math.ceil(coveredThrough / hour) * hour;
  const candles = [];
  for (let time = firstMark; time < lastMark; time += hour) {
    candles.push({ time, open: 100, high: 101, low: 99, close: 100, volume: 0 });
  }
  const rows = [];
  for (let time = firstMark; time < coveredThrough; time += 8 * hour) {
    rows.push({ time, rate: fundingRate });
  }
  if (!rows.length) rows.push({ time: firstMark, rate: fundingRate });
  const resolvedLeverageData = leverageData ?? Object.fromEntries(tierSymbols.map((symbol) => [symbol, [{
    tier: 1,
    symbol,
    currency: 'USDT',
    minNotional: 0,
    maxNotional: 1_000_000,
    maintenanceMarginRate: 0.01,
    maxLeverage,
    info: {},
  }]]));
  const payload = {
    schemaVersion: 'helix.futures-cost-dataset/v1',
    source,
    capturedThrough: coveredThrough,
    coveredFrom,
    coveredThrough,
    markPrice: { candleType: 'mark', timeframe: '1h', candles },
    fundingRate: { timeframe: '1h', maximumIntervalMs: 8 * hour, rows },
    leverageTiers: { stakeCurrency: 'USDT', data: resolvedLeverageData },
  };
  return { ...payload, costDatasetHash: futuresCostDatasetHash(payload) };
}

export function futuresCostIdentityFixture(options) {
  return futuresCostDatasetIdentity(futuresCostDatasetFixture(options));
}

export async function writeFuturesCostDatasetFixture(directory, options) {
  const dataset = futuresCostDatasetFixture(options);
  const content = `${JSON.stringify(dataset, null, 2)}\n`;
  const fileHash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const file = join(directory, `${dataset.costDatasetHash.replace(':', '-')}.futures-cost.json`);
  await writeFile(file, content);
  return { dataset, identity: futuresCostDatasetIdentity(dataset), file, fileHash };
}
