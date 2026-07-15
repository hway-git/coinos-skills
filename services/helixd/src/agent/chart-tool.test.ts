import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveChartAnnotations } from './chart-tool'

const evidence = [{
  ref: 'strategy.setup.15m',
  value: JSON.stringify({
    direction: 'short',
    signalBar: { time: 1000, high: 102, low: 98 },
    invalidation: { price: 103 },
  }),
}]

test('chart annotations resolve coordinates only from existing evidence', () => {
  const annotations = resolveChartAnnotations([
    { type: 'marker', evidenceRef: 'strategy.setup.15m', text: 'L2' },
    { type: 'price-line', evidenceRef: 'strategy.setup.15m', text: '失效', value: 'invalidation' },
  ], evidence, '15m')
  assert.deepEqual(annotations, [
    { type: 'marker', evidenceRef: 'strategy.setup.15m', text: 'L2', time: 1000, direction: 'short' },
    { type: 'price-line', evidenceRef: 'strategy.setup.15m', text: '失效', price: 103 },
  ])
  assert.throws(() => resolveChartAnnotations([
    { type: 'marker', evidenceRef: 'strategy.setup.15m', text: 'L2' },
  ], evidence, '5m'), /TIMEFRAME_MISMATCH/)
  assert.throws(() => resolveChartAnnotations([
    { type: 'marker', evidenceRef: 'missing', text: 'fake' },
  ], evidence, '15m'), /UNKNOWN_EVIDENCE_REF/)
})
