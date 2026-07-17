const QUERY_VARIANTS = Object.freeze({
  binance: [{ trigger: true }],
  bitget: [
    { trigger: true, planType: 'normal_plan' },
    { trigger: true, planType: 'profit_loss' },
    { trailing: true, planType: 'track_plan' },
  ],
  bybit: [
    { orderFilter: 'StopOrder' },
    { orderFilter: 'tpslOrder' },
  ],
  gate: [{ trigger: true }],
  htx: [
    { trigger: true },
    { stopLossTakeProfit: true },
    { trailing: true },
  ],
  okx: [
    { ordType: 'conditional' },
    { ordType: 'oco' },
    { ordType: 'trigger' },
    { ordType: 'move_order_stop' },
    { ordType: 'iceberg' },
    { ordType: 'twap' },
  ],
});

const OPEN_ORDER_PAGE_LIMITS = Object.freeze({
  binance: 100,
  bitget: 100,
  bybit: 50,
  gate: 100,
  htx: 100,
  okx: 100,
});

function openOrderPageLimit(exchange) {
  const limit = OPEN_ORDER_PAGE_LIMITS[exchange];
  if (!limit) throw new Error(`No open-order page limit contract for ${exchange}`);
  return limit;
}

function validateOpenOrderPage(orders, exchange, limit) {
  if (!Array.isArray(orders)) throw new Error('exchange returned a non-array order list');
  if (orders.length >= limit) {
    throw new Error(`${exchange} open-order result reached the ${limit}-order page limit and may be truncated`);
  }
  for (const order of orders) {
    if (!order || order.id == null || !order.symbol) {
      throw new Error('exchange returned an open order without id/symbol identity');
    }
  }
  return orders;
}

export function conditionalOrderVariants(exchange, marketType = 'swap') {
  if (exchange === 'htx' && marketType === 'spot') {
    throw new Error('HTX spot conditional orders are not covered by the current CCXT query contract');
  }
  const variants = QUERY_VARIANTS[exchange];
  if (!variants) throw new Error(`No complete conditional-order query matrix for ${exchange}`);
  return variants.map((variant) => ({ ...variant }));
}

export async function fetchConditionalOrders(ex, exchange, symbol, marketType = 'swap') {
  const seen = new Map();
  const failures = [];
  const limit = openOrderPageLimit(exchange);
  for (const params of conditionalOrderVariants(exchange, marketType)) {
    try {
      const orders = validateOpenOrderPage(
        await ex.fetchOpenOrders(symbol, undefined, limit, params),
        exchange,
        limit,
      );
      for (const order of orders) {
        seen.set(`${String(order.symbol || '')}|${String(order.id)}`, order);
      }
    } catch (error) {
      failures.push(`${JSON.stringify(params)}: ${String(error?.message || error).slice(0, 160)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`conditional-order query incomplete: ${failures.join(' | ')}`);
  }
  return [...seen.values()];
}

export async function fetchRegularOpenOrders(ex, exchange, symbol) {
  const limit = openOrderPageLimit(exchange);
  return validateOpenOrderPage(
    await ex.fetchOpenOrders(symbol, undefined, limit),
    exchange,
    limit,
  );
}
