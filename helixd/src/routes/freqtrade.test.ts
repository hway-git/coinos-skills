import assert from 'node:assert/strict'
import test from 'node:test'
import type { FreqtradeReconciliationResult } from '@helix/contracts/freqtrade'
import { finalizeFreqtradeEmergencyStop } from './freqtrade'

const flatReconciliation: FreqtradeReconciliationResult = {
  status: 'matched',
  checkedAt: 1,
  botPositions: 0,
  exchangePositions: 0,
  mismatches: [],
  detail: 'flat',
}

test('emergency stop succeeds only when the operation and exchange reconciliation are flat', () => {
  const result = finalizeFreqtradeEmergencyStop({
    ok: true,
    data: {
      success: true,
      operationError: null,
      openTradesBefore: 1,
      openTradesAfter: 0,
      forceExitError: null,
      stopError: null,
      reconciliationStatus: null,
      reconciliationError: null,
      reconciliationMismatches: [],
    },
  }, flatReconciliation)
  assert.equal(result.success, true)
  assert.equal(result.reconciliationStatus, 'matched')
  assert.equal(result.reconciliationError, null)
})

test('emergency stop preserves CLI failure and exchange truth in a structured result', () => {
  const result = finalizeFreqtradeEmergencyStop(
    { ok: false, error: 'Freqtrade unavailable' },
    {
      ...flatReconciliation,
      status: 'offline',
      exchangePositions: 1,
      detail: 'bot offline; exchange state was queried',
    },
  )
  assert.equal(result.success, false)
  assert.equal(result.operationError, 'Freqtrade unavailable')
  assert.equal(result.reconciliationStatus, 'offline')
  assert.equal(result.reconciliationError, 'bot offline; exchange state was queried')
})

test('emergency stop blocks success when regular or conditional orders mismatch', () => {
  const result = finalizeFreqtradeEmergencyStop({
    ok: true,
    data: {
      success: true,
      operationError: null,
      openTradesBefore: 0,
      openTradesAfter: 0,
      forceExitError: null,
      stopError: null,
      reconciliationStatus: null,
      reconciliationError: null,
      reconciliationMismatches: [],
    },
  }, {
    ...flatReconciliation,
    status: 'mismatch',
    mismatches: [{
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      orderId: 'conditional-1',
      issue: 'external_open_order',
      botAmount: 0,
      exchangeAmount: 0,
    }],
    detail: '1 reconciliation mismatch',
  })
  assert.equal(result.success, false)
  assert.equal(result.reconciliationError, '1 reconciliation mismatch')
  assert.equal(result.reconciliationMismatches[0]?.orderId, 'conditional-1')
})

test('dry-run emergency stop still requires the live exchange account to be flat', () => {
  const result = finalizeFreqtradeEmergencyStop({
    ok: true,
    data: {
      success: true,
      operationError: null,
      openTradesBefore: 0,
      openTradesAfter: 0,
      forceExitError: null,
      stopError: null,
      reconciliationStatus: null,
      reconciliationError: null,
      reconciliationMismatches: [],
    },
  }, {
    status: 'not_applicable',
    checkedAt: 1,
    botPositions: 0,
    exchangePositions: 1,
    mismatches: [{
      symbol: 'BTC/USDT:USDT',
      side: 'long',
      issue: 'exchange_position_unattributed_in_dry_run',
      botAmount: 0,
      exchangeAmount: 0.1,
    }],
    detail: 'DRY_RUN live account is not flat',
  })
  assert.equal(result.success, false)
  assert.equal(result.reconciliationError, 'DRY_RUN live account is not flat')
})
