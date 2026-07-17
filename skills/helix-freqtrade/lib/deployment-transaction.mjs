import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const ARTIFACT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TRANSACTION_VERSION = 1;
const TERMINAL_PHASES = new Set(['ACTIVE', 'ROLLED_BACK', 'FAILED_ROLLBACK']);

function sha256(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fsyncPath(file) {
  const descriptor = openSync(file, 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function fsyncDirectory(directory) {
  try {
    fsyncPath(directory);
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error?.code)) throw error;
  }
}

function writeAtomic(file, content, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  fsyncPath(temporary);
  renameSync(temporary, file);
  chmodSync(file, mode);
  fsyncDirectory(dirname(file));
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function transactionPaths(userData) {
  const root = resolve(userData, 'helix', 'deployment');
  return {
    root,
    lock: resolve(root, 'deployment.lock'),
    backtestLock: resolve(root, 'backtest.lock'),
    entryTransitionLock: resolve(root, 'entry-transition.lock'),
    emergency: resolve(root, 'emergency-stop.json'),
    journal: resolve(root, 'transaction.json'),
    backups: resolve(root, 'backups'),
  };
}

export function setEmergencyStopLatch(userData) {
  const { emergency } = transactionPaths(userData);
  writeAtomic(emergency, `${JSON.stringify({ id: randomUUID(), pid: process.pid, createdAt: Date.now() })}\n`);
  return emergency;
}

export function clearEmergencyStopLatch(userData) {
  const { emergency, root } = transactionPaths(userData);
  const claimed = `${emergency}.clear.${process.pid}.${randomUUID()}`;
  try {
    renameSync(emergency, claimed);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const claimPrefix = `${basename(emergency)}.clear.`;
  let claims = [];
  try {
    claims = readdirSync(root)
      .filter((name) => name.startsWith(claimPrefix))
      .map((name) => resolve(root, name));
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const claim of claims) {
    let latch;
    try {
      latch = readJson(claim);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(`emergency stop claim is invalid: ${claim}`);
    }
    if (latch?.pid !== process.pid && processIsAlive(latch?.pid)) {
      throw new Error(`emergency stop is still in progress (pid ${latch.pid})`);
    }
    try { unlinkSync(claim); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  fsyncDirectory(root);
}

export function emergencyStopIsLatched(userData) {
  const { emergency, root } = transactionPaths(userData);
  if (existsSync(emergency)) return true;
  try {
    const claimPrefix = `${basename(emergency)}.clear.`;
    return readdirSync(root).some((name) => name.startsWith(claimPrefix));
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export function requireNoEmergencyStop(userData) {
  if (emergencyStopIsLatched(userData)) {
    throw new Error('deployment aborted by emergency stop latch');
  }
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

export function signalArtifactArchivePath(userData, artifactHash) {
  if (typeof artifactHash !== 'string' || !ARTIFACT_HASH_PATTERN.test(artifactHash)) {
    throw new Error('signal_artifact_hash must be a SHA-256 hash');
  }
  return resolve(userData, 'helix', 'signals', `${artifactHash.replace(':', '-')}.json`);
}

async function withProcessLock(lockPath, lockName, operation, waitMs, callback) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const lockId = randomUUID();
  const owner = { id: lockId, pid: process.pid, operation, createdAt: Date.now() };
  const candidate = `${lockPath}.candidate.${process.pid}.${lockId}`;
  writeAtomic(candidate, `${JSON.stringify(owner)}\n`);
  const deadline = Date.now() + waitMs;
  let acquired = false;
  let result;
  let primaryError = null;

  try {
    while (!acquired) {
      try {
        linkSync(candidate, lockPath);
        acquired = true;
        fsyncDirectory(dirname(lockPath));
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        let lockStat;
        try { lockStat = statSync(lockPath); } catch (statError) {
          if (statError?.code === 'ENOENT') continue;
          throw statError;
        }
        const legacyDirectory = lockStat.isDirectory();
        const ownerFile = legacyDirectory ? resolve(lockPath, 'owner.json') : lockPath;
        let currentOwner = null;
        try {
          currentOwner = readJson(ownerFile);
        } catch (ownerError) {
          if (ownerError?.code === 'ENOENT' && !existsSync(lockPath)) continue;
        }
        const liveOwner = processIsAlive(currentOwner?.pid);
        const initializingLegacyLock = legacyDirectory && !currentOwner && Date.now() - lockStat.mtimeMs < 5_000;
        if (liveOwner || initializingLegacyLock) {
          if (Date.now() < deadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 50));
            continue;
          }
          if (liveOwner) {
            throw new Error(`${lockName} is locked by ${currentOwner?.operation || 'another operation'} (pid ${currentOwner.pid})`);
          }
          throw new Error(`${lockName} lock is still being initialized`);
        }
        if (!currentOwner && !legacyDirectory) {
          throw new Error(`${lockName} lock owner metadata is invalid`);
        }
        throw new Error(`${lockName} has a stale lock from pid ${currentOwner?.pid || 'unknown'}; remove it after verifying no operation is active`);
      }
    }
    unlinkSync(candidate);
    result = await callback();
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  if (acquired) {
    try {
      const current = readJson(lockPath);
      if (current.id === lockId) {
        unlinkSync(lockPath);
        fsyncDirectory(dirname(lockPath));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') cleanupError = error;
    }
  }
  try { unlinkSync(candidate); } catch (error) {
    if (error?.code !== 'ENOENT' && !cleanupError) cleanupError = error;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError(
      [primaryError, cleanupError],
      `${primaryError.message}; ${lockName} lock cleanup failed: ${cleanupError.message}`,
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

export function withDeploymentLock(userData, operation, callback, waitMs = 0) {
  return withProcessLock(transactionPaths(userData).lock, 'deployment', operation, waitMs, callback);
}

export function withBacktestLock(userData, operation, callback) {
  return withProcessLock(transactionPaths(userData).backtestLock, 'backtest', operation, 0, callback);
}

export function withEntryTransitionLock(userData, operation, callback) {
  return withProcessLock(transactionPaths(userData).entryTransitionLock, 'entry transition', operation, 15_000, callback);
}

export function readDeploymentTransaction(userData) {
  const { journal } = transactionPaths(userData);
  if (!existsSync(journal)) return null;
  const value = readJson(journal);
  if (value?.version !== TRANSACTION_VERSION || typeof value.id !== 'string' || typeof value.phase !== 'string') {
    throw new Error('deployment transaction journal is invalid');
  }
  return value;
}

export function beginDeploymentTransaction(userData, { operation, files, previous, target }) {
  const paths = transactionPaths(userData);
  mkdirSync(paths.backups, { recursive: true });
  const id = randomUUID();
  const captured = files.map((file, index) => {
    const absolute = resolve(file);
    const existed = existsSync(absolute);
    const backup = resolve(paths.backups, `${id}-${index}-${basename(absolute)}.bak`);
    const content = existed ? readFileSync(absolute) : null;
    return {
      content,
      snapshot: {
        file: absolute,
        existed,
        backup: existed ? backup : null,
        hash: content ? sha256(content) : null,
        mode: existed ? statSync(absolute).mode & 0o777 : null,
      },
    };
  });
  let transaction = {
    version: TRANSACTION_VERSION,
    id,
    operation,
    phase: 'PREPARING',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    snapshots: captured.map(({ snapshot }) => snapshot),
    previous,
    target,
    error: null,
  };
  writeAtomic(paths.journal, `${JSON.stringify(transaction, null, 2)}\n`);
  for (const { content, snapshot } of captured) {
    if (content && snapshot.backup) writeAtomic(snapshot.backup, content, 0o600);
  }
  fsyncDirectory(paths.backups);
  transaction = updateDeploymentTransaction(userData, transaction, 'PREPARED');
  return transaction;
}

export function updateDeploymentTransaction(userData, transaction, phase, error = null) {
  const paths = transactionPaths(userData);
  const current = readDeploymentTransaction(userData);
  if (!current || current.id !== transaction.id) throw new Error('deployment transaction journal changed unexpectedly');
  if (TERMINAL_PHASES.has(current.phase)) throw new Error(`deployment transaction is already ${current.phase}`);
  const updated = { ...current, phase, error, updatedAt: Date.now() };
  writeAtomic(paths.journal, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

export function restoreDeploymentFiles(transaction) {
  for (const snapshot of transaction.snapshots) {
    if (snapshot.existed) {
      if (!snapshot.backup || !existsSync(snapshot.backup)) {
        throw new Error(`deployment backup is missing for ${snapshot.file}`);
      }
      writeAtomic(snapshot.file, readFileSync(snapshot.backup), snapshot.mode ?? 0o600);
      if (sha256(readFileSync(snapshot.file)) !== snapshot.hash) {
        throw new Error(`deployment rollback hash mismatch for ${snapshot.file}`);
      }
    } else if (existsSync(snapshot.file)) {
      unlinkSync(snapshot.file);
    }
  }
}

export function cleanupDeploymentBackups(transaction) {
  for (const snapshot of transaction.snapshots) {
    if (!snapshot.backup) continue;
    try { unlinkSync(snapshot.backup); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const backupDirectory = transaction.snapshots.find((snapshot) => snapshot.backup)?.backup;
  if (backupDirectory) fsyncDirectory(dirname(backupDirectory));
}

export function writeDeploymentFile(file, content, mode = 0o600) {
  writeAtomic(resolve(file), content, mode);
  return sha256(readFileSync(resolve(file)));
}

export function deploymentFileHash(file) {
  return existsSync(file) ? sha256(readFileSync(file)) : null;
}

export function deploymentTransactionIsIncomplete(transaction) {
  return Boolean(transaction && !TERMINAL_PHASES.has(transaction.phase));
}

export function requireHealthyDeploymentTransaction(userData) {
  const transaction = readDeploymentTransaction(userData);
  if (transaction?.phase === 'FAILED_ROLLBACK') {
    throw new Error('FAILED_ROLLBACK requires operator intervention before entries can be opened');
  }
  if (deploymentTransactionIsIncomplete(transaction)) {
    throw new Error(`deployment transaction ${transaction.id} is incomplete (${transaction.phase})`);
  }
  return transaction;
}
