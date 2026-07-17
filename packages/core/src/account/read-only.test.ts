import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeAccountOrderRows, normalizeAccountReconciliationOrders } from './read-only'

test('reconciliation includes and deduplicates regular and conditional exchange orders', () => {
  assert.deepEqual(
    normalizeAccountReconciliationOrders(
      [
        { id: 'regular-1', symbol: 'btc/usdt:usdt', side: 'BUY' },
        { id: 'shared-1', symbol: 'eth/usdt:usdt', side: 'sell' },
      ],
      [
        { id: 'stop-1', symbol: 'xrp/usdt:usdt', side: 'SELL' },
        { id: 'shared-1', symbol: 'eth/usdt:usdt', side: 'sell' },
        { symbol: 'missing-id', side: 'buy' },
      ],
    ),
    [
      { id: 'regular-1', symbol: 'BTC/USDT:USDT', side: 'buy' },
      { id: 'shared-1', symbol: 'ETH/USDT:USDT', side: 'sell' },
      { id: 'stop-1', symbol: 'XRP/USDT:USDT', side: 'sell' },
    ],
  )
})

test('account snapshot displays conditional orders and deduplicates overlapping endpoints', () => {
  assert.deepEqual(
    mergeAccountOrderRows(
      [{ id: 'regular-1', symbol: 'BTC/USDT:USDT', type: 'limit', side: 'buy', price: 100, status: 'open' }],
      [
        { id: 'regular-1', symbol: 'BTC/USDT:USDT', type: 'limit', side: 'buy', price: 100, status: 'open' },
        { id: 'stop-1', symbol: 'ETH/USDT:USDT', type: 'market', side: 'sell', status: 'open' },
      ],
    ),
    [
      { id: 'regular-1', symbol: 'BTC/USDT:USDT', type: 'conditional/limit', side: 'buy', price: '100', status: 'open' },
      { id: 'stop-1', symbol: 'ETH/USDT:USDT', type: 'conditional/market', side: 'sell', price: '--', status: 'open' },
    ],
  )
})
