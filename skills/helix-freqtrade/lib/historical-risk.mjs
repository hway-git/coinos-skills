import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { verifySignalArtifact } from './signal-artifact.mjs';

export const HISTORICAL_RISK_TRACE_SCHEMA_VERSION = 'helix.historical-risk-trace/v1';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FAMILIES = new Set(['scalp', 'swing']);
const SIDES = new Set(['LONG', 'SHORT']);
const SCALP_EVENT_TYPES = new Set(['LIQUIDITY_SWEEP', 'BREAKOUT_FAILURE', 'MOMENTUM_BURST']);
const SCALP_GRADES = new Set(['A_PLUS', 'A', 'B']);
const SCALP_REGIMES = new Set([
  'TRENDING', 'RANGING', 'COMPRESSED', 'EXPANDING', 'EXHAUSTED', 'CHAOTIC',
]);
const SWING_STAGES = new Set(['EARLY', 'STANDARD', 'CONFIRMED']);
const SWING_CONTEXT_STATES = new Set([
  'BULLISH_TREND', 'BEARISH_TREND', 'RANGE', 'TRANSITION', 'UNCLEAR',
]);
const SWING_CONTEXT_BIASES = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);

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

function member(value, name, allowed) {
  const normalized = text(value, name);
  if (!allowed.has(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function positive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be finite and positive`);
  }
  return value;
}

function commonEntry(source, name) {
  const object = exactRecord(source.object, `${name}.object`, ['model', 'id']);
  const entryPriceSource = exactRecord(source.entryPrice, `${name}.entryPrice`, ['source', 'price']);
  if (entryPriceSource.source !== 'DECISION_CANDLE_CLOSE') {
    throw new Error(`${name}.entryPrice.source must be DECISION_CANDLE_CLOSE`);
  }
  const side = member(source.side, `${name}.side`, SIDES);
  const entryPrice = positive(entryPriceSource.price, `${name}.entryPrice.price`);
  const initialStop = positive(source.initialStop, `${name}.initialStop`);
  const initialTarget = positive(source.initialTarget, `${name}.initialTarget`);
  const riskDistance = positive(source.riskDistance, `${name}.riskDistance`);
  const riskR = positive(source.riskR, `${name}.riskR`);
  if (riskDistance !== Math.abs(entryPrice - initialStop)) {
    throw new Error(`${name}.riskDistance must equal the absolute entry-to-stop distance`);
  }
  if (side === 'LONG' && !(initialStop < entryPrice && entryPrice < initialTarget)) {
    throw new Error(`${name} LONG risk must have initialStop < entryPrice < initialTarget`);
  }
  if (side === 'SHORT' && !(initialTarget < entryPrice && entryPrice < initialStop)) {
    throw new Error(`${name} SHORT risk must have initialTarget < entryPrice < initialStop`);
  }
  return {
    entrySignalId: text(source.entrySignalId, `${name}.entrySignalId`),
    object: {
      model: text(object.model, `${name}.object.model`),
      id: text(object.id, `${name}.object.id`),
    },
    side,
    entryPrice: { source: 'DECISION_CANDLE_CLOSE', price: entryPrice },
    initialStop,
    initialTarget,
    riskDistance,
    riskR,
  };
}

function normalizeEntry(value, index) {
  const name = `entries[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  const family = member(value.family, `${name}.family`, FAMILIES);
  if (family === 'scalp') {
    const source = exactRecord(value, name, [
      'entrySignalId', 'family', 'object', 'side', 'entryPrice', 'initialStop', 'initialTarget',
      'riskDistance', 'riskR', 'scalp',
    ]);
    const common = commonEntry(source, name);
    if (common.object.model !== 'PRICE_EVENT') {
      throw new Error(`${name}.object.model must be PRICE_EVENT for scalp`);
    }
    const scalp = exactRecord(source.scalp, `${name}.scalp`, ['eventType', 'grade', 'regime']);
    const regime = exactRecord(scalp.regime, `${name}.scalp.regime`, ['id', 'type']);
    return {
      ...common,
      family: 'scalp',
      object: { model: 'PRICE_EVENT', id: common.object.id },
      scalp: {
        eventType: member(scalp.eventType, `${name}.scalp.eventType`, SCALP_EVENT_TYPES),
        grade: member(scalp.grade, `${name}.scalp.grade`, SCALP_GRADES),
        regime: {
          id: text(regime.id, `${name}.scalp.regime.id`),
          type: member(regime.type, `${name}.scalp.regime.type`, SCALP_REGIMES),
        },
      },
    };
  }
  const source = exactRecord(value, name, [
    'entrySignalId', 'family', 'object', 'side', 'entryPrice', 'initialStop', 'initialTarget',
    'riskDistance', 'riskR', 'swing',
  ]);
  const common = commonEntry(source, name);
  if (common.object.model !== 'TRADE_THESIS') {
    throw new Error(`${name}.object.model must be TRADE_THESIS for swing`);
  }
  const swing = exactRecord(source.swing, `${name}.swing`, ['stage', 'context']);
  const context = exactRecord(swing.context, `${name}.swing.context`, ['id', 'state', 'bias']);
  return {
    ...common,
    family: 'swing',
    object: { model: 'TRADE_THESIS', id: common.object.id },
    swing: {
      stage: member(swing.stage, `${name}.swing.stage`, SWING_STAGES),
      context: {
        id: text(context.id, `${name}.swing.context.id`),
        state: member(context.state, `${name}.swing.context.state`, SWING_CONTEXT_STATES),
        bias: member(context.bias, `${name}.swing.context.bias`, SWING_CONTEXT_BIASES),
      },
    },
  };
}

function normalizePayload(value) {
  const source = exactRecord(value, 'historical risk trace payload', [
    'schemaVersion', 'signalArtifactHash', 'entries',
  ]);
  if (source.schemaVersion !== HISTORICAL_RISK_TRACE_SCHEMA_VERSION) {
    throw new Error(`unsupported historical risk trace schema ${String(source.schemaVersion)}`);
  }
  const signalArtifactHash = text(source.signalArtifactHash, 'signalArtifactHash');
  if (!HASH_PATTERN.test(signalArtifactHash)) throw new Error('signalArtifactHash must be a SHA-256 hash');
  if (!Array.isArray(source.entries)) throw new Error('entries must be an array');
  const entries = source.entries.map(normalizeEntry);
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.entrySignalId)) {
      throw new Error(`duplicate historical risk entrySignalId ${entry.entrySignalId}`);
    }
    ids.add(entry.entrySignalId);
  }
  return {
    schemaVersion: HISTORICAL_RISK_TRACE_SCHEMA_VERSION,
    signalArtifactHash,
    entries,
  };
}

export function canonicalHistoricalRiskJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical historical risk traces require finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalHistoricalRiskJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalHistoricalRiskJson(value[key])}`
    )).join(',')}}`;
  }
  throw new Error(`unsupported canonical historical risk value ${typeof value}`);
}

export function historicalRiskTraceHash(payload) {
  const normalized = normalizePayload(payload);
  return `sha256:${createHash('sha256').update(canonicalHistoricalRiskJson(normalized)).digest('hex')}`;
}

export function verifyHistoricalRiskTrace(value, signalArtifactValue) {
  const source = exactRecord(value, 'historical risk trace', [
    'schemaVersion', 'signalArtifactHash', 'entries', 'traceHash',
  ]);
  const traceHash = text(source.traceHash, 'traceHash');
  if (!HASH_PATTERN.test(traceHash)) throw new Error('traceHash must be a SHA-256 hash');
  const payload = normalizePayload({
    schemaVersion: source.schemaVersion,
    signalArtifactHash: source.signalArtifactHash,
    entries: source.entries,
  });
  const artifact = verifySignalArtifact(signalArtifactValue);
  if (payload.signalArtifactHash !== artifact.artifactHash) {
    throw new Error('historical risk trace signalArtifactHash does not match the signal artifact');
  }
  const enters = artifact.signals.filter(({ action }) => action === 'ENTER');
  if (payload.entries.length !== enters.length) {
    throw new Error('historical risk trace must contain exactly one entry for every signal artifact ENTER');
  }
  const expectedFamily = artifact.objectModel === 'PRICE_EVENT' ? 'scalp' : 'swing';
  for (const [index, entry] of payload.entries.entries()) {
    const signal = enters[index];
    if (entry.entrySignalId !== signal.signalId) {
      if (!enters.some(({ signalId }) => signalId === entry.entrySignalId)) {
        throw new Error(`historical risk entry ${entry.entrySignalId} does not link to an artifact ENTER`);
      }
      throw new Error('historical risk entries must follow signal artifact ENTER order');
    }
    if (entry.family !== expectedFamily || entry.object.model !== artifact.objectModel) {
      throw new Error(`historical risk entry ${entry.entrySignalId} family/model does not match the signal artifact`);
    }
    if (entry.object.id !== signal.object.id || entry.side !== signal.side) {
      throw new Error(`historical risk entry ${entry.entrySignalId} does not match its artifact ENTER`);
    }
  }
  const expectedHash = historicalRiskTraceHash(payload);
  if (traceHash !== expectedHash) {
    throw new Error(`historical risk trace hash mismatch: expected ${expectedHash}`);
  }
  return { ...payload, traceHash };
}

export function loadHistoricalRiskTrace(file, signalArtifact) {
  try {
    return verifyHistoricalRiskTrace(JSON.parse(readFileSync(file, 'utf8')), signalArtifact);
  } catch (error) {
    throw new Error(`cannot read historical risk trace ${file}: ${error.message}`);
  }
}
