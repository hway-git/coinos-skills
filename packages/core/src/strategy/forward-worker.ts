import { isDeepStrictEqual } from 'node:util'
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
} from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  StrategyHistoricalDataset,
  StrategyRepositorySnapshot,
  StrategySignalBatch,
} from '@helix/contracts/strategy'
import {
  assertStrategyForwardDeployment,
  assertStrategyForwardDataset,
  requireCurrentStrategyForwardDeployment,
  strategyForwardFirstDecisionTime,
  type StrategyForwardDeployment,
} from './forward-runtime'
import {
  assertStrategyForwardCheckpoint,
  compactStrategyForwardDataset,
  mergeStrategyForwardDatasets,
  StrategyForwardSession,
  type StrategyForwardCheckpoint,
} from './forward-session'
import { assertStrategyHistoricalDataset } from './historical-dataset'
import { fetchOkxHistoricalDataset } from './okx-historical'
import { loadStrategyRepositorySnapshot } from './repository'
import { assertStrategySignalBatchChain } from './signal-batch'
import { createStrategyEvaluator } from './strategy-evaluator'
import { strategyTimeframeMilliseconds } from './signal-artifact'

type FetchDataset = typeof fetchOkxHistoricalDataset

async function syncDirectory(directory: string) {
  let handle
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error
  } finally {
    await handle?.close()
  }
}

export async function writeStrategyRuntimeJsonAtomic(file: string, value: unknown) {
  const destination = resolve(file)
  const directory = dirname(destination)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = `${destination}.tmp.${process.pid}`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, destination)
  await chmod(destination, 0o600)
  await syncDirectory(directory)
  return destination
}

async function readStoredBatches(directory: string) {
  let names: string[]
  try {
    names = (await readdir(directory)).filter((name) => /^[0-9]{12}-sha256-[a-f0-9]{64}\.json$/.test(name)).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(resolve(directory, name), 'utf8')) as unknown))
}

export async function reconcileStrategyForwardBatchStore(
  deployment: StrategyForwardDeployment,
  expected: readonly StrategySignalBatch[],
  directory: string,
) {
  const existing = assertStrategySignalBatchChain(deployment, await readStoredBatches(directory))
  if (existing.length > expected.length) throw new Error('stored forward batch chain is ahead of deterministic replay')
  for (const [index, batch] of existing.entries()) {
    if (!isDeepStrictEqual(batch, expected[index])) {
      throw new Error(`stored forward batch differs from deterministic replay at sequence ${index}`)
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const batch of expected.slice(existing.length)) {
    const name = `${String(batch.batchSequence).padStart(12, '0')}-${batch.batchHash.replace(':', '-')}.json`
    await writeStrategyRuntimeJsonAtomic(resolve(directory, name), batch)
  }
  return { existing: existing.length, appended: expected.length - existing.length, total: expected.length }
}

export async function appendStrategyForwardBatchStore(
  deployment: StrategyForwardDeployment,
  anchor: Readonly<{
    batchCount: number
    lastBatchHash: string | null
    lastDecisionTime: number
    decisionStateHash: string | null
  }>,
  appended: readonly StrategySignalBatch[],
  directory: string,
) {
  const existing = assertStrategySignalBatchChain(deployment, await readStoredBatches(directory))
  if (!Number.isSafeInteger(anchor.batchCount) || anchor.batchCount < 0
    || (anchor.batchCount === 0) !== (anchor.lastBatchHash === null)) {
    throw new Error('forward checkpoint batch anchor is invalid')
  }
  if (existing.length < anchor.batchCount) {
    throw new Error('stored forward batch chain is behind its durable checkpoint')
  }
  if (anchor.batchCount > 0 && existing[anchor.batchCount - 1]?.batchHash !== anchor.lastBatchHash) {
    throw new Error('stored forward batch chain does not match its checkpoint anchor')
  }
  const anchorBatch = existing[anchor.batchCount - 1]
  if (anchorBatch?.signal.decisionTime === anchor.lastDecisionTime
    && anchorBatch.decisionStateHash !== anchor.decisionStateHash) {
    throw new Error('stored forward batch decision state does not match its checkpoint anchor')
  }
  if (existing.length > anchor.batchCount + appended.length) {
    throw new Error('stored forward batch chain is ahead of deterministic checkpoint replay')
  }
  for (const [offset, batch] of appended.entries()) {
    if (batch.batchSequence !== anchor.batchCount + offset) {
      throw new Error(`forward checkpoint replay batch sequence is invalid at offset ${offset}`)
    }
    const stored = existing[batch.batchSequence]
    if (stored && !isDeepStrictEqual(stored, batch)) {
      throw new Error(`stored forward batch differs from checkpoint replay at sequence ${batch.batchSequence}`)
    }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const batch of appended.slice(Math.max(0, existing.length - anchor.batchCount))) {
    const name = `${String(batch.batchSequence).padStart(12, '0')}-${batch.batchHash.replace(':', '-')}.json`
    await writeStrategyRuntimeJsonAtomic(resolve(directory, name), batch)
  }
  return {
    existing: existing.length,
    appended: anchor.batchCount + appended.length - existing.length,
    total: anchor.batchCount + appended.length,
  }
}

export type StrategyForwardWorkerStatus = {
  schemaVersion: 'helix.forward-worker-status/v1'
  deploymentHash: string
  state: 'waiting' | 'ready' | 'error'
  pid: number
  updatedAt: number
  lastDecisionTime: number | null
  lastMarketSnapshotId: string | null
  lastBatchHash: string | null
  batches: number
  error: string | null
}

export class StrategyForwardWorker {
  private session: StrategyForwardSession | null = null
  private dataset: StrategyHistoricalDataset | null = null

  constructor(
    readonly deployment: StrategyForwardDeployment,
    private readonly batchesDirectory: string,
    private readonly marketDataFile: string,
    private readonly statusFile: string,
    private readonly fetchDataset: FetchDataset = fetchOkxHistoricalDataset,
    private readonly runtime: Readonly<{
      checkpointFile?: string
      noSignalJournalFile?: string
      statusPid?: number
    }> = {},
  ) {
    if (runtime.statusPid !== undefined
      && (!Number.isSafeInteger(runtime.statusPid) || runtime.statusPid < 1)) {
      throw new Error('forward worker statusPid must be a positive safe integer')
    }
  }

  private checkpointFile() {
    return resolve(this.runtime.checkpointFile ?? resolve(dirname(this.statusFile), 'checkpoint.json'))
  }

  private noSignalJournalFile() {
    return resolve(this.runtime.noSignalJournalFile ?? resolve(dirname(this.statusFile), 'no-signal-journal.json'))
  }

  private async storedDataset() {
    try {
      const value = JSON.parse(await readFile(this.marketDataFile, 'utf8')) as unknown
      return assertStrategyForwardDataset(this.deployment, assertStrategyHistoricalDataset(value))
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  }

  private async storedCheckpoint(): Promise<StrategyForwardCheckpoint | null> {
    try {
      const value = JSON.parse(await readFile(this.checkpointFile(), 'utf8')) as unknown
      return assertStrategyForwardCheckpoint(value, this.deployment)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null
      throw error
    }
  }

  private async status(state: StrategyForwardWorkerStatus['state'], error: string | null = null) {
    const session = this.session?.state()
    const status: StrategyForwardWorkerStatus = {
      schemaVersion: 'helix.forward-worker-status/v1',
      deploymentHash: this.deployment.deploymentHash,
      state,
      pid: this.runtime.statusPid ?? process.pid,
      updatedAt: Date.now(),
      lastDecisionTime: session && session.lastDecisionTime >= 0 ? session.lastDecisionTime : null,
      lastMarketSnapshotId: session?.processedSnapshotHash ?? null,
      lastBatchHash: session?.lastBatchHash ?? null,
      batches: session?.batchCount ?? 0,
      error,
    }
    await writeStrategyRuntimeJsonAtomic(this.statusFile, status)
    return status
  }

  async fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    await this.status('error', message)
    return message
  }

  async advance(snapshot: StrategyRepositorySnapshot, now = Date.now()) {
    const manifest = requireCurrentStrategyForwardDeployment(this.deployment, snapshot)
    const evaluator = createStrategyEvaluator(manifest)
    const { duration: baseDuration } = strategyTimeframeMilliseconds(evaluator.baseTimeframe)
    const closedThrough = Math.floor(now / baseDuration) * baseDuration
    const firstDecisionTime = strategyForwardFirstDecisionTime(this.deployment)
    if (closedThrough < firstDecisionTime) return this.status('waiting')

    if (!this.session || !this.dataset) {
      this.dataset = await this.storedDataset()
      const checkpoint = await this.storedCheckpoint()
      if (checkpoint && !this.dataset) {
        throw new Error('forward checkpoint exists without its retained market data')
      }
      if (this.dataset && this.dataset.capturedThrough > closedThrough) {
        throw new Error('stored forward market data is ahead of the current closed boundary')
      }
      if (!this.dataset) {
        const startTime = Math.max(0, firstDecisionTime - evaluator.warmupDurationMs)
        this.dataset = await this.fetchDataset({
          instrumentId: this.deployment.instrumentId,
          symbol: this.deployment.symbol,
          timeframes: evaluator.requiredTimeframes,
          startTime,
          endTime: closedThrough,
        })
        await writeStrategyRuntimeJsonAtomic(this.marketDataFile, this.dataset)
      }
      this.session = new StrategyForwardSession(this.deployment, snapshot, checkpoint ?? undefined)
    }
    if (closedThrough > this.dataset.capturedThrough) {
      const largestDuration = Math.max(...evaluator.requiredTimeframes.map(
        (timeframe) => strategyTimeframeMilliseconds(timeframe).duration,
      ))
      const delta = await this.fetchDataset({
        instrumentId: this.deployment.instrumentId,
        symbol: this.deployment.symbol,
        timeframes: evaluator.requiredTimeframes,
        startTime: Math.max(0, this.dataset.capturedThrough - largestDuration),
        endTime: closedThrough,
      })
      this.dataset = mergeStrategyForwardDatasets(this.dataset, delta)
      await writeStrategyRuntimeJsonAtomic(this.marketDataFile, this.dataset)
    }

    const before = this.session.state()
    const appended = this.session.advance(snapshot, this.dataset)
    await appendStrategyForwardBatchStore(this.deployment, {
      batchCount: before.batchCount,
      lastBatchHash: before.lastBatchHash,
      lastDecisionTime: before.lastDecisionTime,
      decisionStateHash: before.decisionStateHash,
    }, appended, this.batchesDirectory)
    const after = this.session.state()
    const finalBatch = appended.at(-1)
    if (finalBatch?.signal.decisionTime === after.lastDecisionTime
      && finalBatch.decisionStateHash !== after.decisionStateHash) {
      throw new Error('forward batch decision state does not match the session checkpoint tip')
    }
    const checkpoint = this.session.checkpoint(now)
    await writeStrategyRuntimeJsonAtomic(this.checkpointFile(), checkpoint)
    await writeStrategyRuntimeJsonAtomic(this.noSignalJournalFile(), after.noSignalJournal)
    this.dataset = compactStrategyForwardDataset(
      this.dataset,
      after.lastDecisionTime,
      after.marketRetentionMsByTimeframe,
    )
    await writeStrategyRuntimeJsonAtomic(this.marketDataFile, this.dataset)
    return this.status('ready')
  }
}

export async function runStrategyForwardWorkerLoop(
  worker: Pick<StrategyForwardWorker, 'advance' | 'fail'>,
  loadSnapshot: () => Promise<StrategyRepositorySnapshot>,
  options: {
    intervalMs: number
    iterations?: number
    now?: () => number
    sleep?: (milliseconds: number) => Promise<void>
  },
) {
  const iterations = options.iterations ?? Number.POSITIVE_INFINITY
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)))
  let delay = options.intervalMs
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    await sleep(delay)
    try {
      await worker.advance(await loadSnapshot(), now())
      delay = options.intervalMs
    } catch (error) {
      await worker.fail(error)
      delay = Math.min(60_000, Math.max(options.intervalMs, delay * 2))
    }
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

async function main() {
  const args = process.argv.slice(2).filter((value) => value !== '--')
  const action = args[0]
  const params = record(JSON.parse(args[1] || '{}'), 'params')
  if (action !== 'once' && action !== 'run') {
    throw new Error('Usage: forward-worker.ts <once|run> {"deployment":"...","batches":"...","status":"..."}')
  }
  const deploymentFile = resolve(text(params.deployment, 'params.deployment'))
  const deployment = assertStrategyForwardDeployment(JSON.parse(await readFile(deploymentFile, 'utf8')))
  const worker = new StrategyForwardWorker(
    deployment,
    resolve(text(params.batches, 'params.batches')),
    resolve(text(params.marketData, 'params.marketData')),
    resolve(text(params.status, 'params.status')),
    fetchOkxHistoricalDataset,
    {
      checkpointFile: typeof params.checkpoint === 'string' ? resolve(params.checkpoint) : undefined,
      noSignalJournalFile: typeof params.noSignalJournal === 'string' ? resolve(params.noSignalJournal) : undefined,
      statusPid: params.statusPid === undefined ? undefined : Number(params.statusPid),
    },
  )
  try {
    const first = await worker.advance(await loadStrategyRepositorySnapshot())
    if (action === 'once') return first
    const { duration } = strategyTimeframeMilliseconds(deployment.strategy.baseTimeframe)
    const interval = Math.min(15_000, Math.max(1_000, Math.floor(duration / 4)))
    await runStrategyForwardWorkerLoop(worker, loadStrategyRepositorySnapshot, { intervalMs: interval })
  } catch (error) {
    await worker.fail(error)
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
    .then((result) => {
      if (result) console.log(JSON.stringify(result, null, 2))
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
