import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const testRoot = mkdtempSync(join(tmpdir(), 'helix-agent-story-'))
process.env.HELIX_DATABASE_PATH = join(testRoot, 'helix.sqlite')

test('persists revisions while keeping an existing scenario thesis immutable', async () => {
  const { readMarketStory, writeMarketStory } = await import('./story-store')
  const scope = { symbol: 'btc/usdt', timeframe: '15M' }
  const first = writeMarketStory(scope, {
    summary: 'BTC is consolidating under resistance.',
    changeSummary: 'Initial story.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
    scenarios: [{
      role: 'primary',
      thesis: 'Consolidation continues.',
      expectation: 'Wait for a directional break.',
      state: 'watching',
      waitingFor: 'A closed-bar breakout.',
      invalidation: 'A decisive break in either direction.',
      evidenceRefs: ['signal.status'],
    }],
  })

  const scenario = first.scenarios[0]
  const second = writeMarketStory(scope, {
    summary: 'The same scenario is now armed.',
    changeSummary: 'Evidence aligned with the scenario.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
    scenarios: [{
      id: scenario.id,
      role: scenario.role,
      thesis: scenario.thesis,
      expectation: scenario.expectation,
      state: 'armed',
      waitingFor: 'A confirming trigger.',
      invalidation: scenario.invalidation,
      evidenceRefs: ['signal.status', 'signal.bias'],
    }],
  })

  assert.equal(second.revision, 2)
  assert.equal(second.scenarios[0].id, first.scenarios[0].id)
  assert.equal(second.scenarios[0].state, 'armed')
  assert.deepEqual(readMarketStory({ symbol: 'BTC/USDT', timeframe: '15m' }), second)

  assert.throws(() => writeMarketStory(scope, {
    summary: 'Invalid rewrite.',
    changeSummary: 'Tried to replace the thesis.',
    analysisSource: 'test-analyzer',
    strategyVersion: 'test-analyzer/v1',
    scenarios: [{
      id: second.scenarios[0].id,
      role: 'primary',
      thesis: 'A different thesis.',
      expectation: second.scenarios[0].expectation,
      state: second.scenarios[0].state,
      waitingFor: second.scenarios[0].waitingFor,
      invalidation: second.scenarios[0].invalidation,
      evidenceRefs: second.scenarios[0].evidenceRefs,
    }],
  }), /SCENARIO_THESIS_IMMUTABLE/)
})
