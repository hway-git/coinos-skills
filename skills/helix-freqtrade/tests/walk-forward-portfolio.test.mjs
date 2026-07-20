import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  loadPromotableWalkForwardPortfolioReport,
  verifyWalkForwardEvidenceReportFile,
  verifyWalkForwardPortfolioReport,
  walkForwardPortfolioPlanHash,
} from '../lib/walk-forward-portfolio.mjs';
import { walkForwardReportHash } from '../lib/walk-forward.mjs';
import { createPromotableWalkForwardReport } from './helpers/promotable-report.mjs';

const execFileAsync = promisify(execFile);
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOY = resolve(SKILL_DIR, 'scripts', 'ft-deploy.mjs');
const SOURCES = [
  { provider: 'okx', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' },
  { provider: 'okx', market: 'futures', instrumentId: 'ETH-USDT-SWAP', symbol: 'ETH/USDT:USDT' },
];

function artifact(symbol) {
  return {
    identity: {
      strategyId: 'helix_scalp_hunter',
      strategyVersion: '1.0.3',
      strategyRepoCommit: 'a'.repeat(40),
      strategyConfigHash: `sha256:${'b'.repeat(64)}`,
      engineCommit: 'c'.repeat(40),
      marketDataSnapshotId: `fixture-${symbol}`,
    },
    strategyLifecycle: 'proposal',
    objectModel: 'PRICE_EVENT',
    symbol,
    baseTimeframe: '1m',
  };
}

function portfolioPlan(memberReports) {
  const reference = memberReports[0].bundle.plan;
  const bySymbol = new Map(memberReports.map((member) => [member.bundle.plan.sourceDataset.source.symbol, member]));
  const payload = {
    schemaVersion: 'helix.walk-forward-portfolio-plan/v1',
    mode: 'fixed_candidate_multi_symbol',
    candidate: reference.candidate,
    walkForwardPolicy: reference.walkForwardPolicy,
    members: reference.walkForwardPolicy.gates.symbolStability.members.map((source) => {
      const member = bySymbol.get(source.symbol);
      return {
        source,
        sourceDatasetHash: member.bundle.plan.sourceDataset.datasetHash,
        capturedThrough: member.bundle.plan.sourceDataset.capturedThrough,
        planHash: member.bundle.plan.planHash,
        runHash: member.bundle.run.runHash,
      };
    }),
    baseTimeframe: reference.baseTimeframe,
    requiredTimeframes: reference.requiredTimeframes,
    activationDecisionTime: reference.activationDecisionTime,
    warmupDurationMs: reference.warmupDurationMs,
    folds: reference.folds,
    executionScenarios: reference.executionScenarios,
  };
  return { ...payload, planHash: walkForwardPortfolioPlanHash(payload) };
}

async function createMemberReports(root, options = {}) {
  return Promise.all(SOURCES.map((source, index) => createPromotableWalkForwardReport(
    join(root, `source-${index}`),
    artifact(source.symbol),
    {
      source,
      symbolStabilityMembers: SOURCES,
      minimumStableSymbolRatio: options.minimumStableSymbolRatio ?? 1,
      ...(index === 1 ? options.secondMember : {}),
    },
  )));
}

async function runPortfolio(root, planFile, reports, output = 'portfolio') {
  const { stdout } = await execFileAsync(process.execPath, [
    DEPLOY,
    'walk_forward_portfolio',
    JSON.stringify({
      portfolio_plan: planFile,
      reports,
      output_directory: join(root, output),
    }),
  ], {
    cwd: SKILL_DIR,
    env: { ...process.env, HOME: root, HELIX_FREQTRADE_RUNTIME: '' },
  });
  return JSON.parse(stdout);
}

async function convertMemberArchiveToLegacy(portfolioRoot, member, index) {
  const currentFile = resolve(portfolioRoot, member.reportFile);
  const working = join(portfolioRoot, `legacy-member-${index}`);
  await cp(dirname(currentFile), working, { recursive: true });
  const report = JSON.parse(await readFile(currentFile, 'utf8'));
  report.schemaVersion = 'helix.walk-forward-report/v3';
  for (const fold of report.folds) {
    for (const evidence of fold.executionEvidence) {
      const runtime = JSON.parse(await readFile(join(working, evidence.runtimeEvidenceFile), 'utf8'));
      runtime.schemaVersion = 'helix.freqtrade-execution-runtime/v2';
      delete runtime.futuresCostDataset;
      const runtimeContent = `${JSON.stringify(runtime, null, 2)}\n`;
      const runtimeHash = `sha256:${createHash('sha256').update(runtimeContent).digest('hex')}`;
      const runtimeFile = `evidence/${runtimeHash.replace(':', '-')}.runtime.json`;
      await writeFile(join(working, runtimeFile), runtimeContent);
      evidence.runtimeEvidenceFile = runtimeFile;
      evidence.runtimeEvidenceHash = runtimeHash;
      delete evidence.futuresCostDataset;
      delete evidence.futuresCostDatasetFile;
      delete evidence.futuresCostDatasetFileHash;
      delete evidence.fundingObservations;
    }
  }
  delete report.aggregate.executionEnvironment;
  report.gate.checks = report.gate.checks.filter(({ code }) => ![
    'FUTURES_COST_DATA_COMPLETE',
    'FUNDING_COST_RECONCILED',
  ].includes(code));
  report.gate.ok = report.gate.checks.every(({ ok }) => ok);
  const { reportHash: _currentHash, ...payload } = report;
  report.reportHash = walkForwardReportHash(payload);
  const reportDirectory = `members/${report.reportHash.replace(':', '-')}`;
  const reportFile = `${reportDirectory}/walk-forward-report-${report.reportHash.replace(':', '-')}.json`;
  await cp(working, resolve(portfolioRoot, reportDirectory), { recursive: true });
  await writeFile(resolve(portfolioRoot, reportFile), `${JSON.stringify(report, null, 2)}\n`);
  await rm(working, { recursive: true, force: true });
  return { ...member, reportHash: report.reportHash, reportFile };
}

test('archives verified member reports and builds a promotable cross-symbol report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helix-walk-forward-portfolio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const members = await createMemberReports(root);
  const plan = portfolioPlan(members);
  const planFile = join(root, 'portfolio-plan-source.json');
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);

  const result = await runPortfolio(
    root,
    planFile,
    members.map(({ reportFile }) => reportFile).reverse(),
  );
  assert.equal(result.promotable, true);
  assert.deepEqual(result.symbols, SOURCES.map(({ symbol }) => symbol));
  const report = verifyWalkForwardPortfolioReport(
    JSON.parse(await readFile(result.reportFile, 'utf8')),
    dirname(result.reportFile),
  );
  assert.equal(report.aggregate.scenarios[0].pooled.observations.length, 2);
  assert.deepEqual(
    report.aggregate.scenarios[0].pooled.observations.map(({ symbol, entrySignalId }) => (
      [symbol, entrySignalId]
    )),
    [
      ['BTC/USDT:USDT', 'fixture-entry'],
      ['ETH/USDT:USDT', 'fixture-entry'],
    ],
  );
  assert.equal(report.aggregate.scenarios[0].worstSymbolDrawdownR, 0);
  assert.equal(Object.hasOwn(report.aggregate.scenarios[0].pooled, 'maxDrawdownR'), false);

  const loaded = loadPromotableWalkForwardPortfolioReport(result.reportFile, artifact('BTC/USDT:USDT'));
  assert.equal(loaded.report.reportHash, result.reportHash);
  assert.throws(
    () => loadPromotableWalkForwardPortfolioReport(result.reportFile, {
      ...artifact('BTC/USDT:USDT'), baseTimeframe: '5m',
    }),
    /base timeframe does not match/,
  );
  assert.throws(
    () => loadPromotableWalkForwardPortfolioReport(result.reportFile, artifact('XRP/USDT:USDT')),
    /outside the walk-forward portfolio policy universe/,
  );

  const repeated = await runPortfolio(
    root,
    planFile,
    members.map(({ reportFile }) => reportFile),
  );
  assert.equal(repeated.reportHash, result.reportHash);

  await assert.rejects(
    runPortfolio(root, planFile, [members[0].reportFile, members[0].reportFile], 'duplicates'),
    /duplicate symbols/,
  );

  const archivedMemberFile = resolve(dirname(result.reportFile), report.members[0].reportFile);
  const archivedMember = JSON.parse(await readFile(archivedMemberFile, 'utf8'));
  const resultEvidenceFile = resolve(
    dirname(archivedMemberFile),
    archivedMember.folds[0].executionEvidence[0].resultFile,
  );
  const archiveFiles = verifyWalkForwardEvidenceReportFile(result.reportFile).archiveFiles;
  assert.equal(archiveFiles.includes(resolve(dirname(result.reportFile), report.portfolioPlanFile)), true);
  assert.equal(archiveFiles.includes(archivedMemberFile), true);
  assert.equal(archiveFiles.includes(resolve(
    dirname(archivedMemberFile), archivedMember.coreEvidence.files[0].file,
  )), true);
  assert.equal(archiveFiles.includes(resultEvidenceFile), true);
  assert.equal(archiveFiles.includes(resolve(
    dirname(archivedMemberFile), archivedMember.folds[0].executionEvidence[0].futuresCostDatasetFile,
  )), true);
  const originalEvidence = await readFile(resultEvidenceFile);
  await writeFile(resultEvidenceFile, 'tampered\n');
  assert.throws(
    () => verifyWalkForwardPortfolioReport(report, dirname(result.reportFile)),
    /execution archive hash mismatch/,
  );
  await writeFile(resultEvidenceFile, originalEvidence);
  await rm(resolve(dirname(archivedMemberFile), archivedMember.coreEvidence.files[0].file));
  assert.throws(
    () => verifyWalkForwardPortfolioReport(report, dirname(result.reportFile)),
    /cannot read walk-forward report evidence/,
  );
});

test('fully rebuilds legacy portfolio reports for audit but never accepts them for deployment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helix-walk-forward-portfolio-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const members = await createMemberReports(root);
  const plan = portfolioPlan(members);
  const planFile = join(root, 'portfolio-plan-source.json');
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const result = await runPortfolio(root, planFile, members.map(({ reportFile }) => reportFile));
  const portfolioRoot = dirname(result.reportFile);
  const current = JSON.parse(await readFile(result.reportFile, 'utf8'));
  const legacy = structuredClone(current);
  legacy.schemaVersion = 'helix.walk-forward-portfolio-report/v1';
  legacy.members = await Promise.all(current.members.map(
    (member, index) => convertMemberArchiveToLegacy(portfolioRoot, member, index),
  ));
  delete legacy.aggregate.executionEnvironment.leverageTiersHash;
  const environmentCheck = legacy.gate.checks.find(({ code }) => code === 'EXECUTION_ENVIRONMENT_MATCH');
  delete environmentCheck.actual.leverageTiersHash;
  delete environmentCheck.required.leverageTiersHash;
  const { reportHash: _currentHash, ...payload } = legacy;
  legacy.reportHash = walkForwardReportHash(payload);
  const legacyFile = join(
    portfolioRoot,
    `walk-forward-portfolio-report-${legacy.reportHash.replace(':', '-')}.json`,
  );
  await writeFile(legacyFile, `${JSON.stringify(legacy, null, 2)}\n`);
  assert.deepEqual(verifyWalkForwardPortfolioReport(legacy, portfolioRoot), legacy);

  const forged = structuredClone(legacy);
  forged.aggregate.stableSymbolRatio = 0;
  const { reportHash: _legacyHash, ...forgedPayload } = forged;
  forged.reportHash = walkForwardReportHash(forgedPayload);
  assert.throws(
    () => verifyWalkForwardPortfolioReport(forged, portfolioRoot),
    /does not match its verified member archives/,
  );
  const mislabeled = structuredClone(legacy);
  mislabeled.schemaVersion = 'helix.walk-forward-portfolio-report/v2';
  const { reportHash: _mislabeledHash, ...mislabeledPayload } = mislabeled;
  mislabeled.reportHash = walkForwardReportHash(mislabeledPayload);
  assert.throws(
    () => verifyWalkForwardPortfolioReport(mislabeled, portfolioRoot),
    /schema does not match its member report schemas/,
  );
  assert.throws(
    () => loadPromotableWalkForwardPortfolioReport(legacyFile, artifact('BTC/USDT:USDT')),
    /legacy walk-forward portfolio reports cannot authorize deployment/,
  );
});

test('rejects member reports built with different leverage tier snapshots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helix-walk-forward-portfolio-tiers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const members = await createMemberReports(root, { secondMember: { maxLeverage: 10 } });
  const plan = portfolioPlan(members);
  const planFile = join(root, 'portfolio-plan-source.json');
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  await assert.rejects(
    runPortfolio(root, planFile, members.map(({ reportFile }) => reportFile)),
    (error) => {
      assert.match(error.stderr, /one Freqtrade version, adapter, execution config, and leverage tiers snapshot/);
      return true;
    },
  );
});

test('deployment binding rejects a target member with the wrong forward source identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helix-walk-forward-portfolio-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [
    { provider: 'binance', market: 'futures', instrumentId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT' },
    { provider: 'okx', market: 'swap', instrumentId: 'ETH-USDT-SWAP', symbol: 'ETH/USDT:USDT' },
    { provider: 'okx', market: 'futures', instrumentId: 'XRP-USDT-PERP', symbol: 'XRP/USDT:USDT' },
  ];
  const members = await Promise.all(sources.map((source, index) => createPromotableWalkForwardReport(
    join(root, `source-${index}`),
    artifact(source.symbol),
    { source, symbolStabilityMembers: sources, minimumStableSymbolRatio: 1 },
  )));
  const plan = portfolioPlan(members);
  const planFile = join(root, 'portfolio-plan-source.json');
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const result = await runPortfolio(root, planFile, members.map(({ reportFile }) => reportFile));
  assert.equal(result.promotable, true);
  for (const [symbol, field] of [
    ['BTC/USDT:USDT', 'provider'],
    ['ETH/USDT:USDT', 'market'],
    ['XRP/USDT:USDT', 'instrumentId'],
  ]) {
    assert.throws(
      () => loadPromotableWalkForwardPortfolioReport(result.reportFile, artifact(symbol)),
      new RegExp(`source ${field} does not match`),
    );
  }
});

test('a strong symbol cannot hide a weak member behind pooled trade count', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helix-walk-forward-portfolio-weak-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const members = await createMemberReports(root, {
    minimumStableSymbolRatio: 1,
    secondMember: {
      baseProfitRatio: -0.2,
      stressedProfitRatio: -0.2,
      expectStable: false,
    },
  });
  const plan = portfolioPlan(members);
  const planFile = join(root, 'portfolio-plan-source.json');
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);

  const result = await runPortfolio(root, planFile, members.map(({ reportFile }) => reportFile));
  assert.equal(result.promotable, false);
  const report = JSON.parse(await readFile(result.reportFile, 'utf8'));
  assert.equal(report.members[0].stable, true);
  assert.equal(report.members[1].stable, false);
  assert.equal(
    report.gate.checks.find(({ code }) => code === 'SYMBOL_STABILITY_GATE_SATISFIED').ok,
    false,
  );
  assert.equal(
    report.gate.checks.find(({ code }) => code === 'MINIMUM_EXPECTANCY_R').ok,
    false,
  );
});

test('a passing two-of-three portfolio cannot deploy its unstable member symbol', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'helix-walk-forward-portfolio-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = [
    ...SOURCES,
    { provider: 'okx', market: 'futures', instrumentId: 'XRP-USDT-SWAP', symbol: 'XRP/USDT:USDT' },
  ];
  const members = await Promise.all(sources.map((source, index) => createPromotableWalkForwardReport(
    join(root, `source-${index}`),
    artifact(source.symbol),
    {
      source,
      symbolStabilityMembers: sources,
      minimumStableSymbolRatio: 2 / 3,
      ...(index === 2 ? {
        baseProfitRatio: -0.02,
        stressedProfitRatio: -0.02,
        expectStable: false,
      } : {}),
    },
  )));
  const plan = portfolioPlan(members);
  const planFile = join(root, 'portfolio-plan-source.json');
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  const result = await runPortfolio(root, planFile, members.map(({ reportFile }) => reportFile));
  assert.equal(result.promotable, true);
  const report = JSON.parse(await readFile(result.reportFile, 'utf8'));
  assert.deepEqual(report.members.map(({ stable }) => stable), [true, true, false]);
  assert.equal(
    report.gate.checks.find(({ code }) => code === 'SEGMENT_STABILITY').ok,
    true,
  );
  assert.equal(
    report.gate.checks.find(({ code }) => code === 'SYMBOL_STABILITY_GATE_SATISFIED').ok,
    true,
  );
  assert.equal(
    loadPromotableWalkForwardPortfolioReport(result.reportFile, artifact('BTC/USDT:USDT')).member.stable,
    true,
  );
  assert.throws(
    () => loadPromotableWalkForwardPortfolioReport(result.reportFile, artifact('XRP/USDT:USDT')),
    /did not pass its single-symbol walk-forward gates/,
  );
});
