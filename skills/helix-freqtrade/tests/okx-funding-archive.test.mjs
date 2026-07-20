import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createOkxFundingArchiveManifest,
  mergeOkxFundingRows,
  okxFundingArchiveFiles,
  okxFundingArchivePlan,
  parseOkxFundingCsv,
  rawOkxFundingArchiveHash,
} from '../lib/okx-funding-archive.mjs';

const hour = 3_600_000;
const instruments = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'XRP-USDT-SWAP'];

function archive(date) {
  return {
    filename: `allswap-fundingrates-${date}.zip`,
    url: `https://static.okx.com/cdn/okex/traderecords/swaprates/daily/${date.replaceAll('-', '')}/allswap-fundingrates-${date}.zip?v=999`,
  };
}

test('plans UTC half-open windows across OKX UTC+8 daily archives in fourteen-day requests', () => {
  const plan = okxFundingArchivePlan({
    start: '2025-07-01',
    end: '2025-07-16',
    instrument_ids: instruments,
  });
  assert.equal(plan.startTime, Date.parse('2025-07-01T00:00:00.000Z'));
  assert.equal(plan.endTime, Date.parse('2025-07-16T00:00:00.000Z'));
  assert.equal(plan.requests.length, 2);
  assert.deepEqual(plan.requests.map(({ dates }) => dates.length), [14, 2]);
  assert.equal(plan.requests[0].dates[0], '2025-07-01');
  assert.equal(plan.requests.at(-1).dates.at(-1), '2025-07-16');
  assert.equal(new Date(plan.requests[0].begin).toISOString(), '2025-06-30T16:00:00.000Z');
  assert.throws(
    () => okxFundingArchivePlan({ start: '2025-07-01', end: '2025-07-01', instrument_ids: instruments }),
    /start must precede end/,
  );
});

test('accepts only complete official daily archive indexes and restores requested order', () => {
  const request = {
    dates: ['2026-01-01', '2026-01-02'],
  };
  const response = {
    code: '0',
    data: {
      details: [{ groupDetails: [archive('2026-01-02'), archive('2026-01-01')] }],
    },
  };
  assert.deepEqual(
    okxFundingArchiveFiles(response, request).map(({ date }) => date),
    request.dates,
  );
  const incomplete = structuredClone(response);
  incomplete.data.details[0].groupDetails.pop();
  assert.throws(() => okxFundingArchiveFiles(incomplete, request), /does not cover every requested day/);
  const untrusted = structuredClone(response);
  untrusted.data.details[0].groupDetails[0].url = untrusted.data.details[0].groupDetails[0].url
    .replace('static.okx.com', 'example.com');
  assert.throws(() => okxFundingArchiveFiles(untrusted, request), /official static\.okx\.com/);
});

test('parses, merges, and renders complete official funding rows for each requested instrument', () => {
  const plan = okxFundingArchivePlan({
    start: '2026-01-01',
    end: '2026-01-03',
    instrument_ids: instruments,
  });
  const csv = (offset) => [
    'instrument_name,funding_rate,funding_time',
    ...instruments.flatMap((instrumentId, instrumentIndex) => [0, 8, 16].map((hours, rowIndex) => (
      `${instrumentId},${instrumentIndex === 2 && rowIndex === 0 ? '1.25E-7' : '0.0001'},${plan.startTime + offset + hours * hour}`
    ))),
    'ADA-USD-SWAP,not-requested,not-requested',
    '',
  ].join('\n');
  const parts = [
    parseOkxFundingCsv(csv(0), instruments, plan.startTime, plan.endTime),
    parseOkxFundingCsv(csv(24 * hour), instruments, plan.startTime, plan.endTime),
  ];
  const outputs = mergeOkxFundingRows(parts, plan);
  assert.deepEqual(outputs.map(({ rowCount }) => rowCount), [6, 6, 6]);
  assert.equal(outputs[0].relativePath, 'futures/BTC_USDT_USDT-1h-funding_rate.json');
  assert.equal(outputs[2].symbol, 'XRP/USDT:USDT');
  assert.equal(JSON.parse(outputs[0].content).length, 6);

  const gap = structuredClone(parts);
  gap[0]['BTC-USDT-SWAP'].splice(1, 1);
  assert.throws(() => mergeOkxFundingRows(gap, plan), /contain a gap for BTC-USDT-SWAP/);
});

test('hashes raw archives and creates an order-stable acquisition manifest', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-okx-funding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'archive.zip');
  await writeFile(file, 'official archive bytes');
  assert.match(rawOkxFundingArchiveHash(file), /^sha256:[a-f0-9]{64}$/);
  const plan = okxFundingArchivePlan({ start: '2026-01-01', end: '2026-01-02', instrument_ids: instruments });
  const archives = [
    { date: '2026-01-02', url: archive('2026-01-02').url, file: 'two.zip', fileHash: `sha256:${'2'.repeat(64)}`, size: 2 },
    { date: '2026-01-01', url: archive('2026-01-01').url, file: 'one.zip', fileHash: `sha256:${'1'.repeat(64)}`, size: 1 },
  ];
  const outputs = instruments.map((instrumentId, index) => ({
    instrumentId,
    symbol: `${instrumentId.split('-')[0]}/USDT:USDT`,
    file: `${index}.json`,
    dataHash: `sha256:${String(index + 3).repeat(64)}`,
    rowCount: 3,
    firstTime: plan.startTime,
    lastTime: plan.endTime - 8 * hour,
  }));
  const manifest = createOkxFundingArchiveManifest({ plan, archives, outputs });
  assert.equal(
    createOkxFundingArchiveManifest({ plan, archives: archives.reverse(), outputs: outputs.reverse() }).manifestHash,
    manifest.manifestHash,
  );
});
