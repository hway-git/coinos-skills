import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  freqtradeFuturesCostFiles,
  createFuturesCostDataset,
  futuresCostDatasetHash,
  futuresCostDatasetIdentity,
  verifyFundingFees,
  verifyFuturesCostDataset,
} from '../lib/futures-cost-dataset.mjs';
import { marketDatasetHash } from '../lib/market-dataset.mjs';
import { futuresCostDatasetFixture } from './helpers/futures-cost-dataset.mjs';

const hour = 3_600_000;
const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = resolve(SKILL_DIR, 'scripts', 'ft-deploy.mjs');

test('hash-pins complete mark, funding, and timestamp-free leverage tier data', () => {
  const dataset = futuresCostDatasetFixture({ coveredThrough: 16 * hour });
  assert.deepEqual(verifyFuturesCostDataset(dataset), dataset);
  const files = freqtradeFuturesCostFiles(dataset);
  assert.equal(files.leverageTiers.content.includes('updated'), false);
  assert.equal(files.mark.relativePath, 'futures/BTC_USDT_USDT-1h-mark.json');
  assert.equal(files.fundingRate.relativePath, 'futures/BTC_USDT_USDT-1h-funding_rate.json');
  assert.equal(futuresCostDatasetIdentity(dataset).leverageTiers.dataHash, files.leverageTiers.dataHash);
  const reorderedPayload = structuredClone(dataset);
  reorderedPayload.leverageTiers.data = Object.fromEntries(
    Object.entries(reorderedPayload.leverageTiers.data).reverse(),
  );
  delete reorderedPayload.costDatasetHash;
  const reordered = createFuturesCostDataset(reorderedPayload);
  assert.equal(reordered.costDatasetHash, dataset.costDatasetHash);
  assert.equal(
    futuresCostDatasetIdentity(reordered).leverageTiers.dataHash,
    futuresCostDatasetIdentity(dataset).leverageTiers.dataHash,
  );

  const changed = structuredClone(dataset);
  changed.leverageTiers.data['BTC/USDT:USDT'][0].maxLeverage = 10;
  assert.throws(() => verifyFuturesCostDataset(changed), /hash mismatch/);
});

test('rejects missing funding coverage, internal gaps, and missing exact mark candles', () => {
  const dataset = futuresCostDatasetFixture({ coveredThrough: 24 * hour });
  const truncated = structuredClone(dataset);
  truncated.fundingRate.rows = truncated.fundingRate.rows.slice(1);
  const { costDatasetHash: _truncatedHash, ...truncatedPayload } = truncated;
  assert.throws(() => futuresCostDatasetHash(truncatedPayload), /do not cover/);

  const gap = structuredClone(dataset);
  gap.fundingRate.rows.splice(1, 1);
  const { costDatasetHash: _gapHash, ...gapPayload } = gap;
  assert.throws(() => futuresCostDatasetHash(gapPayload), /contains a gap/);

  const missingMark = structuredClone(dataset);
  missingMark.markPrice.candles = missingMark.markPrice.candles.filter(({ time }) => time !== 8 * hour);
  const { costDatasetHash: _markHash, ...markPayload } = missingMark;
  assert.throws(() => futuresCostDatasetHash(markPayload), /markPrice.candles contains a gap/);
});

test('reconciles non-zero long and short funding and accepts a proven no-settlement zero', () => {
  const dataset = futuresCostDatasetFixture({ coveredThrough: 16 * hour, fundingRate: 0.001 });
  const shortFee = 0.001 * 100 * 2;
  const longFee = -shortFee;
  const summary = {
    trades: [
      {
        open_timestamp: 7 * hour,
        close_timestamp: 9 * hour,
        amount: 2,
        is_short: true,
        funding_fees: shortFee,
      },
      {
        open_timestamp: 7 * hour,
        close_timestamp: 9 * hour,
        amount: 2,
        is_short: false,
        funding_fees: longFee,
      },
      {
        open_timestamp: hour,
        close_timestamp: 2 * hour,
        amount: 2,
        is_short: false,
        funding_fees: 0,
      },
    ],
  };
  const result = verifyFundingFees(summary, dataset);
  assert.equal(result.matches, true);
  assert.deepEqual(result.observations.map(({ settlements }) => settlements), [1, 1, 0]);

  const tampered = structuredClone(summary);
  tampered.trades[0].funding_fees = 0;
  assert.equal(verifyFundingFees(tampered, dataset).matches, false);
});

test('freezes complete Freqtrade JSON inputs into one immutable cost dataset', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-freeze-futures-cost-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sourcePayload = {
    schemaVersion: 'helix.market-dataset/v1',
    source: {
      provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT',
    },
    capturedThrough: 16 * hour,
    timeframes: {
      '1h': Array.from({ length: 16 }, (_, index) => ({
        time: index * hour, open: 100, high: 101, low: 99, close: 100, volume: 1,
      })),
    },
  };
  const source = { ...sourcePayload, datasetHash: marketDatasetHash(sourcePayload) };
  const sourceFile = join(home, 'source.json');
  const dataDirectory = join(home, 'data');
  const futuresDirectory = join(dataDirectory, 'futures');
  const outputFile = join(home, 'cost.json');
  await mkdir(futuresDirectory, { recursive: true });
  await writeFile(sourceFile, JSON.stringify(source));
  await writeFile(
    join(futuresDirectory, 'BTC_USDT_USDT-1h-mark.json'),
    JSON.stringify(Array.from({ length: 16 }, (_, index) => [
      index * hour, 100, 101, 99, 100, null,
    ])),
  );
  await writeFile(
    join(futuresDirectory, 'BTC_USDT_USDT-1h-funding_rate.json'),
    JSON.stringify([[0, 0.001, 0, 0, 0, 0], [8 * hour, -0.001, 0, 0, 0, 0]]),
  );
  await writeFile(
    join(futuresDirectory, 'leverage_tiers_USDT.json'),
    JSON.stringify({ updated: 'volatile', data: futuresCostDatasetFixture().leverageTiers.data }),
  );
  const { stdout } = await execFileAsync(process.execPath, [
    DEPLOY,
    'freeze_futures_cost_dataset',
    JSON.stringify({
      source_dataset: sourceFile,
      data_directory: dataDirectory,
      output_file: outputFile,
    }),
  ], { cwd: SKILL_DIR, env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' } });
  const result = JSON.parse(stdout);
  const frozen = verifyFuturesCostDataset(JSON.parse(await readFile(outputFile, 'utf8')));
  assert.equal(result.costDatasetHash, frozen.costDatasetHash);
  assert.equal(frozen.markPrice.candles.every(({ volume }) => volume === 0), true);
  assert.equal(JSON.stringify(frozen.leverageTiers).includes('updated'), false);

  await writeFile(
    join(futuresDirectory, 'BTC_USDT_USDT-1h-funding_rate.json'),
    JSON.stringify([[0, 0.001, 0, 0, 0, 0], [8 * hour, 'invalid', 0, 0, 0, 0]]),
  );
  await assert.rejects(execFileAsync(process.execPath, [
    DEPLOY,
    'freeze_futures_cost_dataset',
    JSON.stringify({
      source_dataset: sourceFile,
      data_directory: dataDirectory,
      output_file: join(home, 'invalid-cost.json'),
    }),
  ], { cwd: SKILL_DIR, env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' } }), (error) => {
    assert.match(error.stderr, /funding rate row 1 contains invalid numeric values/);
    return true;
  });
});
