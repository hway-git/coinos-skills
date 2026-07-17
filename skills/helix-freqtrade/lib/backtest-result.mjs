import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

export function readBacktestZipJson(zipFile) {
  try {
    const entries = execFileSync('unzip', ['-Z1', zipFile], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }).split('\n').map((entry) => entry.trim()).filter(Boolean);
    const expectedEntry = `${basename(zipFile, '.zip')}.json`;
    const resultEntries = entries.filter((entry) => (
      entry.endsWith('.json') && !entry.endsWith('_config.json')
    ));
    const jsonEntry = resultEntries.find((entry) => basename(entry) === expectedEntry)
      ?? (resultEntries.length === 1 ? resultEntries[0] : null);
    if (!jsonEntry) return null;
    return JSON.parse(execFileSync('unzip', ['-p', zipFile, jsonEntry], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    }));
  } catch {
    return null;
  }
}

export function readBacktestPayload(resultsDirectory, file) {
  if (file.endsWith('.json')) {
    try { return JSON.parse(readFileSync(resolve(resultsDirectory, file), 'utf8')); } catch { return null; }
  }
  if (file.endsWith('.zip')) return readBacktestZipJson(resolve(resultsDirectory, file));
  const jsonFile = resolve(resultsDirectory, `${file}.json`);
  if (existsSync(jsonFile)) {
    try { return JSON.parse(readFileSync(jsonFile, 'utf8')); } catch { return null; }
  }
  const zipFile = resolve(resultsDirectory, `${file}.zip`);
  return existsSync(zipFile) ? readBacktestZipJson(zipFile) : null;
}

export function firstStrategySummary(payload, strategy) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const strategyMap = payload.strategy && typeof payload.strategy === 'object'
    && !Array.isArray(payload.strategy) ? payload.strategy : payload;
  const summary = strategyMap[strategy];
  return summary && typeof summary === 'object' && !Array.isArray(summary) ? summary : null;
}
