import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  assertSecretFreeResolvedConfig,
  createExecutionRuntimeEvidence,
  createSecretFreeBacktestConfig,
  executionConfigIdentity,
  secretFreeBacktestEnvironment,
  secretFreeDockerEnvironmentArguments,
  signalExecutionProfile,
  verifyExecutionRuntimeArchive,
  verifyExecutionRuntimeEvidence,
} from '../lib/execution-runtime-evidence.mjs';

const sentinel = 'HELIX_SENTINEL_SECRET_DO_NOT_ARCHIVE';
const publicApiCredentials = {
  username: 'helix-backtest-only',
  password: 'helix-backtest-only',
  jwt_secret_key: 'helix-backtest-only-public-jwt-secret',
};
const hash = (character) => `sha256:${character.repeat(64)}`;
const adapterFiles = [
  { name: 'HelixSignalStrategy.py', contentBase64: Buffer.from('class HelixSignalStrategy:\n    pass\n').toString('base64') },
  { name: 'helix_signal_artifact.py', contentBase64: Buffer.from('ARTIFACT = True\n').toString('base64') },
  { name: 'helix_signal_batch.py', contentBase64: Buffer.from('BATCH = True\n').toString('base64') },
];

function liveConfig() {
  return {
    trading_mode: 'futures',
    margin_mode: 'isolated',
    max_open_trades: 2,
    stake_currency: 'USDT',
    stake_amount: 'unlimited',
    tradable_balance_ratio: 0.5,
    dry_run: true,
    dry_run_wallet: 1000,
    entry_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
    exit_pricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
    unfilledtimeout: { entry: 10, exit: 10, unit: 'minutes' },
    exchange: {
      name: 'binance',
      key: sentinel,
      secret: sentinel,
      password: sentinel,
      pair_whitelist: ['OTHER/USDT:USDT'],
    },
    api_server: { enabled: true, password: sentinel, jwt_secret_key: sentinel },
    telegram: { enabled: true, token: sentinel },
  };
}

function runtimeFixture(config) {
  const executionProfile = signalExecutionProfile(config, {
    timeframe: '1m', pairs: ['BTC/USDT:USDT'], fee: 0.001,
  });
  return createExecutionRuntimeEvidence({
    resultHash: hash('1'),
    resultMetaHash: hash('2'),
    datasetHash: hash('3'),
    executionArtifactHash: hash('4'),
    riskTraceHash: hash('5'),
    riskUnitRatio: 0.01,
    scenarioId: 'base',
    fee: 0.001,
    freqtradeVersion: 'freqtrade 2026.7',
    configIdentity: executionConfigIdentity(config),
    executionProfile,
    adapterFiles,
  });
}

test('builds a Signal backtest config and child environment without sentinel secrets', () => {
  const proxyUrl = 'http://proxy.example.test:8080';
  const sourceConfig = liveConfig();
  sourceConfig.exchange.ccxt_config = { proxies: { http: proxyUrl, https: proxyUrl } };
  sourceConfig.exchange.ccxt_async_config = { aiohttp_proxy: proxyUrl };
  const config = createSecretFreeBacktestConfig(sourceConfig, {
    timeframe: '1m', pairs: ['BTC/USDT:USDT'], dryRunWallet: 10_000,
  });
  assert.equal(config.dry_run_wallet, 10_000);
  assert.throws(
    () => createSecretFreeBacktestConfig(sourceConfig, {
      timeframe: '1m', pairs: ['BTC/USDT:USDT'], dryRunWallet: 0,
    }),
    /dry-run wallet must be positive/,
  );
  const environment = secretFreeBacktestEnvironment({
    PATH: '/bin',
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    ALL_PROXY: 'socks5://proxy.example.test:1080',
    NO_PROXY: '127.0.0.1,localhost',
    OKX_API_KEY: sentinel,
    OKX_API_SECRET: sentinel,
    OKX_PASSWORD: sentinel,
    FREQTRADE_PASSWORD: sentinel,
    FREQTRADE_JWT_SECRET: sentinel,
    FREQTRADE__EXCHANGE__KEY: sentinel,
    FREQTRADE__TELEGRAM__TOKEN: sentinel,
    FREQTRADE__WEBHOOK__URL: sentinel,
    FREQTRADE__DISCORD__WEBHOOK_URL: sentinel,
    FREQTRADE__CUSTOM__SECRET: sentinel,
    TELEGRAM_TOKEN: sentinel,
    WEBHOOK_URL: sentinel,
    DISCORD_WEBHOOK_URL: sentinel,
  });
  const dockerArguments = secretFreeDockerEnvironmentArguments(environment);

  assert.equal(JSON.stringify(config).includes(sentinel), false);
  assert.equal(JSON.stringify(config).includes(proxyUrl), false);
  assert.equal(JSON.stringify(environment).includes(sentinel), false);
  assert.equal(JSON.stringify(dockerArguments).includes(sentinel), false);
  assert.equal(dockerArguments.some((value) => value.includes('proxy.example.test')), false);
  assert.equal(dockerArguments.includes(environment.NO_PROXY), false);
  assert.equal(config.exchange.key, '');
  assert.equal(config.exchange.secret, '');
  assert.equal(config.exchange.password, '');
  assert.equal(config.api_server.enabled, false);
  assert.equal(environment.FREQTRADE__EXCHANGE__KEY, undefined);
  assert.equal(environment.FREQTRADE__API_SERVER__ENABLED, undefined);
  assert.equal(environment.FREQTRADE__TELEGRAM__TOKEN, undefined);
  assert.equal(environment.FREQTRADE__WEBHOOK__URL, undefined);
  assert.equal(environment.FREQTRADE__DISCORD__WEBHOOK_URL, undefined);
  assert.equal(environment.FREQTRADE__CUSTOM__SECRET, undefined);
  assert.equal(environment.TELEGRAM_TOKEN, undefined);
  assert.equal(environment.WEBHOOK_URL, undefined);
  assert.equal(environment.DISCORD_WEBHOOK_URL, undefined);
  assert.equal(dockerArguments.some((value) => value.startsWith('FREQTRADE__TELEGRAM__')), false);
  assert.equal(dockerArguments.some((value) => value.startsWith('FREQTRADE__WEBHOOK__')), false);
  assert.equal(dockerArguments.some((value) => value.startsWith('FREQTRADE__DISCORD__')), false);
  assert.equal(dockerArguments.includes('FREQTRADE__EXCHANGE__UID='), false);
  assert.equal(dockerArguments.includes('FREQTRADE__API_SERVER__WS_TOKEN='), false);
  assert.equal(dockerArguments.includes('FREQTRADE__API_SERVER__ENABLED=false'), true);
  assert.equal(
    dockerArguments.includes(`FREQTRADE__API_SERVER__USERNAME=${publicApiCredentials.username}`),
    true,
  );
  assert.equal(
    dockerArguments.includes(`FREQTRADE__API_SERVER__PASSWORD=${publicApiCredentials.password}`),
    true,
  );
  assert.equal(
    dockerArguments.includes(`FREQTRADE__API_SERVER__JWT_SECRET_KEY=${publicApiCredentials.jwt_secret_key}`),
    true,
  );
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    assert.equal(dockerArguments.includes(name), true);
    assert.equal(dockerArguments.some((value) => value.startsWith(`${name}=`)), false);
  }
});

test('hash-pins the complete adapter, config profile, version, and result linkage', () => {
  const config = createSecretFreeBacktestConfig(liveConfig(), {
    timeframe: '1m', pairs: ['BTC/USDT:USDT'],
  });
  const runtime = runtimeFixture(config);
  assert.deepEqual(verifyExecutionRuntimeEvidence(runtime, {
    resultHash: runtime.resultHash,
    resultMetaHash: runtime.resultMetaHash,
    datasetHash: runtime.datasetHash,
    executionArtifactHash: runtime.executionArtifactHash,
    riskTraceHash: runtime.riskTraceHash,
    riskUnitRatio: runtime.riskUnitRatio,
    scenarioId: runtime.scenarioId,
    fee: runtime.fee,
  }), runtime);

  const changedHelper = structuredClone(runtime);
  changedHelper.adapterFiles[1].contentBase64 = Buffer.from('CHANGED = True\n').toString('base64');
  assert.throws(() => verifyExecutionRuntimeEvidence(changedHelper), /adapter hash mismatch/);
  assert.throws(() => verifyExecutionRuntimeEvidence(runtime, {
    resultHash: hash('9'),
    resultMetaHash: runtime.resultMetaHash,
    datasetHash: runtime.datasetHash,
    executionArtifactHash: runtime.executionArtifactHash,
    riskTraceHash: runtime.riskTraceHash,
    riskUnitRatio: runtime.riskUnitRatio,
    scenarioId: runtime.scenarioId,
    fee: runtime.fee,
  }), /resultHash does not match/);
});

test('cross-checks a REDACTED ZIP config and rejects an embedded sentinel credential', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'helix-execution-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseConfig = createSecretFreeBacktestConfig(liveConfig(), {
    timeframe: '1m', pairs: ['BTC/USDT:USDT'],
  });
  const config = structuredClone(baseConfig);
  config.api_server = { enabled: false, ...publicApiCredentials };
  assert.deepEqual(executionConfigIdentity(config), executionConfigIdentity(baseConfig));
  assert.equal(assertSecretFreeResolvedConfig(config), config);
  const sanitizedConfig = structuredClone(config);
  Object.assign(sanitizedConfig.exchange, {
    key: 'REDACTED',
    secret: 'REDACTED',
    password: 'REDACTED',
    uid: 'REDACTED',
  });
  sanitizedConfig.api_server.password = 'REDACTED';
  sanitizedConfig.telegram = { enabled: false, token: 'REDACTED' };
  sanitizedConfig.discord = { enabled: false, webhook_url: 'REDACTED' };
  sanitizedConfig.webhook = { enabled: false, url: 'REDACTED' };
  assert.deepEqual(executionConfigIdentity(sanitizedConfig), executionConfigIdentity(baseConfig));
  assert.equal(assertSecretFreeResolvedConfig(sanitizedConfig), sanitizedConfig);
  const runtime = runtimeFixture(baseConfig);
  const resultName = 'backtest-result.json';
  const configName = 'backtest-result_config.json';
  const strategyName = 'backtest-result_HelixSignalStrategy.py';
  await writeFile(join(directory, resultName), '{}\n');
  await writeFile(join(directory, configName), `${JSON.stringify(sanitizedConfig)}\n`);
  await writeFile(
    join(directory, strategyName),
    Buffer.from(adapterFiles[0].contentBase64, 'base64'),
  );
  const zipFile = join(directory, 'backtest-result.zip');
  execFileSync('zip', ['-q', zipFile, resultName, configName, strategyName], { cwd: directory });

  assert.deepEqual(verifyExecutionRuntimeArchive(runtime, {
    resultFile: zipFile,
    resultHash: runtime.resultHash,
    resultMetaHash: runtime.resultMetaHash,
    datasetHash: runtime.datasetHash,
    executionArtifactHash: runtime.executionArtifactHash,
    riskTraceHash: runtime.riskTraceHash,
    riskUnitRatio: runtime.riskUnitRatio,
    scenarioId: runtime.scenarioId,
    fee: runtime.fee,
  }), runtime);

  for (const [field, value] of [
    ['password', sentinel],
    ['jwt_secret_key', sentinel],
    ['ws_token', sentinel],
  ]) {
    const unsafeApiConfig = structuredClone(config);
    unsafeApiConfig.api_server[field] = value;
    assert.throws(
      () => assertSecretFreeResolvedConfig(unsafeApiConfig),
      field === 'ws_token' ? /forbidden secret api_server.ws_token/ : /forbidden API credentials/,
    );
  }
  const enabledApiConfig = structuredClone(config);
  enabledApiConfig.api_server.enabled = true;
  assert.throws(
    () => assertSecretFreeResolvedConfig(enabledApiConfig),
    /forbidden API credentials/,
  );

  const unsafeConfig = structuredClone(sanitizedConfig);
  unsafeConfig.exchange.key = sentinel;
  await writeFile(join(directory, configName), `${JSON.stringify(unsafeConfig)}\n`);
  const unsafeZip = join(directory, 'unsafe.zip');
  execFileSync('zip', ['-q', unsafeZip, resultName, configName, strategyName], { cwd: directory });
  assert.throws(() => verifyExecutionRuntimeArchive(runtime, {
    resultFile: unsafeZip,
    resultHash: runtime.resultHash,
    resultMetaHash: runtime.resultMetaHash,
    datasetHash: runtime.datasetHash,
    executionArtifactHash: runtime.executionArtifactHash,
    riskTraceHash: runtime.riskTraceHash,
    riskUnitRatio: runtime.riskUnitRatio,
    scenarioId: runtime.scenarioId,
    fee: runtime.fee,
  }), /forbidden secret exchange.key/);
});
