import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { canonicalFuturesCostJson } from './futures-cost-dataset.mjs';

export const OKX_FUNDING_ARCHIVE_SCHEMA_VERSION = 'helix.okx-funding-archive/v1';
export const OKX_FUNDING_ARCHIVE_ENDPOINT = 'https://www.okx.com/priapi/v5/broker/public/trade-data/download-link';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const OKX_ARCHIVE_OFFSET_MS = 8 * HOUR_MS;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTRUMENT_PATTERN = /^([A-Z0-9]+)-USDT-SWAP$/;
const ARCHIVE_PATH_PATTERN = /^\/cdn\/okex\/traderecords\/swaprates\/daily\/(\d{8})\/allswap-fundingrates-(\d{4}-\d{2}-\d{2})\.zip$/;

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function utcDate(value, name) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error(`${name} must be a UTC date in YYYY-MM-DD format`);
  }
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(time) || new Date(time).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} is not a valid UTC date`);
  }
  return time;
}

function instrumentIds(value) {
  if (!Array.isArray(value) || !value.length) {
    throw new Error('instrument_ids must be a non-empty array');
  }
  const normalized = value.map((item, index) => {
    if (typeof item !== 'string' || !INSTRUMENT_PATTERN.test(item)) {
      throw new Error(`instrument_ids[${index}] must be a linear USDT swap instrument id`);
    }
    return item;
  }).sort();
  if (new Set(normalized).size !== normalized.length) throw new Error('instrument_ids must be unique');
  return normalized;
}

function archiveDayStart(time) {
  return Math.floor((time + OKX_ARCHIVE_OFFSET_MS) / DAY_MS) * DAY_MS - OKX_ARCHIVE_OFFSET_MS;
}

function archiveDate(dayStart) {
  return new Date(dayStart + OKX_ARCHIVE_OFFSET_MS).toISOString().slice(0, 10);
}

export function okxFundingArchivePlan({ start, end, instrument_ids: requestedInstruments }) {
  const startTime = utcDate(start, 'start');
  const endTime = utcDate(end, 'end');
  if (startTime >= endTime) throw new Error('start must precede end');
  const instruments = instrumentIds(requestedInstruments);
  const firstDay = archiveDayStart(startTime);
  const lastDay = archiveDayStart(endTime - 1);
  const days = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    days.push({ date: archiveDate(day), dayStart: day });
  }
  const requests = [];
  for (let index = 0; index < days.length; index += 14) {
    const batch = days.slice(index, index + 14);
    requests.push({
      begin: batch[0].dayStart,
      end: batch.at(-1).dayStart + DAY_MS - 1,
      dates: batch.map(({ date }) => date),
    });
  }
  return { start, end, startTime, endTime, instruments, requests };
}

function archiveDescriptor(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  if (typeof value.url !== 'string' || typeof value.filename !== 'string') {
    throw new Error(`${name} must contain url and filename`);
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(`${name}.url is invalid`);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'static.okx.com') {
    throw new Error(`${name}.url must use the official static.okx.com archive host`);
  }
  const match = ARCHIVE_PATH_PATTERN.exec(url.pathname);
  if (!match || match[1] !== match[2].replaceAll('-', '') || value.filename !== url.pathname.split('/').at(-1)) {
    throw new Error(`${name} is not an OKX daily funding archive`);
  }
  return { date: match[2], filename: value.filename, url: url.toString() };
}

export function okxFundingArchiveFiles(response, request) {
  if (!response || typeof response !== 'object' || response.code !== '0' || !response.data) {
    throw new Error(`OKX funding archive request failed: ${String(response?.msg || response?.code || 'invalid response')}`);
  }
  const details = response.data.details;
  if (!Array.isArray(details)) throw new Error('OKX funding archive response has no details array');
  const descriptors = details.flatMap((detail, detailIndex) => {
    if (!Array.isArray(detail?.groupDetails)) {
      throw new Error(`OKX funding archive details[${detailIndex}] has no groupDetails array`);
    }
    return detail.groupDetails.map((item, itemIndex) => (
      archiveDescriptor(item, `details[${detailIndex}].groupDetails[${itemIndex}]`)
    ));
  });
  const byDate = new Map();
  for (const descriptor of descriptors) {
    if (byDate.has(descriptor.date)) throw new Error(`duplicate OKX funding archive date ${descriptor.date}`);
    byDate.set(descriptor.date, descriptor);
  }
  if (request.dates.some((date) => !byDate.has(date)) || byDate.size !== request.dates.length) {
    throw new Error('OKX funding archive response does not cover every requested day');
  }
  return request.dates.map((date) => byDate.get(date));
}

export function parseOkxFundingCsv(value, requestedInstruments, startTime, endTime) {
  if (typeof value !== 'string') throw new Error('OKX funding CSV must be text');
  const instruments = instrumentIds(requestedInstruments);
  const wanted = new Set(instruments);
  const rows = Object.fromEntries(instruments.map((instrumentId) => [instrumentId, []]));
  const lines = value.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== 'instrument_name,funding_rate,funding_time') {
    throw new Error('OKX funding CSV header is invalid');
  }
  for (const [index, line] of lines.entries()) {
    if (!line) throw new Error(`OKX funding CSV row ${index + 2} is empty`);
    const fields = line.split(',');
    if (fields.length !== 3) throw new Error(`OKX funding CSV row ${index + 2} must contain three fields`);
    const [instrumentId, rateValue, timeValue] = fields;
    if (!instrumentId || instrumentId !== instrumentId.trim()) {
      throw new Error(`OKX funding CSV row ${index + 2} has an invalid instrument id`);
    }
    if (!wanted.has(instrumentId)) continue;
    const rate = Number(rateValue);
    const time = Number(timeValue);
    if (!Number.isFinite(rate) || Math.abs(rate) > 1 || !Number.isSafeInteger(time) || time % HOUR_MS) {
      throw new Error(`OKX funding CSV row ${index + 2} has invalid rate or time`);
    }
    if (time >= startTime && time < endTime) {
      rows[instrumentId].push({ time, rate });
    }
  }
  return rows;
}

export function readOkxFundingArchive(file, requestedInstruments, startTime, endTime) {
  let entries;
  try {
    entries = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
      .trim().split('\n').filter(Boolean);
  } catch (error) {
    throw new Error(`cannot list OKX funding archive ${file}: ${error.message}`);
  }
  if (entries.length !== 1 || !/^allswap-fundingrates-\d{4}-\d{2}-\d{2}\.csv$/.test(entries[0])) {
    throw new Error(`OKX funding archive ${file} must contain one daily funding CSV`);
  }
  let content;
  try {
    content = execFileSync('unzip', ['-p', file, entries[0]], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`cannot read OKX funding archive ${file}: ${error.message}`);
  }
  return parseOkxFundingCsv(content, requestedInstruments, startTime, endTime);
}

export function mergeOkxFundingRows(parts, plan, maximumIntervalMs = 8 * HOUR_MS) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('OKX funding archive parts are required');
  const merged = Object.fromEntries(plan.instruments.map((instrumentId) => [instrumentId, new Map()]));
  for (const [partIndex, part] of parts.entries()) {
    for (const instrumentId of plan.instruments) {
      if (!Array.isArray(part?.[instrumentId])) {
        throw new Error(`OKX funding archive part ${partIndex} is missing ${instrumentId}`);
      }
      for (const row of part[instrumentId]) {
        if (merged[instrumentId].has(row.time)) {
          throw new Error(`duplicate OKX funding row ${instrumentId} at ${row.time}`);
        }
        merged[instrumentId].set(row.time, row.rate);
      }
    }
  }
  return plan.instruments.map((instrumentId) => {
    const rows = [...merged[instrumentId]].map(([time, rate]) => ({ time, rate }))
      .sort((left, right) => left.time - right.time);
    if (!rows.length
      || rows[0].time - plan.startTime >= maximumIntervalMs
      || plan.endTime - rows.at(-1).time > maximumIntervalMs) {
      throw new Error(`OKX funding rows do not cover ${instrumentId} window`);
    }
    for (let index = 1; index < rows.length; index += 1) {
      if (rows[index].time - rows[index - 1].time > maximumIntervalMs) {
        throw new Error(`OKX funding rows contain a gap for ${instrumentId} before ${rows[index].time}`);
      }
    }
    const base = INSTRUMENT_PATTERN.exec(instrumentId)[1];
    const symbol = `${base}/USDT:USDT`;
    const content = `${JSON.stringify(rows.map(({ time, rate }) => [time, rate, 0, 0, 0, 0]))}\n`;
    return {
      instrumentId,
      symbol,
      relativePath: `futures/${base}_USDT_USDT-1h-funding_rate.json`,
      rowCount: rows.length,
      firstTime: rows[0].time,
      lastTime: rows.at(-1).time,
      dataHash: sha256(content),
      content,
    };
  });
}

export function createOkxFundingArchiveManifest({ plan, archives, outputs }) {
  const payload = {
    schemaVersion: OKX_FUNDING_ARCHIVE_SCHEMA_VERSION,
    endpoint: OKX_FUNDING_ARCHIVE_ENDPOINT,
    start: plan.start,
    end: plan.end,
    startTime: plan.startTime,
    endTime: plan.endTime,
    instruments: plan.instruments,
    archives: [...archives].sort((left, right) => left.date.localeCompare(right.date)).map((archive) => ({
      date: archive.date,
      url: archive.url,
      file: archive.file,
      fileHash: archive.fileHash,
      size: archive.size,
    })),
    outputs: [...outputs].sort((left, right) => left.instrumentId.localeCompare(right.instrumentId)).map((output) => ({
      instrumentId: output.instrumentId,
      symbol: output.symbol,
      file: output.file,
      dataHash: output.dataHash,
      rowCount: output.rowCount,
      firstTime: output.firstTime,
      lastTime: output.lastTime,
    })),
  };
  return {
    ...payload,
    manifestHash: sha256(canonicalFuturesCostJson(payload)),
  };
}

export function rawOkxFundingArchiveHash(file) {
  return sha256(readFileSync(file));
}
