import assert from 'node:assert/strict';
import test from 'node:test';
import {
  conditionalOrderVariants,
  fetchConditionalOrders,
  fetchRegularOpenOrders,
} from '../../helix-account/lib/conditional-orders.mjs';

test('conditional order query matrix covers every supported exchange order family', () => {
  assert.deepEqual(conditionalOrderVariants('binance'), [{ trigger: true }]);
  assert.deepEqual(conditionalOrderVariants('bitget'), [
    { trigger: true, planType: 'normal_plan' },
    { trigger: true, planType: 'profit_loss' },
    { trailing: true, planType: 'track_plan' },
  ]);
  assert.deepEqual(conditionalOrderVariants('bybit'), [
    { orderFilter: 'StopOrder' },
    { orderFilter: 'tpslOrder' },
  ]);
  assert.deepEqual(conditionalOrderVariants('gate'), [{ trigger: true }]);
  assert.deepEqual(conditionalOrderVariants('htx'), [
    { trigger: true },
    { stopLossTakeProfit: true },
    { trailing: true },
  ]);
  assert.deepEqual(conditionalOrderVariants('okx'), [
    { ordType: 'conditional' },
    { ordType: 'oco' },
    { ordType: 'trigger' },
    { ordType: 'move_order_stop' },
    { ordType: 'iceberg' },
    { ordType: 'twap' },
  ]);
  assert.throws(() => conditionalOrderVariants('unknown'), /No complete conditional-order query matrix/);
  assert.throws(() => conditionalOrderVariants('htx', 'spot'), /not covered/);
});

test('conditional order query is fail-closed when any required family cannot be read', async () => {
  const calls = [];
  const exchange = {
    async fetchOpenOrders(_symbol, _since, _limit, params) {
      calls.push(params);
      if (params.planType === 'profit_loss') throw new Error('endpoint unavailable');
      return [];
    },
  };
  await assert.rejects(
    fetchConditionalOrders(exchange, 'bitget', undefined, 'swap'),
    /conditional-order query incomplete.*profit_loss.*endpoint unavailable/,
  );
  assert.equal(calls.length, 3);
});

test('conditional order query merges all families without collapsing ids across symbols', async () => {
  const exchange = {
    async fetchOpenOrders(_symbol, _since, _limit, params) {
      if (params.orderFilter === 'StopOrder') {
        return [
          { id: 'shared', symbol: 'BTC/USDT:USDT' },
          { id: 'trigger-only', symbol: 'BTC/USDT:USDT' },
        ];
      }
      return [
        { id: 'shared', symbol: 'BTC/USDT:USDT' },
        { id: 'shared', symbol: 'ETH/USDT:USDT' },
      ];
    },
  };
  const orders = await fetchConditionalOrders(exchange, 'bybit', undefined, 'swap');
  assert.deepEqual(orders.map((order) => `${order.symbol}|${order.id}`), [
    'BTC/USDT:USDT|shared',
    'BTC/USDT:USDT|trigger-only',
    'ETH/USDT:USDT|shared',
  ]);
});

test('open-order queries fail closed on malformed identity or a full first page', async () => {
  await assert.rejects(
    fetchConditionalOrders({
      async fetchOpenOrders() { return [{ symbol: 'BTC/USDT:USDT' }]; },
    }, 'binance', undefined, 'swap'),
    /without id\/symbol identity/,
  );

  await assert.rejects(
    fetchRegularOpenOrders({
      async fetchOpenOrders(_symbol, _since, limit) {
        return Array.from({ length: limit }, (_, index) => ({
          id: String(index), symbol: 'BTC/USDT:USDT',
        }));
      },
    }, 'bybit', undefined),
    /reached the 50-order page limit and may be truncated/,
  );
});

test('regular open-order queries use the exchange page limit and preserve identity', async () => {
  const calls = [];
  const orders = await fetchRegularOpenOrders({
    async fetchOpenOrders(symbol, since, limit) {
      calls.push({ symbol, since, limit });
      return [{ id: 'regular-1', symbol: 'ETH/USDT:USDT' }];
    },
  }, 'okx', 'ETH/USDT:USDT');
  assert.deepEqual(calls, [{ symbol: 'ETH/USDT:USDT', since: undefined, limit: 100 }]);
  assert.deepEqual(orders, [{ id: 'regular-1', symbol: 'ETH/USDT:USDT' }]);
});
