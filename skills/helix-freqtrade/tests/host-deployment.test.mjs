import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { signalArtifactHash } from '../lib/signal-artifact.mjs';
import { createPromotableWalkForwardReport } from './helpers/promotable-report.mjs';

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = resolve(SKILL_DIR, 'scripts', 'ft-deploy.mjs');

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function artifactFixture() {
  const first = 1_782_864_000_000;
  const minute = 60_000;
  const payload = {
    schemaVersion: 'helix.signal-artifact/v1',
    identity: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.1',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: `sha256:${'d'.repeat(64)}`,
    },
    strategyLifecycle: 'shadow',
    objectModel: 'PRICE_EVENT',
    symbol: 'BTC/USDT:USDT',
    baseTimeframe: '1m',
    marketData: { firstCandleOpenTime: first, lastCandleCloseTime: first + 3 * minute },
    signals: [
      {
        sequence: 0,
        signalId: 'host-enter-001',
        decisionId: 'host-decision-001',
        object: { model: 'PRICE_EVENT', id: 'host-event-001' },
        action: 'ENTER',
        side: 'LONG',
        sourceCandleOpenTime: first,
        decisionTime: first + minute,
        reasonCodes: ['EXECUTION_TRIGGERED'],
      },
      {
        sequence: 1,
        signalId: 'host-exit-001',
        decisionId: 'host-decision-002',
        object: { model: 'PRICE_EVENT', id: 'host-event-001' },
        action: 'EXIT',
        side: 'LONG',
        sourceCandleOpenTime: first + 2 * minute,
        decisionTime: first + 3 * minute,
        reasonCodes: ['TIME_STOP'],
      },
    ],
  };
  return { ...payload, artifactHash: signalArtifactHash(payload) };
}

async function adapterFingerprint() {
  const hash = createHash('sha256');
  for (const name of ['HelixSignalStrategy.py', 'helix_signal_artifact.py', 'helix_signal_batch.py']) {
    hash.update(`/${name}\0`);
    hash.update(await readFile(resolve(SKILL_DIR, 'assets', name)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function randomLoopbackPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  return address.port;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function terminateDetachedPid(pidFile) {
  let pid = null;
  try {
    pid = Number((await readFile(pidFile, 'utf8')).trim());
  } catch {}
  if (!processIsAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let attempt = 0; attempt < 40 && processIsAlive(pid); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (processIsAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function terminateForwardWorkers(userData) {
  let roots = [];
  try {
    roots = await readdir(join(userData, 'helix', 'forward'), { withFileTypes: true });
  } catch {}
  for (const root of roots) {
    if (!root.isDirectory()) continue;
    let pid = null;
    try {
      pid = JSON.parse(await readFile(join(userData, 'helix', 'forward', root.name, 'worker.pid'), 'utf8')).pid;
    } catch {}
    if (!processIsAlive(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

const FAKE_FREQTRADE = `#!/usr/bin/env node
const { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:http');

const args = process.argv.slice(2);
if (args[0] !== 'trade') {
  if (args[0] === '--version') console.log('freqtrade test');
  process.exit(0);
}

function argument(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

if (process.env.HELIX_TEST_HOST_FAIL_START === '1' && argument('--strategy') === 'TestStrategy') process.exit(42);
if (process.env.HELIX_TEST_HOST_FAIL_NEXT_START && existsSync(process.env.HELIX_TEST_HOST_FAIL_NEXT_START)) {
  unlinkSync(process.env.HELIX_TEST_HOST_FAIL_NEXT_START);
  process.exit(42);
}

const config = JSON.parse(readFileSync(argument('--config'), 'utf8'));
const effective = { ...config, strategy: argument('--strategy') };
const api = new URL(process.env.FREQTRADE_URL);
let entryState = String(config.initial_state || 'running');
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET' && request.url === '/api/v1/show_config') {
    response.end(JSON.stringify({ ...effective, state: entryState }));
    return;
  }
  if (request.method === 'GET' && request.url === '/api/v1/status') {
    response.end(process.env.HELIX_TEST_HOST_OPEN_TRADES === '1' ? '[{"trade_id":1}]' : '[]');
    return;
  }
  if (request.method === 'POST' && ['/api/v1/stopentry', '/api/v1/start'].includes(request.url)) {
    entryState = request.url.endsWith('/start') ? 'running' : 'stopped';
    if (process.env.HELIX_TEST_HOST_FAIL_BACKUP_CLEANUP === '1' && request.url.endsWith('/start')) {
      const journalFile = process.env.HOME + '/.freqtrade/user_data/helix/deployment/transaction.json';
      const journal = JSON.parse(readFileSync(journalFile, 'utf8'));
      const backup = journal.snapshots.find((snapshot) => snapshot.backup)?.backup;
      rmSync(backup, { force: true });
      mkdirSync(backup);
      writeFileSync(backup + '/keep', 'force cleanup failure');
    }
    response.end('{}');
    return;
  }
  response.statusCode = 404;
  response.end('{}');
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
server.listen(Number(api.port), api.hostname);
`;

async function setupHostDeployment(t, {
  failBackupCleanupOnStart = false,
  failCandidateStart = false,
  openTrades = false,
  signal = false,
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'helix-host-deploy-'));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const signalDir = join(userData, 'helix', 'signals');
  const deploymentDir = join(userData, 'helix', 'deployment');
  const backupsDir = join(deploymentDir, 'backups');
  const configFile = join(userData, 'config.json');
  const envFile = join(home, '.helix', '.env');
  const pidFile = join(home, '.freqtrade', 'freqtrade.pid');
  const binDir = join(home, 'bin');
  const failNextStart = join(home, 'fail-next-start');
  const strategyFile = join(strategyDir, 'TestStrategy.py');
  const sampleFile = join(strategyDir, 'SampleStrategy.py');

  await mkdir(resultsDir, { recursive: true });
  await mkdir(strategyDir, { recursive: true });
  await mkdir(signalDir, { recursive: true });
  await mkdir(dirname(envFile), { recursive: true });
  await mkdir(binDir, { recursive: true });
  t.after(async () => {
    await terminateDetachedPid(pidFile);
    await terminateForwardWorkers(userData);
    await rm(home, { recursive: true, force: true });
  });

  const port = await randomLoopbackPort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const originalConfig = `${JSON.stringify({
    strategy: 'OldStrategy',
    dry_run: true,
    timeframe: '5m',
    trading_mode: 'futures',
    margin_mode: 'isolated',
    max_open_trades: 1,
    exchange: {
      name: 'binance',
      key: 'dry-run',
      secret: 'dry-run',
      pair_whitelist: ['ETH/USDT:USDT'],
    },
    api_server: {
      enabled: true,
      listen_ip_address: '127.0.0.1',
      listen_port: port,
      username: 'freqtrade',
      password: 'host-test-password',
    },
  }, null, 2)}\n`;
  const originalEnv = `FREQTRADE_URL=${apiUrl}\nFREQTRADE_USERNAME=freqtrade\nFREQTRADE_PASSWORD=host-test-password\n`;
  const strategyCode = 'class TestStrategy:\n    pass\n';

  await writeFile(configFile, originalConfig, { mode: 0o600 });
  await writeFile(envFile, originalEnv, { mode: 0o600 });
  await writeFile(strategyFile, strategyCode);
  await writeFile(sampleFile, 'class SampleStrategy:\n    pass\n');
  const fakeBin = join(binDir, 'freqtrade');
  await writeFile(fakeBin, FAKE_FREQTRADE);
  await chmod(fakeBin, 0o755);

  const forwardWorkerFile = join(home, 'fake-forward-worker.cjs');
  await writeFile(forwardWorkerFile, `
const { readFileSync, writeFileSync } = require('node:fs');
const params = JSON.parse(process.argv.at(-1));
const deployment = JSON.parse(readFileSync(params.deployment, 'utf8'));
writeFileSync(params.status, JSON.stringify({
  schemaVersion: 'helix.forward-worker-status/v1',
  deploymentHash: deployment.deploymentHash,
  state: 'waiting',
  pid: params.statusPid || process.pid,
  updatedAt: Date.now(),
  lastDecisionTime: null,
  lastMarketSnapshotId: null,
  lastBatchHash: null,
  batches: 0,
  error: null,
}));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);

  const artifact = signal ? artifactFixture() : null;
  let artifactFile = null;
  let artifactContent = null;
  let reportFile = null;
  if (artifact) {
    artifactFile = join(signalDir, `${artifact.artifactHash.replace(':', '-')}.json`);
    artifactContent = `${JSON.stringify(artifact, null, 2)}\n`;
    await writeFile(artifactFile, artifactContent, { mode: 0o600 });
    ({ reportFile } = await createPromotableWalkForwardReport(join(home, 'walk-forward'), artifact));
  }

  const resultFile = 'backtest-result-host.json';
  const resultMetaFile = 'backtest-result-host.meta.json';
  const resultContent = JSON.stringify({
    strategy: {
      [signal ? 'HelixSignalStrategy' : 'TestStrategy']: {
        total_trades: signal ? 1 : 2,
        profit_total: 0.01,
        profit_total_abs: 10,
        ...(signal ? {
          trades: [{
            pair: artifact.symbol,
            is_short: false,
            is_open: false,
            open_timestamp: artifact.signals[0].decisionTime,
            close_timestamp: artifact.signals[1].decisionTime,
            enter_tag: artifact.signals[0].signalId,
            exit_reason: artifact.signals[1].signalId,
          }],
        } : {}),
      },
    },
  });
  const resultMetaContent = JSON.stringify({
    [signal ? 'HelixSignalStrategy' : 'TestStrategy']: {
      run_id: 'host-test',
      timeframe: signal ? artifact.baseTimeframe : '5m',
    },
  });
  await writeFile(join(resultsDir, resultFile), resultContent);
  await writeFile(join(resultsDir, resultMetaFile), resultMetaContent);
  await writeFile(join(resultsDir, '.helix-evidence.json'), JSON.stringify({
    version: 2,
    records: [{
      id: 'host-evidence',
      strategy: signal ? 'HelixSignalStrategy' : 'TestStrategy',
      strategyHash: signal ? await adapterFingerprint() : createHash('sha256').update(strategyCode).digest('hex'),
      timeframe: signal ? artifact.baseTimeframe : '5m',
      timerange: signal ? '' : '20260101-20260201',
      pairs: [signal ? artifact.symbol : 'BTC/USDT:USDT'],
      resultFile,
      resultMetaFile,
      resultHash: sha256(resultContent),
      resultMetaHash: sha256(resultMetaContent),
      metrics: { trades: signal ? 1 : 2, profitPct: 0.01 },
      ...(signal ? {
        signalArtifact: {
          artifactHash: artifact.artifactHash,
          schemaVersion: artifact.schemaVersion,
          strategyLifecycle: artifact.strategyLifecycle,
          identity: {
            strategyId: artifact.identity.strategyId,
            strategyVersion: artifact.identity.strategyVersion,
            strategyRepoCommit: artifact.identity.strategyRepoCommit,
            strategyConfigHash: artifact.identity.strategyConfigHash,
            engineCommit: artifact.identity.engineCommit,
          },
          marketDataSnapshotId: artifact.identity.marketDataSnapshotId,
          symbol: artifact.symbol,
          baseTimeframe: artifact.baseTimeframe,
          marketData: artifact.marketData,
          signalCount: artifact.signals.length,
        },
        marketDataset: { datasetHash: artifact.identity.marketDataSnapshotId },
        executionEnvironment: {
          freqtradeVersion: 'freqtrade test',
          configHash: sha256(originalConfig),
          artifactFileHash: sha256(artifactContent),
          fee: null,
          dataFormatOhlcv: 'json',
          executionProfile: {
            schemaVersion: 'helix.freqtrade-execution-profile/v1',
            strategy: 'HelixSignalStrategy',
            timeframe: artifact.baseTimeframe,
            pairs: [artifact.symbol],
            exchange: 'okx',
            tradingMode: 'futures',
            marginMode: 'isolated',
            maxOpenTrades: 1,
            stakeCurrency: 'USDT',
            stakeAmount: 'unlimited',
            tradableBalanceRatio: 0.5,
            dryRunWallet: 1000,
            fee: null,
            entryPricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
            exitPricing: { price_side: 'same', use_order_book: true, order_book_top: 1 },
            orderTypes: null,
            orderTimeInForce: null,
            unfilledTimeout: null,
            positionAdjustmentEnabled: null,
            maxEntryPositionAdjustment: null,
          },
        },
      } : {}),
      createdAt: '2026-07-16T00:00:00.000Z',
    }],
  }));

  const runAction = (action, params, envOverrides = {}) => {
    const args = [DEPLOY, action];
    if (params !== undefined) args.push(JSON.stringify(params));
    return execFileAsync(process.execPath, args, {
      cwd: SKILL_DIR,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH}`,
        HELIX_FREQTRADE_RUNTIME: '',
        FREQTRADE_URL: apiUrl,
        FREQTRADE_USERNAME: 'freqtrade',
        FREQTRADE_PASSWORD: 'host-test-password',
        HELIX_TEST_DEPLOY_TIMEOUT_MS: '6000',
        HELIX_TEST_HOST_FAIL_BACKUP_CLEANUP: failBackupCleanupOnStart ? '1' : '',
        HELIX_TEST_HOST_FAIL_START: failCandidateStart ? '1' : '',
        HELIX_TEST_HOST_FAIL_NEXT_START: failNextStart,
        HELIX_TEST_HOST_OPEN_TRADES: openTrades ? '1' : '',
        HELIX_TEST_FORWARD_WORKER_FILE: forwardWorkerFile,
        OKX_API_KEY: '',
        OKX_API_SECRET: '',
        OKX_PASSWORD: '',
        ...envOverrides,
      },
      timeout: 25_000,
    });
  };
  const run = () => runAction('deploy', signal ? {
    signal_artifact_hash: artifact.artifactHash,
    walk_forward_report: reportFile,
    dry_run: true,
    exchange: 'okx',
    max_open_trades: 1,
  } : {
    strategy: 'TestStrategy',
    dry_run: true,
    exchange: 'binance',
    pairs: ['BTC/USDT:USDT'],
    max_open_trades: 1,
  });

  return {
    apiUrl,
    artifact,
    reportFile,
    backupsDir,
    configFile,
    deploymentDir,
    envFile,
    failNextStart,
    originalConfig,
    originalEnv,
    pidFile,
    run,
    runAction,
    strategyFile,
  };
}

test('host deployment verifies readiness, records ACTIVE, and removes transaction backups', async (t) => {
  const setup = await setupHostDeployment(t);
  const { stdout } = await setup.run();
  const result = JSON.parse(stdout);

  assert.equal(result.success, true);
  assert.equal(result.ready, true);
  assert.equal(result.strategy, 'TestStrategy');
  assert.equal(result.effective.strategy, 'TestStrategy');
  assert.equal(result.effective.dryRun, true);
  assert.deepEqual(result.effective.pairs, ['BTC/USDT:USDT']);
  assert.equal(result.effective.maxOpenTrades, 1);
  assert.equal(processIsAlive(result.pid), true);

  const journal = JSON.parse(await readFile(join(setup.deploymentDir, 'transaction.json'), 'utf8'));
  assert.equal(journal.phase, 'ACTIVE');
  assert.equal(journal.id, result.transaction_id);
  assert.deepEqual(await readdir(setup.backupsDir), []);
});

test('host Signal deployment manages its forward worker across stop and start', async (t) => {
  const setup = await setupHostDeployment(t, { signal: true });
  const deployed = JSON.parse((await setup.run()).stdout);
  assert.equal(deployed.success, true);
  assert.equal(deployed.strategy, 'HelixSignalStrategy');
  assert.equal(deployed.forward_runtime.state, 'waiting');
  assert.equal(processIsAlive(deployed.forward_runtime.worker_pid), true);

  const status = JSON.parse((await setup.runAction('status')).stdout);
  assert.equal(status.forward_runtime.running, true);
  assert.equal(status.forward_runtime.deployment_hash, deployed.forward_runtime.deployment_hash);

  const stopped = JSON.parse((await setup.runAction('stop')).stdout);
  assert.equal(stopped.forward_worker_pid, deployed.forward_runtime.worker_pid);
  assert.equal(processIsAlive(deployed.forward_runtime.worker_pid), false);

  const started = JSON.parse((await setup.runAction('start', {})).stdout);
  assert.equal(started.started, true);
  assert.equal(started.strategy, 'HelixSignalStrategy');
  assert.equal(started.forward_runtime.state, 'waiting');
  assert.notEqual(started.forward_runtime.pid, deployed.forward_runtime.worker_pid);
  await setup.runAction('stop');
});

test('host Signal rollback restores the previous forward worker before reopening entries', async (t) => {
  const setup = await setupHostDeployment(t, { signal: true });
  const first = JSON.parse((await setup.run()).stdout);
  const firstConfig = await readFile(setup.configFile, 'utf8');
  await writeFile(setup.failNextStart, 'fail candidate once');

  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /Deployment failed and was rolled back/);
    return true;
  });

  assert.equal(await readFile(setup.configFile, 'utf8'), firstConfig);
  const runtimeRoot = dirname(first.forward_runtime.deployment_file);
  const restoredPid = JSON.parse(await readFile(join(runtimeRoot, 'worker.pid'), 'utf8')).pid;
  assert.equal(processIsAlive(first.forward_runtime.worker_pid), false);
  assert.equal(processIsAlive(restoredPid), true);
  assert.notEqual(restoredPid, first.forward_runtime.worker_pid);
  await setup.runAction('stop');
});

test('host deployment rolls back a failed candidate start and never reports success', async (t) => {
  const setup = await setupHostDeployment(t, { failCandidateStart: true });

  await assert.rejects(setup.run(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Deployment failed and was rolled back/);
    assert.doesNotMatch(error.stdout || '', /"success"\s*:\s*true/);
    return true;
  });

  assert.equal(await readFile(setup.configFile, 'utf8'), setup.originalConfig);
  assert.equal(await readFile(setup.envFile, 'utf8'), setup.originalEnv);
  const journal = JSON.parse(await readFile(join(setup.deploymentDir, 'transaction.json'), 'utf8'));
  assert.equal(journal.phase, 'ROLLED_BACK');
  assert.deepEqual(await readdir(setup.backupsDir), []);
  assert.equal((await readFile(setup.pidFile, 'utf8')).trim(), '');
});

test('host ACTIVE cleanup failure restores the latch and stops entries', async (t) => {
  const setup = await setupHostDeployment(t, { failBackupCleanupOnStart: true });
  const latchFile = join(setup.deploymentDir, 'emergency-stop.json');
  await mkdir(dirname(latchFile), { recursive: true });
  await writeFile(latchFile, JSON.stringify({ id: 'prior-emergency', pid: 999_999_999, createdAt: 0 }));

  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /target remains committed with entries stopped/);
    return true;
  });
  assert.notEqual(JSON.parse(await readFile(latchFile, 'utf8')).id, 'prior-emergency');
  assert.equal(JSON.parse(await readFile(setup.configFile, 'utf8')).initial_state, 'stopped');
  const journal = JSON.parse(await readFile(join(setup.deploymentDir, 'transaction.json'), 'utf8'));
  assert.equal(journal.phase, 'ACTIVE');
  const response = await fetch(`${setup.apiUrl}/api/v1/show_config`, {
    headers: { Authorization: `Basic ${Buffer.from('freqtrade:host-test-password').toString('base64')}` },
  });
  assert.equal(response.ok, true);
  assert.equal((await response.json()).state, 'stopped');
});

test('host deployment proves flat state even when the previous daemon is stopped', async (t) => {
  const setup = await setupHostDeployment(t, { openTrades: true });
  await assert.rejects(setup.run(), (error) => {
    assert.match(error.stderr, /requires a flat bot; 1 open trade/);
    return true;
  });
  assert.equal(await readFile(setup.configFile, 'utf8'), setup.originalConfig);
  assert.equal((await readFile(setup.pidFile, 'utf8')).trim(), '');
  const journal = JSON.parse(await readFile(join(setup.deploymentDir, 'transaction.json'), 'utf8'));
  assert.equal(journal.phase, 'ROLLED_BACK');
});

test('host start rejects strategy overrides and starts the committed config strategy', async (t) => {
  const setup = await setupHostDeployment(t);
  await setup.run();
  await setup.runAction('stop');

  await assert.rejects(
    setup.runAction('start', { strategy: 'SampleStrategy' }),
    (error) => {
      assert.match(error.stderr, /does not accept a strategy override/);
      return true;
    },
  );
  const { stdout } = await setup.runAction('start', {});
  const result = JSON.parse(stdout);
  assert.equal(result.started, true);
  assert.equal(result.strategy, 'TestStrategy');
  assert.equal(result.effective.strategy, 'TestStrategy');
  assert.equal(processIsAlive(result.pid), true);
});

test('host start rejects unhealthy transactions before spawning a daemon', async (t) => {
  const setup = await setupHostDeployment(t);
  await setup.run();
  await setup.runAction('stop');
  const journalFile = join(setup.deploymentDir, 'transaction.json');
  const journal = JSON.parse(await readFile(journalFile, 'utf8'));

  for (const phase of ['COMMITTED', 'FAILED_ROLLBACK']) {
    await writeFile(journalFile, JSON.stringify({ ...journal, phase }));
    await assert.rejects(setup.runAction('start', {}), (error) => {
      assert.match(error.stderr, phase === 'COMMITTED' ? /is incomplete \(COMMITTED\)/ : /FAILED_ROLLBACK/);
      return true;
    });
    assert.equal(processIsAlive(Number((await readFile(setup.pidFile, 'utf8')).trim())), false);
  }
});

test('host start fails closed when the committed strategy evidence or Artifact pin is invalid', async (t) => {
  const setup = await setupHostDeployment(t);
  await setup.run();
  await setup.runAction('stop');

  await writeFile(setup.strategyFile, 'class TestStrategy:\n    pass\n# changed\n');
  await assert.rejects(setup.runAction('start', {}), (error) => {
    assert.match(error.stderr, /has not been backtested/);
    return true;
  });

  const config = JSON.parse(await readFile(setup.configFile, 'utf8'));
  await writeFile(setup.configFile, JSON.stringify({ ...config, strategy: 'HelixSignalStrategy' }));
  await assert.rejects(setup.runAction('start', {}), (error) => {
    assert.match(error.stderr, /missing its immutable Artifact pin/);
    return true;
  });
});

test('host start never reports success when the child exits before readiness', async (t) => {
  const setup = await setupHostDeployment(t);
  await setup.run();
  await setup.runAction('stop');

  await assert.rejects(
    setup.runAction('start', {}, { HELIX_TEST_HOST_FAIL_START: '1', HELIX_TEST_DEPLOY_TIMEOUT_MS: '500' }),
    (error) => {
      assert.match(error.stderr, /host daemon readiness failed/);
      assert.doesNotMatch(error.stdout || '', /"started"\s*:\s*true/);
      return true;
    },
  );
  assert.equal((await readFile(setup.pidFile, 'utf8')).trim(), '');
});
