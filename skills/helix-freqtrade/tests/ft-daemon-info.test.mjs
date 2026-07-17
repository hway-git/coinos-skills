import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { createForwardWorkerOwner } from '../lib/forward-runtime.mjs';

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
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

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 80 && processIsAlive(pid); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return !processIsAlive(pid);
}

async function writeBacktestFiles(resultsDir, strategy, summary, base = 'backtest-result-test') {
  const resultFile = `${base}.json`;
  const resultMetaFile = `${base}.meta.json`;
  const resultContent = JSON.stringify({ strategy: { [strategy]: summary } });
  const resultMetaContent = JSON.stringify({ [strategy]: { run_id: 'test-run', timeframe: '5m' } });
  await writeFile(join(resultsDir, resultFile), resultContent);
  await writeFile(join(resultsDir, resultMetaFile), resultMetaContent);
  return {
    evidence: {
      resultFile,
      resultMetaFile,
      resultHash: sha256(resultContent),
      resultMetaHash: sha256(resultMetaContent),
    },
    resultContent,
    resultMetaContent,
  };
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

async function runDaemonInfo(baseUrl) {
  return execFileAsync(process.execPath, ['scripts/ft.mjs', 'daemon_info'], {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      FREQTRADE_URL: baseUrl,
      FREQTRADE_USERNAME: 'freqtrade',
      FREQTRADE_PASSWORD: 'test-only',
    },
  });
}

async function runFtAction(baseUrl, action, params, home, extraEnv = {}) {
  const args = ['scripts/ft.mjs', action];
  if (params) args.push(JSON.stringify(params));
  return execFileAsync(process.execPath, args, {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      ...(home ? { HOME: home } : {}),
      FREQTRADE_URL: baseUrl,
      FREQTRADE_USERNAME: 'freqtrade',
      FREQTRADE_PASSWORD: 'test-only',
      ...extraEnv,
    },
  });
}

test('daemon_info reports online after show_config succeeds', async (t) => {
  const mock = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ strategy: 'TestStrategy', dry_run: true, whitelist: ['BTC/USDT:USDT'] }));
      return;
    }
    if (request.url === '/api/v1/status') {
      response.end('[]');
      return;
    }
    if (request.url === '/api/v1/version') {
      response.end(JSON.stringify({ version: 'test' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const { stdout } = await runDaemonInfo(mock.url);
  const result = JSON.parse(stdout);
  assert.equal(result.online, true);
  assert.equal(result.strategy, 'TestStrategy');
  assert.equal(result.dry_run, true);
});

test('daemon_info fails when show_config is unavailable', async (t) => {
  const mock = await listen((_request, response) => {
    response.statusCode = 503;
    response.end('offline');
  });
  t.after(mock.close);

  await assert.rejects(runDaemonInfo(mock.url), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Freqtrade 503/);
    return true;
  });
});

test('entry-opening actions reject incomplete and failed deployment transactions before REST calls', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-entry-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const deploymentDir = join(home, '.freqtrade', 'user_data', 'helix', 'deployment');
  await mkdir(deploymentDir, { recursive: true });
  const calls = [];
  const mock = await listen((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
  t.after(mock.close);

  for (const phase of ['PREPARED', 'FAILED_ROLLBACK']) {
    await writeFile(join(deploymentDir, 'transaction.json'), JSON.stringify({
      version: 1, id: `transaction-${phase}`, phase,
    }));
    for (const [action, params] of [
      ['start', undefined],
      ['reload', undefined],
      ['force_enter', { pair: 'BTC/USDT:USDT', side: 'long' }],
    ]) {
      await assert.rejects(
        runFtAction(mock.url, action, params, home),
        (error) => {
          assert.match(error.stderr, phase === 'PREPARED' ? /is incomplete \(PREPARED\)/ : /FAILED_ROLLBACK/);
          return true;
        },
      );
    }
  }
  assert.deepEqual(calls, []);
});

test('risk-reducing actions remain available during an incomplete deployment', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-closing-actions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const deploymentDir = join(home, '.freqtrade', 'user_data', 'helix', 'deployment');
  await mkdir(deploymentDir, { recursive: true });
  await writeFile(join(deploymentDir, 'transaction.json'), JSON.stringify({
    version: 1, id: 'incomplete-close-test', phase: 'COMMITTED',
  }));
  const calls = [];
  const mock = await listen((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
  t.after(mock.close);

  await runFtAction(mock.url, 'stop_entry', undefined, home);
  await runFtAction(mock.url, 'force_exit', { tradeid: 'all' }, home);
  assert.deepEqual(calls, ['POST /api/v1/stopentry', 'POST /api/v1/forcesell']);
});

test('generic entry controls cannot bypass a committed Signal Artifact deployment', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-signal-entry-control-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configFile = join(home, '.freqtrade', 'user_data', 'config.json');
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ strategy: 'HelixSignalStrategy', initial_state: 'stopped' }));
  const calls = [];
  const mock = await listen((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
  t.after(mock.close);

  for (const [action, params] of [
    ['start', undefined],
    ['reload', undefined],
    ['force_enter', { pair: 'BTC/USDT:USDT', side: 'long' }],
  ]) {
    await assert.rejects(runFtAction(mock.url, action, params, home), (error) => {
      assert.match(error.stderr, /must go through the verified ft-deploy lifecycle/);
      return true;
    });
  }
  assert.deepEqual(calls, []);
});

test('entry activation reports a failed latch compensation instead of hiding it', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-entry-compensation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const configFile = join(userData, 'config.json');
  const latchFile = join(userData, 'helix', 'deployment', 'emergency-stop.json');
  await mkdir(dirname(configFile), { recursive: true });
  await mkdir(dirname(latchFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ strategy: 'TestStrategy', initial_state: 'stopped' }));
  const mock = await listen(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/start') {
      await writeFile(latchFile, JSON.stringify({ id: 'emergency', pid: 999_999_999, createdAt: Date.now() }));
      response.end('{}');
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ state: 'running' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  await assert.rejects(
    runFtAction(mock.url, 'start', undefined, home, { HELIX_TEST_ENTRY_TIMEOUT_MS: '300' }),
    (error) => {
      assert.match(error.stderr, /entry compensation failed: entry state confirmation failed/);
      return true;
    },
  );
});

test('set_pairs updates and reloads a normal managed strategy under the entry gate', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-set-pairs-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configFile = join(home, '.freqtrade', 'user_data', 'config.json');
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({
    strategy: 'TestStrategy',
    exchange: { pair_whitelist: ['ETH/USDT:USDT'] },
  }));
  const calls = [];
  const mock = await listen((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });
  t.after(mock.close);

  const { stdout } = await runFtAction(
    mock.url,
    'set_pairs',
    { pairs: ['BTC/USDT:USDT'] },
    home,
    { HELIX_FREQTRADE_RUNTIME: 'docker' },
  );
  assert.deepEqual(JSON.parse(stdout), {
    from: ['ETH/USDT:USDT'],
    to: ['BTC/USDT:USDT'],
    reloaded: {},
  });
  assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')).exchange.pair_whitelist, ['BTC/USDT:USDT']);
  assert.deepEqual(calls, ['POST /api/v1/reload_config']);
});

test('backtest evidence becomes stale after strategy code changes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-freqtrade-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const strategyFile = join(strategyDir, 'TestStrategy.py');
  const initialCode = 'class TestStrategy:\n    pass\n';
  const strategyHash = createHash('sha256').update(initialCode).digest('hex');

  await mkdir(strategyDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await writeFile(strategyFile, initialCode);
  const backtestFiles = await writeBacktestFiles(resultsDir, 'TestStrategy', {
    total_trades: 5,
    profit_total: 0.01,
    profit_total_abs: 10,
  }, 'backtest-result-staleness');
  await writeFile(join(resultsDir, '.helix-evidence.json'), JSON.stringify({
    version: 2,
    records: [{
      id: 'test-evidence',
      strategy: 'TestStrategy',
      strategyHash,
      timeframe: '15m',
      timerange: '20250101-20251231',
      pairs: ['BTC/USDT:USDT'],
      ...backtestFiles.evidence,
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));

  const runResults = async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/ft-deploy.mjs', 'backtest_results'], {
      cwd: SKILL_DIR,
      env: { ...process.env, HOME: home },
    });
    return JSON.parse(stdout);
  };

  assert.equal((await runResults()).evidence[0].current, true);
  await writeFile(strategyFile, `${initialCode}# changed\n`);
  assert.equal((await runResults()).evidence[0].current, false);

  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/ft-deploy.mjs', 'deploy', '{"strategy":"TestStrategy","dry_run":true}'], {
      cwd: SKILL_DIR,
      env: { ...process.env, HOME: home },
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /has not been backtested/);
      return true;
    },
  );
});

test('deploy rejects empty or non-profitable backtest evidence', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-quality-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const code = 'class TestStrategy:\n    pass\n';

  await mkdir(strategyDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(strategyDir, 'TestStrategy.py'), code);

  const deploy = () => execFileAsync(process.execPath, [
    'scripts/ft-deploy.mjs',
    'deploy',
    '{"strategy":"TestStrategy","dry_run":true}',
  ], {
    cwd: SKILL_DIR,
    env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' },
  });
  const writeEvidence = async (actualMetrics, recordedMetrics = actualMetrics) => {
    const files = await writeBacktestFiles(resultsDir, 'TestStrategy', {
      total_trades: actualMetrics.trades,
      profit_total: actualMetrics.profitPct,
      profit_total_abs: actualMetrics.profitAbs ?? actualMetrics.profitPct * 1000,
    });
    await writeFile(join(resultsDir, '.helix-evidence.json'), JSON.stringify({
      version: 2,
      records: [{
        id: 'quality-gate-evidence',
        strategy: 'TestStrategy',
        strategyHash: createHash('sha256').update(code).digest('hex'),
        timeframe: '5m',
        timerange: '20260101-20260201',
        pairs: ['BTC/USDT:USDT'],
        ...files.evidence,
        metrics: recordedMetrics,
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    }));
  };

  await writeEvidence({ trades: 0, profitPct: 0 });
  await assert.rejects(deploy(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /has 0 trades/);
    return true;
  });

  await writeEvidence({ trades: 4, profitPct: -0.0084 });
  await assert.rejects(deploy(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /is not profitable \(-0\.84%\)/);
    return true;
  });

  await writeEvidence(
    { trades: 3, profitPct: -0.012 },
    { trades: 999, profitPct: 99 },
  );
  await assert.rejects(deploy(), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /is not profitable \(-1\.20%\)/);
    return true;
  });
});

test('deploy rejects missing or tampered backtest result files', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-evidence-integrity-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const code = 'class TestStrategy:\n    pass\n';
  await mkdir(strategyDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(strategyDir, 'TestStrategy.py'), code);
  const files = await writeBacktestFiles(resultsDir, 'TestStrategy', {
    total_trades: 4,
    profit_total: 0.02,
    profit_total_abs: 20,
  }, 'backtest-result-integrity');
  const evidenceFile = join(resultsDir, '.helix-evidence.json');
  const writeEvidence = (overrides = {}) => writeFile(evidenceFile, JSON.stringify({
    version: 2,
    records: [{
      id: 'integrity-evidence',
      strategy: 'TestStrategy',
      strategyHash: createHash('sha256').update(code).digest('hex'),
      timeframe: '5m',
      timerange: '20260101-20260201',
      pairs: ['BTC/USDT:USDT'],
      ...files.evidence,
      ...overrides,
      metrics: { trades: 4, profitPct: 0.02 },
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));
  const deploy = () => execFileAsync(process.execPath, [
    'scripts/ft-deploy.mjs',
    'deploy',
    '{"strategy":"TestStrategy","dry_run":true}',
  ], {
    cwd: SKILL_DIR,
    env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' },
  });
  const backtestResults = async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/ft-deploy.mjs',
      'backtest_results',
    ], {
      cwd: SKILL_DIR,
      env: { ...process.env, HOME: home, HELIX_FREQTRADE_RUNTIME: '' },
    });
    return JSON.parse(stdout);
  };

  await writeEvidence({ resultFile: null });
  await assert.rejects(deploy(), (error) => {
    assert.match(error.stderr, /has no result file/);
    return true;
  });

  await writeEvidence();
  await rm(join(resultsDir, files.evidence.resultFile));
  await assert.rejects(deploy(), (error) => {
    assert.match(error.stderr, /result file is missing/);
    return true;
  });

  await writeFile(join(resultsDir, files.evidence.resultFile), `${files.resultContent}\n`);
  await assert.rejects(deploy(), (error) => {
    assert.match(error.stderr, /result hash mismatch/);
    return true;
  });
  assert.equal((await backtestResults()).evidence[0].current, false);

  await writeFile(join(resultsDir, files.evidence.resultFile), files.resultContent);
  await writeFile(join(resultsDir, files.evidence.resultMetaFile), `${files.resultMetaContent}\n`);
  await assert.rejects(deploy(), (error) => {
    assert.match(error.stderr, /result metadata hash mismatch/);
    return true;
  });
});

test('live deploy enforces every authorization and risk gate', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-live-gate-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const strategyDir = join(userData, 'strategies');
  const resultsDir = join(userData, 'backtest_results');
  const strategyFile = join(strategyDir, 'TestStrategy.py');
  const code = 'class TestStrategy:\n    pass\n';

  await mkdir(strategyDir, { recursive: true });
  await mkdir(resultsDir, { recursive: true });
  await writeFile(strategyFile, code);
  const backtestFiles = await writeBacktestFiles(resultsDir, 'TestStrategy', {
    total_trades: 20,
    profit_total: 0.015,
    profit_total_abs: 15,
  }, 'backtest-result-live-gate');
  await writeFile(join(resultsDir, '.helix-evidence.json'), JSON.stringify({
    version: 2,
    records: [{
      id: 'live-gate-evidence',
      strategy: 'TestStrategy',
      strategyHash: createHash('sha256').update(code).digest('hex'),
      timeframe: '5m',
      timerange: '20260101-20260201',
      pairs: ['BTC/USDT:USDT'],
      ...backtestFiles.evidence,
      metrics: { trades: 20, profitPct: 1.5 },
      createdAt: '2026-01-01T00:00:00.000Z',
    }],
  }));

  const deploy = (params, env = {}) => execFileAsync(process.execPath, [
    'scripts/ft-deploy.mjs',
    'deploy',
    JSON.stringify({ strategy: 'TestStrategy', dry_run: false, max_open_trades: 2, exchange: 'okx', ...params }),
  ], {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      HOME: home,
      HELIX_FREQTRADE_RUNTIME: '',
      HELIX_LIVE_TRADING_ENABLED: '',
      HELIX_LIVE_AUTHORIZED: '',
      OKX_API_KEY: '',
      OKX_API_SECRET: '',
      OKX_PASSWORD: '',
      ...env,
    },
  });

  await assert.rejects(
    deploy({}, { HELIX_LIVE_TRADING_ENABLED: 'false', HELIX_LIVE_AUTHORIZED: '1' }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Live trading is disabled/);
      return true;
    },
  );

  await assert.rejects(
    deploy({}, { HELIX_LIVE_TRADING_ENABLED: 'true' }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /fresh Dashboard live authorization session/);
      return true;
    },
  );

  await assert.rejects(
    deploy({}, { HELIX_LIVE_TRADING_ENABLED: 'true', HELIX_LIVE_AUTHORIZED: '1' }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /configured API credentials/);
      return true;
    },
  );

  await assert.rejects(
    deploy({}, {
      HELIX_LIVE_TRADING_ENABLED: 'true',
      HELIX_LIVE_AUTHORIZED: '1',
      OKX_API_KEY: 'test-key',
      OKX_API_SECRET: 'test-secret',
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /requires the API passphrase/);
      return true;
    },
  );

  await assert.rejects(
    deploy({ max_open_trades: 3 }, {
      HELIX_LIVE_TRADING_ENABLED: 'true',
      HELIX_LIVE_AUTHORIZED: '1',
      OKX_API_KEY: 'test-key',
      OKX_API_SECRET: 'test-secret',
      OKX_PASSWORD: 'test-passphrase',
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /max_open_trades between 1 and 2/);
      return true;
    },
  );

  await assert.rejects(
    deploy({ dry_run: true, max_open_trades: 3 }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /max_open_trades between 1 and 2/);
      return true;
    },
  );
});

test('emergency stop force-exits all trades before stopping the daemon', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-emergency-stop-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configFile = join(home, '.freqtrade', 'user_data', 'config.json');
  await mkdir(dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify({ strategy: 'TestStrategy', initial_state: 'running' }));
  const calls = [];
  let statusCalls = 0;
  let daemonState = 'running';
  const mock = await listen(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      calls.push('stopentry');
      daemonState = 'stopped';
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      calls.push('status');
      statusCalls += 1;
      response.end(JSON.stringify(statusCalls === 1 ? [{ trade_id: 1 }] : []));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ state: daemonState }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/forceexit') {
      let body = '';
      for await (const chunk of request) body += chunk;
      calls.push(`forceexit:${body}`);
      response.end(JSON.stringify({ result: 'Created exit orders for all open trades.' }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/stop') {
      calls.push('stop');
      daemonState = 'stopped';
      response.end(JSON.stringify({ status: 'stopping trader ...' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const { stdout } = await runFtAction(mock.url, 'emergency_stop', undefined, home);
  const result = JSON.parse(stdout);
  assert.equal(result.success, true);
  assert.equal(result.open_trades_after, 0);
  assert.equal(JSON.parse(await readFile(configFile, 'utf8')).initial_state, 'stopped');
  assert.deepEqual(calls.map((call) => call.split(':')[0]), ['stopentry', 'status', 'forceexit', 'status', 'status', 'stop']);
  assert.deepEqual(JSON.parse(calls[2].slice('forceexit:'.length)), { tradeid: 'all', ordertype: 'market' });
});

test('emergency stop terminates the committed forward worker', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-emergency-forward-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const configFile = join(userData, 'config.json');
  const runtimeRoot = join(userData, 'helix', 'forward', 'emergency-test');
  const deploymentHash = `sha256:${'a'.repeat(64)}`;
  await mkdir(join(runtimeRoot, 'batches'), { recursive: true });
  const ownerToken = 'b'.repeat(32);
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ownerToken], { stdio: 'ignore' });
  assert.equal(Number.isSafeInteger(worker.pid), true);
  t.after(() => {
    if (processIsAlive(worker.pid)) process.kill(worker.pid, 'SIGKILL');
  });
  await writeFile(join(runtimeRoot, 'worker.pid'), JSON.stringify(createForwardWorkerOwner({
    pid: worker.pid,
    deploymentHash,
    ownerToken,
  })));
  await writeFile(configFile, JSON.stringify({
    strategy: 'HelixSignalStrategy',
    initial_state: 'running',
    helix_signal_forward_deployment_path: join(runtimeRoot, 'deployment.json'),
    helix_signal_forward_deployment_hash: deploymentHash,
    helix_signal_batch_path: join(runtimeRoot, 'batches'),
    helix_signal_forward_status_path: join(runtimeRoot, 'status.json'),
  }));

  let daemonState = 'running';
  const mock = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      daemonState = 'stopped';
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      response.end('[]');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ state: daemonState }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/stop') {
      daemonState = 'stopped';
      response.end('{}');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const result = JSON.parse((await runFtAction(mock.url, 'emergency_stop', undefined, home)).stdout);
  assert.equal(result.success, true);
  assert.equal(await waitForProcessExit(worker.pid), true);
  assert.equal((await readFile(join(runtimeRoot, 'worker.pid'), 'utf8')).trim(), '');
});

test('emergency stop does not trust a successful CLI exit without stop confirmation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-emergency-forward-unconfirmed-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const configFile = join(userData, 'config.json');
  const runtimeRoot = join(userData, 'helix', 'forward', 'emergency-test');
  const deploymentHash = `sha256:${'a'.repeat(64)}`;
  await mkdir(join(runtimeRoot, 'batches'), { recursive: true });
  await writeFile(configFile, JSON.stringify({
    strategy: 'HelixSignalStrategy',
    initial_state: 'running',
    helix_signal_forward_deployment_path: join(runtimeRoot, 'deployment.json'),
    helix_signal_forward_deployment_hash: deploymentHash,
    helix_signal_batch_path: join(runtimeRoot, 'batches'),
    helix_signal_forward_status_path: join(runtimeRoot, 'status.json'),
  }));

  let daemonState = 'running';
  const mock = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      daemonState = 'stopped';
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      response.end('[]');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ state: daemonState }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/stop') {
      daemonState = 'stopped';
      response.end('{}');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const result = JSON.parse((await runFtAction(mock.url, 'emergency_stop', undefined, home)).stdout);
  assert.equal(result.success, false);
  assert.match(result.stop_error, /forward runtime could not be stopped/);
  assert.match(result.stop_error, /Not running/);
});

test('emergency stop reports failure when the forward worker cannot be stopped safely', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-emergency-forward-failure-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const userData = join(home, '.freqtrade', 'user_data');
  const configFile = join(userData, 'config.json');
  const runtimeRoot = join(userData, 'helix', 'forward', 'emergency-test');
  const deploymentHash = `sha256:${'a'.repeat(64)}`;
  await mkdir(join(runtimeRoot, 'batches'), { recursive: true });
  const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.equal(Number.isSafeInteger(worker.pid), true);
  t.after(() => {
    if (processIsAlive(worker.pid)) process.kill(worker.pid, 'SIGKILL');
  });
  await writeFile(join(runtimeRoot, 'worker.pid'), JSON.stringify({
    pid: worker.pid,
    deploymentHash: `sha256:${'f'.repeat(64)}`,
    createdAt: Date.now(),
  }));
  await writeFile(configFile, JSON.stringify({
    strategy: 'HelixSignalStrategy',
    initial_state: 'running',
    helix_signal_forward_deployment_path: join(runtimeRoot, 'deployment.json'),
    helix_signal_forward_deployment_hash: deploymentHash,
    helix_signal_batch_path: join(runtimeRoot, 'batches'),
    helix_signal_forward_status_path: join(runtimeRoot, 'status.json'),
  }));

  let daemonState = 'running';
  const mock = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      daemonState = 'stopped';
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      response.end('[]');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ state: daemonState }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/stop') {
      daemonState = 'stopped';
      response.end('{}');
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const result = JSON.parse((await runFtAction(mock.url, 'emergency_stop', undefined, home)).stdout);
  assert.equal(result.success, false);
  assert.match(result.stop_error, /forward runtime could not be stopped/);
  assert.match(result.stop_error, /Forward worker PID metadata does not match its deployment/);
  assert.equal(processIsAlive(worker.pid), true);
});

test('emergency stop leaves the daemon running when flat state cannot be confirmed', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-emergency-non-flat-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  let entryState = 'running';
  const mock = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      calls.push('stopentry');
      entryState = 'stopped';
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ state: entryState }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      calls.push('status');
      response.end(JSON.stringify([{ trade_id: 1 }]));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/forceexit') {
      calls.push('forceexit');
      response.statusCode = 503;
      response.end('exchange unavailable');
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/stop') calls.push('stop');
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const { stdout } = await runFtAction(mock.url, 'emergency_stop', undefined, home);
  const result = JSON.parse(stdout);
  assert.equal(result.success, false);
  assert.equal(result.open_trades_after, 1);
  assert.match(result.force_exit_error, /Freqtrade 503/);
  assert.match(result.stop_error, /left running/);
  assert.deepEqual(calls, ['stopentry', 'status', 'forceexit']);
});

test('emergency stop does not report success until the stopped state is confirmed', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-emergency-stop-state-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let entryState = 'running';
  let stopRequested = false;
  const mock = await listen((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      entryState = 'stopped';
      response.end('{}');
      return;
    }
    if (request.method === 'POST' && request.url === '/api/v1/stop') {
      stopRequested = true;
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/status') {
      response.end('[]');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ state: stopRequested ? 'running' : entryState }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  t.after(mock.close);

  const { stdout } = await runFtAction(
    mock.url,
    'emergency_stop',
    undefined,
    home,
    { HELIX_TEST_EMERGENCY_TIMEOUT_MS: '300' },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.success, false);
  assert.match(result.stop_error, /stop was not confirmed/);
});

test('emergency stop fails before reading trades when stopentry does not converge', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-emergency-entry-state-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [];
  const mock = await listen((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      response.end('{}');
      return;
    }
    if (request.method === 'GET' && request.url === '/api/v1/show_config') {
      response.end(JSON.stringify({ state: 'running' }));
      return;
    }
    response.end('[]');
  });
  t.after(mock.close);

  await assert.rejects(
    runFtAction(mock.url, 'emergency_stop', undefined, home, { HELIX_TEST_ENTRY_TIMEOUT_MS: '300' }),
    (error) => {
      assert.match(error.stderr, /entry state confirmation failed/);
      return true;
    },
  );
  assert.equal(calls.some((call) => call.endsWith('/status')), false);
  assert.equal(calls.some((call) => call.endsWith('/stop')), false);
});

test('emergency stop does not treat an unknown initial status as flat', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'helix-emergency-status-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const mock = await listen((request, response) => {
    if (request.method === 'POST' && request.url === '/api/v1/stopentry') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
      return;
    }
    response.statusCode = 503;
    response.end('offline');
  });
  t.after(mock.close);

  await assert.rejects(
    runFtAction(mock.url, 'emergency_stop', undefined, home, { HELIX_TEST_ENTRY_TIMEOUT_MS: '300' }),
    (error) => {
      assert.match(error.stderr, /Freqtrade 503/);
      return true;
    },
  );
});
