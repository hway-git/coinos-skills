import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const EXECUTION_RUNTIME_EVIDENCE_SCHEMA_VERSION = 'helix.freqtrade-execution-runtime/v2';
export const EXECUTION_CONFIG_IDENTITY_SCHEMA_VERSION = 'helix.freqtrade-config-identity/v1';
export const EXECUTION_PROFILE_SCHEMA_VERSION = 'helix.freqtrade-execution-profile/v1';

export const SIGNAL_ADAPTER_FILE_NAMES = Object.freeze([
  'HelixSignalStrategy.py',
  'helix_signal_artifact.py',
  'helix_signal_batch.py',
]);

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FREQTRADE_REDACTED_VALUE = 'REDACTED';
const PUBLIC_BACKTEST_API_CREDENTIALS = Object.freeze({
  username: 'helix-backtest-only',
  password: 'helix-backtest-only',
  jwtSecretKey: 'helix-backtest-only-public-jwt-secret',
});
const SECRET_FREE_DOCKER_ENV_OVERRIDES = Object.freeze({
  FREQTRADE__EXCHANGE__KEY: '',
  FREQTRADE__EXCHANGE__SECRET: '',
  FREQTRADE__EXCHANGE__PASSWORD: '',
  FREQTRADE__API_SERVER__ENABLED: 'false',
  FREQTRADE__API_SERVER__USERNAME: PUBLIC_BACKTEST_API_CREDENTIALS.username,
  FREQTRADE__API_SERVER__PASSWORD: PUBLIC_BACKTEST_API_CREDENTIALS.password,
  FREQTRADE__API_SERVER__JWT_SECRET_KEY: PUBLIC_BACKTEST_API_CREDENTIALS.jwtSecretKey,
});
const DOCKER_INHERITED_PROXY_ENV_NAMES = Object.freeze([
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
]);
const DIRECT_SECRET_ENV_PATTERN = /^(?:BINANCE|OKX|BYBIT|BITGET|GATE|HTX|KUCOIN|MEXC)_(?:API_KEY|API_SECRET|PASSWORD)$/;
const DIRECT_RUNTIME_SECRET_ENV_NAMES = new Set([
  'FREQTRADE_PASSWORD',
  'FREQTRADE_JWT_SECRET',
  'TELEGRAM_TOKEN',
  'WEBHOOK_URL',
  'DISCORD_WEBHOOK_URL',
]);

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

function hash(value, name) {
  const normalized = text(value, name);
  if (!HASH_PATTERN.test(normalized)) throw new Error(`${name} must be a SHA-256 hash`);
  return normalized;
}

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function nullableFinite(value, name) {
  return value === null ? null : finite(value, name);
}

function jsonValue(value, name) {
  if (value === undefined) return null;
  canonicalExecutionJson(value);
  return structuredClone(value);
}

function normalizedPairs(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`);
  const pairs = value.map((pair, index) => text(pair, `${name}[${index}]`)).sort();
  if (new Set(pairs).size !== pairs.length) throw new Error(`${name} must not contain duplicates`);
  return pairs;
}

export function canonicalExecutionJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical execution evidence requires finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalExecutionJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalExecutionJson(value[key])}`
    )).join(',')}}`;
  }
  throw new Error(`unsupported execution evidence value ${typeof value}`);
}

export function executionEvidenceHash(value) {
  return `sha256:${createHash('sha256').update(canonicalExecutionJson(value)).digest('hex')}`;
}

export function rawExecutionEvidenceHash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function configNumber(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

export function executionConfigIdentity(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Freqtrade config must be an object');
  }
  return {
    schemaVersion: EXECUTION_CONFIG_IDENTITY_SCHEMA_VERSION,
    exchange: String(config.exchange?.name || '').toLowerCase(),
    tradingMode: String(config.trading_mode || ''),
    marginMode: String(config.margin_mode || ''),
    maxOpenTrades: configNumber(config.max_open_trades),
    stakeCurrency: String(config.stake_currency || ''),
    stakeAmount: jsonValue(config.stake_amount, 'config.stake_amount'),
    tradableBalanceRatio: configNumber(config.tradable_balance_ratio),
    dryRun: config.dry_run === true,
    dryRunWallet: configNumber(config.dry_run_wallet),
    entryPricing: jsonValue(config.entry_pricing, 'config.entry_pricing'),
    exitPricing: jsonValue(config.exit_pricing, 'config.exit_pricing'),
    orderTypes: jsonValue(config.order_types, 'config.order_types'),
    orderTimeInForce: jsonValue(config.order_time_in_force, 'config.order_time_in_force'),
    unfilledTimeout: jsonValue(config.unfilledtimeout, 'config.unfilledtimeout'),
    positionAdjustmentEnabled: config.position_adjustment_enable === true,
    maxEntryPositionAdjustment: configNumber(config.max_entry_position_adjustment),
  };
}

function normalizeConfigIdentity(value, name = 'configIdentity') {
  const config = exactRecord(value, name, [
    'schemaVersion', 'exchange', 'tradingMode', 'marginMode', 'maxOpenTrades',
    'stakeCurrency', 'stakeAmount', 'tradableBalanceRatio', 'dryRun', 'dryRunWallet',
    'entryPricing', 'exitPricing', 'orderTypes', 'orderTimeInForce', 'unfilledTimeout',
    'positionAdjustmentEnabled', 'maxEntryPositionAdjustment',
  ]);
  if (config.schemaVersion !== EXECUTION_CONFIG_IDENTITY_SCHEMA_VERSION) {
    throw new Error(`${name}.schemaVersion is unsupported`);
  }
  if (typeof config.dryRun !== 'boolean' || typeof config.positionAdjustmentEnabled !== 'boolean') {
    throw new Error(`${name} boolean fields are invalid`);
  }
  return {
    schemaVersion: EXECUTION_CONFIG_IDENTITY_SCHEMA_VERSION,
    exchange: text(config.exchange, `${name}.exchange`),
    tradingMode: text(config.tradingMode, `${name}.tradingMode`),
    marginMode: text(config.marginMode, `${name}.marginMode`),
    maxOpenTrades: nullableFinite(config.maxOpenTrades, `${name}.maxOpenTrades`),
    stakeCurrency: text(config.stakeCurrency, `${name}.stakeCurrency`),
    stakeAmount: jsonValue(config.stakeAmount, `${name}.stakeAmount`),
    tradableBalanceRatio: nullableFinite(config.tradableBalanceRatio, `${name}.tradableBalanceRatio`),
    dryRun: config.dryRun,
    dryRunWallet: nullableFinite(config.dryRunWallet, `${name}.dryRunWallet`),
    entryPricing: jsonValue(config.entryPricing, `${name}.entryPricing`),
    exitPricing: jsonValue(config.exitPricing, `${name}.exitPricing`),
    orderTypes: jsonValue(config.orderTypes, `${name}.orderTypes`),
    orderTimeInForce: jsonValue(config.orderTimeInForce, `${name}.orderTimeInForce`),
    unfilledTimeout: jsonValue(config.unfilledTimeout, `${name}.unfilledTimeout`),
    positionAdjustmentEnabled: config.positionAdjustmentEnabled,
    maxEntryPositionAdjustment: nullableFinite(
      config.maxEntryPositionAdjustment,
      `${name}.maxEntryPositionAdjustment`,
    ),
  };
}

export function executionConfigIdentityHash(configIdentity) {
  return executionEvidenceHash(normalizeConfigIdentity(configIdentity));
}

export function signalExecutionProfile(config, { timeframe, pairs, fee }) {
  const identity = executionConfigIdentity(config);
  const normalizedFee = finite(fee, 'execution fee');
  if (normalizedFee < 0) throw new Error('execution fee must be non-negative');
  return {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    strategy: 'HelixSignalStrategy',
    timeframe: text(timeframe, 'execution timeframe'),
    pairs: normalizedPairs(pairs, 'execution pairs'),
    fee: normalizedFee,
    configHash: executionConfigIdentityHash(identity),
    ...Object.fromEntries(Object.entries(identity).filter(([field]) => field !== 'schemaVersion')),
  };
}

function normalizeExecutionProfile(value, name = 'executionProfile') {
  const profile = exactRecord(value, name, [
    'schemaVersion', 'strategy', 'timeframe', 'pairs', 'fee', 'configHash',
    'exchange', 'tradingMode', 'marginMode', 'maxOpenTrades', 'stakeCurrency',
    'stakeAmount', 'tradableBalanceRatio', 'dryRun', 'dryRunWallet', 'entryPricing',
    'exitPricing', 'orderTypes', 'orderTimeInForce', 'unfilledTimeout',
    'positionAdjustmentEnabled', 'maxEntryPositionAdjustment',
  ]);
  if (profile.schemaVersion !== EXECUTION_PROFILE_SCHEMA_VERSION
    || profile.strategy !== 'HelixSignalStrategy') {
    throw new Error(`${name} schema or strategy is unsupported`);
  }
  const configIdentity = normalizeConfigIdentity({
    schemaVersion: EXECUTION_CONFIG_IDENTITY_SCHEMA_VERSION,
    exchange: profile.exchange,
    tradingMode: profile.tradingMode,
    marginMode: profile.marginMode,
    maxOpenTrades: profile.maxOpenTrades,
    stakeCurrency: profile.stakeCurrency,
    stakeAmount: profile.stakeAmount,
    tradableBalanceRatio: profile.tradableBalanceRatio,
    dryRun: profile.dryRun,
    dryRunWallet: profile.dryRunWallet,
    entryPricing: profile.entryPricing,
    exitPricing: profile.exitPricing,
    orderTypes: profile.orderTypes,
    orderTimeInForce: profile.orderTimeInForce,
    unfilledTimeout: profile.unfilledTimeout,
    positionAdjustmentEnabled: profile.positionAdjustmentEnabled,
    maxEntryPositionAdjustment: profile.maxEntryPositionAdjustment,
  }, `${name}.config`);
  const configHash = hash(profile.configHash, `${name}.configHash`);
  if (configHash !== executionConfigIdentityHash(configIdentity)) {
    throw new Error(`${name}.configHash mismatch`);
  }
  const fee = finite(profile.fee, `${name}.fee`);
  if (fee < 0) throw new Error(`${name}.fee must be non-negative`);
  return {
    schemaVersion: EXECUTION_PROFILE_SCHEMA_VERSION,
    strategy: 'HelixSignalStrategy',
    timeframe: text(profile.timeframe, `${name}.timeframe`),
    pairs: normalizedPairs(profile.pairs, `${name}.pairs`),
    fee,
    configHash,
    ...Object.fromEntries(Object.entries(configIdentity).filter(([field]) => field !== 'schemaVersion')),
  };
}

export function executionProfileHash(profile) {
  return executionEvidenceHash(normalizeExecutionProfile(profile));
}

function safeClone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function createSecretFreeBacktestConfig(config, { timeframe, pairs, dryRunWallet = null }) {
  const identity = executionConfigIdentity(config);
  if (!identity.exchange || !identity.tradingMode || !identity.marginMode || !identity.stakeCurrency) {
    throw new Error('Freqtrade config is missing required Signal backtest execution fields');
  }
  const resolvedDryRunWallet = dryRunWallet === null
    ? identity.dryRunWallet
    : configNumber(dryRunWallet);
  if (resolvedDryRunWallet === null || resolvedDryRunWallet <= 0) {
    throw new Error('Signal backtest dry-run wallet must be positive');
  }
  if (identity.maxOpenTrades === null || identity.dryRunWallet === null) {
    throw new Error('Freqtrade config is missing max_open_trades or dry_run_wallet');
  }
  const pairList = normalizedPairs(pairs, 'backtest pairs');
  const result = {
    trading_mode: identity.tradingMode,
    timeframe: text(timeframe, 'backtest timeframe'),
    margin_mode: identity.marginMode,
    max_open_trades: identity.maxOpenTrades,
    stake_currency: identity.stakeCurrency,
    stake_amount: safeClone(identity.stakeAmount),
    // Signal risk budgets are defined from full account equity; execution
    // leverage, rather than a reduced wallet slice, limits the stake.
    tradable_balance_ratio: 1,
    dry_run: true,
    dry_run_wallet: resolvedDryRunWallet,
    entry_pricing: safeClone(identity.entryPricing),
    exit_pricing: safeClone(identity.exitPricing),
    exchange: {
      name: identity.exchange,
      key: '',
      secret: '',
      password: '',
      uid: '',
      ccxt_config: {},
      ccxt_async_config: {},
      pair_whitelist: pairList,
      pair_blacklist: [],
    },
    pairlists: [{ method: 'StaticPairList' }],
    api_server: { enabled: false },
    strategy: 'HelixSignalStrategy',
  };
  for (const [source, target] of [
    ['orderTypes', 'order_types'],
    ['orderTimeInForce', 'order_time_in_force'],
    ['unfilledTimeout', 'unfilledtimeout'],
  ]) {
    if (identity[source] !== null) result[target] = safeClone(identity[source]);
  }
  if (identity.positionAdjustmentEnabled) result.position_adjustment_enable = true;
  if (identity.maxEntryPositionAdjustment !== null) {
    result.max_entry_position_adjustment = identity.maxEntryPositionAdjustment;
  }
  return result;
}

export function secretFreeBacktestEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of Object.keys(result)) {
    if (key.startsWith('FREQTRADE__')
      || DIRECT_SECRET_ENV_PATTERN.test(key)
      || DIRECT_RUNTIME_SECRET_ENV_NAMES.has(key)) delete result[key];
  }
  return result;
}

export function secretFreeDockerEnvironmentArguments(environment = {}) {
  const argumentsList = Object.entries(SECRET_FREE_DOCKER_ENV_OVERRIDES)
    .flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  for (const name of DOCKER_INHERITED_PROXY_ENV_NAMES) {
    if (typeof environment[name] === 'string' && environment[name]) {
      argumentsList.push('-e', name);
    }
  }
  return argumentsList;
}

export function signalAdapterBundleFromDirectory(directory) {
  return signalAdapterBundle(SIGNAL_ADAPTER_FILE_NAMES.map((name) => ({
    name,
    contentBase64: readFileSync(`${directory}/${name}`).toString('base64'),
  })));
}

export function signalAdapterBundle(files) {
  if (!Array.isArray(files) || files.length !== SIGNAL_ADAPTER_FILE_NAMES.length) {
    throw new Error('adapterFiles must contain the complete Signal adapter bundle');
  }
  const byName = new Map();
  for (const [index, value] of files.entries()) {
    const file = exactRecord(value, `adapterFiles[${index}]`, ['name', 'contentBase64']);
    const name = text(file.name, `adapterFiles[${index}].name`);
    const contentBase64 = text(file.contentBase64, `adapterFiles[${index}].contentBase64`);
    if (!BASE64_PATTERN.test(contentBase64)
      || Buffer.from(contentBase64, 'base64').toString('base64') !== contentBase64) {
      throw new Error(`adapterFiles[${index}].contentBase64 is not canonical base64`);
    }
    if (byName.has(name)) throw new Error(`duplicate adapter file ${name}`);
    byName.set(name, contentBase64);
  }
  if (!isDeepStrictEqual([...byName.keys()].sort(), [...SIGNAL_ADAPTER_FILE_NAMES].sort())) {
    throw new Error('adapterFiles do not match the required Signal adapter filenames');
  }
  const normalized = SIGNAL_ADAPTER_FILE_NAMES.map((name) => ({ name, contentBase64: byName.get(name) }));
  const digest = createHash('sha256');
  for (const file of normalized) {
    digest.update(`/${file.name}\0`);
    digest.update(Buffer.from(file.contentBase64, 'base64'));
    digest.update('\0');
  }
  return { files: normalized, adapterHash: `sha256:${digest.digest('hex')}` };
}

export function createExecutionRuntimeEvidence(value) {
  const bundle = signalAdapterBundle(value.adapterFiles);
  const configIdentity = normalizeConfigIdentity(value.configIdentity);
  const executionProfile = normalizeExecutionProfile(value.executionProfile);
  const configHash = executionConfigIdentityHash(configIdentity);
  if (executionProfile.configHash !== configHash) {
    throw new Error('executionProfile does not match configIdentity');
  }
  return {
    schemaVersion: EXECUTION_RUNTIME_EVIDENCE_SCHEMA_VERSION,
    resultHash: hash(value.resultHash, 'resultHash'),
    resultMetaHash: hash(value.resultMetaHash, 'resultMetaHash'),
    datasetHash: hash(value.datasetHash, 'datasetHash'),
    executionArtifactHash: hash(value.executionArtifactHash, 'executionArtifactHash'),
    riskTraceHash: hash(value.riskTraceHash, 'riskTraceHash'),
    riskUnitRatio: (() => {
      const ratio = finite(value.riskUnitRatio, 'riskUnitRatio');
      if (ratio <= 0 || ratio > 1) throw new Error('riskUnitRatio must be in (0, 1]');
      return ratio;
    })(),
    scenarioId: text(value.scenarioId, 'scenarioId'),
    fee: finite(value.fee, 'fee'),
    freqtradeVersion: text(value.freqtradeVersion, 'freqtradeVersion'),
    configIdentity,
    configHash,
    executionProfile,
    executionProfileHash: executionProfileHash(executionProfile),
    adapterFiles: bundle.files,
    adapterHash: bundle.adapterHash,
  };
}

export function verifyExecutionRuntimeEvidence(value, expected = null) {
  const source = exactRecord(value, 'execution runtime evidence', [
    'schemaVersion', 'resultHash', 'resultMetaHash', 'datasetHash', 'executionArtifactHash',
    'riskTraceHash', 'riskUnitRatio',
    'scenarioId', 'fee', 'freqtradeVersion', 'configIdentity', 'configHash',
    'executionProfile', 'executionProfileHash', 'adapterFiles', 'adapterHash',
  ]);
  if (source.schemaVersion !== EXECUTION_RUNTIME_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(`unsupported execution runtime evidence schema ${String(source.schemaVersion)}`);
  }
  const normalized = createExecutionRuntimeEvidence(source);
  for (const [field, name] of [
    ['configHash', 'config hash'],
    ['executionProfileHash', 'execution profile hash'],
    ['adapterHash', 'adapter hash'],
  ]) {
    if (source[field] !== normalized[field]) throw new Error(`execution runtime ${name} mismatch`);
  }
  if (expected) {
    for (const field of [
      'resultHash', 'resultMetaHash', 'datasetHash', 'executionArtifactHash',
      'riskTraceHash', 'riskUnitRatio', 'scenarioId', 'fee',
    ]) {
      if (normalized[field] !== expected[field]) {
        throw new Error(`execution runtime ${field} does not match its report evidence`);
      }
    }
  }
  return normalized;
}

function nonEmptySecret(value) {
  return value !== undefined && value !== null && String(value).length > 0;
}

export function assertSecretFreeResolvedConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('archived Freqtrade config must be an object');
  }
  const api = config.api_server;
  const archivedApiCredentials = {
    username: api?.username,
    password: api?.password,
    jwtSecretKey: api?.jwt_secret_key,
  };
  if (nonEmptySecret(api?.ws_token)) {
    throw new Error('archived Freqtrade config contains forbidden secret api_server.ws_token');
  }
  if (Object.values(archivedApiCredentials).some(nonEmptySecret)) {
    if (api?.enabled !== false
      || archivedApiCredentials.username !== PUBLIC_BACKTEST_API_CREDENTIALS.username
      || ![
        PUBLIC_BACKTEST_API_CREDENTIALS.password,
        FREQTRADE_REDACTED_VALUE,
      ].includes(archivedApiCredentials.password)
      || archivedApiCredentials.jwtSecretKey !== PUBLIC_BACKTEST_API_CREDENTIALS.jwtSecretKey) {
      throw new Error('archived Freqtrade config contains forbidden API credentials');
    }
  }
  const sanitizedSecretPaths = [
    ['exchange', 'key'], ['exchange', 'secret'], ['exchange', 'password'], ['exchange', 'uid'],
    ['telegram', 'token'], ['discord', 'webhook_url'], ['webhook', 'url'],
  ];
  for (const [section, field] of sanitizedSecretPaths) {
    const value = config[section]?.[field];
    if (nonEmptySecret(value) && value !== FREQTRADE_REDACTED_VALUE) {
      throw new Error(`archived Freqtrade config contains forbidden secret ${section}.${field}`);
    }
  }
  return config;
}

function zipEntries(file) {
  try {
    return execFileSync('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
      .split('\n').map((entry) => entry.trim()).filter(Boolean);
  } catch (error) {
    throw new Error(`cannot inspect Freqtrade result ZIP ${file}: ${error.message}`);
  }
}

function uniqueZipEntry(entries, predicate, name) {
  const matches = entries.filter(predicate);
  if (matches.length !== 1) throw new Error(`Freqtrade result ZIP must contain exactly one ${name}`);
  return matches[0];
}

function readZipEntry(file, entry) {
  try {
    return execFileSync('unzip', ['-p', file, entry], { maxBuffer: 50 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`cannot read Freqtrade result ZIP entry ${entry}: ${error.message}`);
  }
}

export function verifyExecutionRuntimeArchive(runtimeValue, options) {
  const runtime = verifyExecutionRuntimeEvidence(runtimeValue, options);
  if (!options.resultFile.endsWith('.zip')) return runtime;
  const entries = zipEntries(options.resultFile);
  const configEntry = uniqueZipEntry(entries, (entry) => entry.endsWith('_config.json'), 'config entry');
  const strategyEntry = uniqueZipEntry(
    entries,
    (entry) => basename(entry).endsWith('_HelixSignalStrategy.py'),
    'HelixSignalStrategy entry',
  );
  let config;
  try {
    config = JSON.parse(readZipEntry(options.resultFile, configEntry).toString('utf8'));
  } catch (error) {
    throw new Error(`cannot parse archived Freqtrade config: ${error.message}`);
  }
  assertSecretFreeResolvedConfig(config);
  const archivedIdentity = executionConfigIdentity(config);
  if (!isDeepStrictEqual(archivedIdentity, runtime.configIdentity)) {
    throw new Error('archived Freqtrade config does not match runtime config identity');
  }
  const main = runtime.adapterFiles.find(({ name }) => name === 'HelixSignalStrategy.py');
  if (!main || !readZipEntry(options.resultFile, strategyEntry).equals(Buffer.from(main.contentBase64, 'base64'))) {
    throw new Error('archived Freqtrade strategy does not match runtime adapter evidence');
  }
  return runtime;
}
