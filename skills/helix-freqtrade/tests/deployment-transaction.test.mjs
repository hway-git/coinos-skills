import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  beginDeploymentTransaction,
  cleanupDeploymentBackups,
  clearEmergencyStopLatch,
  deploymentTransactionIsIncomplete,
  emergencyStopIsLatched,
  readDeploymentTransaction,
  requireHealthyDeploymentTransaction,
  requireNoEmergencyStop,
  setEmergencyStopLatch,
  restoreDeploymentFiles,
  signalArtifactArchivePath,
  updateDeploymentTransaction,
  withBacktestLock,
  withDeploymentLock,
  withEntryTransitionLock,
  writeDeploymentFile,
} from '../lib/deployment-transaction.mjs';

const execFileAsync = promisify(execFile);
const TRANSACTION_MODULE = new URL('../lib/deployment-transaction.mjs', import.meta.url).href;

test('artifact hash resolves only inside the managed archive', () => {
  const hash = `sha256:${'a'.repeat(64)}`;
  assert.equal(
    signalArtifactArchivePath('/tmp/helix-user-data', hash),
    `/tmp/helix-user-data/helix/signals/${hash.replace(':', '-')}.json`,
  );
  assert.throws(() => signalArtifactArchivePath('/tmp/helix-user-data', '../active.json'), /must be a SHA-256 hash/);
});

test('emergency latch blocks deployment until explicitly cleared', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-emergency-latch-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  setEmergencyStopLatch(userData);
  assert.equal(emergencyStopIsLatched(userData), true);
  assert.throws(() => requireNoEmergencyStop(userData), /emergency stop latch/);
  clearEmergencyStopLatch(userData);
  assert.equal(emergencyStopIsLatched(userData), false);
});

test('deployment lock rejects overlap and releases after completion', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-deployment-lock-'));
  t.after(() => rm(userData, { recursive: true, force: true }));

  await withDeploymentLock(userData, 'first', async () => {
    await assert.rejects(
      withDeploymentLock(userData, 'second', async () => undefined),
      /deployment is locked by first/,
    );
  });
  await assert.doesNotReject(withDeploymentLock(userData, 'third', async () => undefined));
});

test('backtests cannot publish concurrent result/evidence records', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-backtest-lock-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  await withBacktestLock(userData, 'first backtest', async () => {
    await assert.rejects(
      withBacktestLock(userData, 'second backtest', async () => undefined),
      /backtest is locked by first backtest/,
    );
  });
  await assert.doesNotReject(withBacktestLock(userData, 'third backtest', async () => undefined));
});

test('deployment lock serializes callbacks across processes with complete owner metadata', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-process-lock-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const events = join(userData, 'events.jsonl');
  const worker = `
    import { appendFileSync } from 'node:fs';
    import { setTimeout as wait } from 'node:timers/promises';
    import { withDeploymentLock } from ${JSON.stringify(TRANSACTION_MODULE)};
    await withDeploymentLock(process.env.USER_DATA, process.env.LOCK_OPERATION, async () => {
      appendFileSync(process.env.EVENTS, JSON.stringify({ type: 'enter', operation: process.env.LOCK_OPERATION }) + '\\n');
      await wait(120);
      appendFileSync(process.env.EVENTS, JSON.stringify({ type: 'exit', operation: process.env.LOCK_OPERATION }) + '\\n');
    }, 2_000);
  `;
  const run = (operation) => execFileAsync(process.execPath, ['--input-type=module', '--eval', worker], {
    env: { ...process.env, USER_DATA: userData, EVENTS: events, LOCK_OPERATION: operation },
  });

  await Promise.all([run('first'), run('second')]);
  const records = (await readFile(events, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(({ type }) => type), ['enter', 'exit', 'enter', 'exit']);
  assert.notEqual(records[0].operation, records[2].operation);
});

test('stale deployment locks fail closed instead of racing a new owner', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-stale-lock-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const deploymentDir = join(userData, 'helix', 'deployment');
  await mkdir(deploymentDir, { recursive: true });
  await writeFile(join(deploymentDir, 'deployment.lock'), JSON.stringify({
    id: 'stale-owner', pid: 999_999_999, operation: 'crashed deploy', createdAt: 0,
  }));
  await assert.rejects(
    withDeploymentLock(userData, 'new deploy', async () => undefined),
    /has a stale lock/,
  );
});

test('lock cleanup failures preserve the callback error', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-lock-cleanup-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const lockFile = join(userData, 'helix', 'deployment', 'deployment.lock');
  await assert.rejects(
    withDeploymentLock(userData, 'failing deploy', async () => {
      await writeFile(lockFile, 'invalid owner metadata');
      throw new Error('primary deployment failure');
    }),
    (error) => {
      assert.equal(error instanceof AggregateError, true);
      assert.match(error.message, /primary deployment failure/);
      assert.match(error.message, /lock cleanup failed/);
      assert.equal(error.errors[0]?.message, 'primary deployment failure');
      return true;
    },
  );
});

test('an abandoned emergency clear claim remains latched and can be cleared later', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-emergency-claim-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const deploymentDir = join(userData, 'helix', 'deployment');
  await mkdir(deploymentDir, { recursive: true });
  await writeFile(
    join(deploymentDir, 'emergency-stop.json.clear.999999999.crashed'),
    JSON.stringify({ id: 'crashed-clear', pid: 999_999_999, createdAt: 0 }),
  );
  assert.equal(emergencyStopIsLatched(userData), true);
  assert.throws(() => requireNoEmergencyStop(userData), /emergency stop latch/);
  clearEmergencyStopLatch(userData);
  assert.equal(emergencyStopIsLatched(userData), false);
});

test('entry transition lock serializes activation with emergency stop', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-entry-transition-lock-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  let releaseFirst;
  let firstEntered = false;
  const firstGate = new Promise((resolveGate) => { releaseFirst = resolveGate; });
  const first = withEntryTransitionLock(userData, 'activate', async () => {
    firstEntered = true;
    await firstGate;
  });
  while (!firstEntered) await new Promise((resolveWait) => setTimeout(resolveWait, 5));

  let emergencyEntered = false;
  const emergency = withEntryTransitionLock(userData, 'emergency', async () => {
    emergencyEntered = true;
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(emergencyEntered, false);
  releaseFirst();
  await Promise.all([first, emergency]);
  assert.equal(emergencyEntered, true);
});

test('deployment transaction restores exact prior files after a failed commit', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-deployment-rollback-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const config = join(userData, 'config.json');
  const adapter = join(userData, 'HelixSignalStrategy.py');
  await writeFile(config, '{"strategy":"Old"}\n');

  const transaction = beginDeploymentTransaction(userData, {
    operation: 'deploy',
    files: [config, adapter],
    previous: { strategy: 'Old' },
    target: { strategy: 'New' },
  });
  assert.equal(deploymentTransactionIsIncomplete(readDeploymentTransaction(userData)), true);
  writeDeploymentFile(config, '{"strategy":"New"}\n');
  writeDeploymentFile(adapter, 'class Candidate:\n    pass\n');
  updateDeploymentTransaction(userData, transaction, 'COMMITTED');

  restoreDeploymentFiles(transaction);
  assert.equal(await readFile(config, 'utf8'), '{"strategy":"Old"}\n');
  await assert.rejects(readFile(adapter, 'utf8'), /ENOENT/);
  updateDeploymentTransaction(userData, transaction, 'ROLLED_BACK', 'candidate failed readiness');
  cleanupDeploymentBackups(transaction);
  assert.equal(readDeploymentTransaction(userData).phase, 'ROLLED_BACK');
  await assert.rejects(readFile(transaction.snapshots[0].backup), /ENOENT/);
  assert.equal(deploymentTransactionIsIncomplete(readDeploymentTransaction(userData)), false);
});

test('failed rollback is terminal and cannot be auto-recovered', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-failed-rollback-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const config = join(userData, 'config.json');
  await writeFile(config, '{}\n');
  const transaction = beginDeploymentTransaction(userData, {
    operation: 'deploy',
    files: [config],
    previous: {},
    target: {},
  });
  updateDeploymentTransaction(userData, transaction, 'FAILED_ROLLBACK', 'manual recovery required');
  assert.equal(deploymentTransactionIsIncomplete(readDeploymentTransaction(userData)), false);
  assert.throws(
    () => requireHealthyDeploymentTransaction(userData),
    /FAILED_ROLLBACK requires operator intervention/,
  );
});

test('entry-opening gate rejects incomplete transactions and allows ACTIVE identity', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'helix-transaction-gate-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const config = join(userData, 'config.json');
  await writeFile(config, '{}\n');
  const transaction = beginDeploymentTransaction(userData, {
    operation: 'deploy', files: [config], previous: {}, target: {},
  });
  assert.throws(
    () => requireHealthyDeploymentTransaction(userData),
    /is incomplete \(PREPARED\)/,
  );
  updateDeploymentTransaction(userData, transaction, 'ACTIVE');
  assert.equal(requireHealthyDeploymentTransaction(userData).phase, 'ACTIVE');
});
