import type { FreqtradeReconciliationResult } from '@helix/contracts/freqtrade'
import { getAccountReconciliationState } from '../account/read-only'
import { getFreqtradeReconciliationState } from './read-only'

function positionKey(symbol: string, side: string) {
  return `${symbol.toUpperCase()}|${side.toLowerCase()}`
}

function orderKey(symbol: string, id: string) {
  return `${symbol.toUpperCase()}|${id}`
}

export async function reconcileFreqtradeAccount(): Promise<FreqtradeReconciliationResult> {
  const checkedAt = Date.now()
  const [bot, account] = await Promise.all([
    getFreqtradeReconciliationState(),
    getAccountReconciliationState(),
  ])
  if (!bot.ok || !bot.data.online) {
    const mismatches: FreqtradeReconciliationResult['mismatches'] = account.ok
      ? [
        ...account.data.positions.map((position) => ({
          symbol: position.symbol,
          side: position.side,
          issue: 'exchange_position_unattributed_while_bot_offline',
          botAmount: 0,
          exchangeAmount: position.baseAmount,
        })),
        ...account.data.openOrders.map((order) => ({
          symbol: order.symbol,
          side: order.side,
          orderId: order.id,
          issue: 'exchange_open_order_unattributed_while_bot_offline',
          botAmount: 0,
          exchangeAmount: 0,
        })),
      ]
      : []
    const botDetail = bot.ok ? 'Freqtrade daemon offline' : bot.error
    return {
      status: 'offline',
      checkedAt,
      botPositions: 0,
      exchangePositions: account.ok ? account.data.positions.length : 0,
      mismatches,
      detail: account.ok ? `${botDetail}; exchange state was queried.` : `${botDetail}; exchange query failed: ${account.error}`,
    }
  }
  if (bot.data.dryRun !== false) {
    if (!account.ok) {
      return {
        status: 'offline',
        checkedAt,
        botPositions: bot.data.positions.length,
        exchangePositions: 0,
        mismatches: [],
        detail: `DRY_RUN exchange query failed: ${account.error}`,
      }
    }
    const mismatches: FreqtradeReconciliationResult['mismatches'] = [
      ...account.data.positions.map((position) => ({
        symbol: position.symbol,
        side: position.side,
        issue: 'exchange_position_unattributed_in_dry_run',
        botAmount: 0,
        exchangeAmount: position.baseAmount,
      })),
      ...account.data.openOrders.map((order) => ({
        symbol: order.symbol,
        side: order.side,
        orderId: order.id,
        issue: 'exchange_open_order_unattributed_in_dry_run',
        botAmount: 0,
        exchangeAmount: 0,
      })),
    ]
    return {
      status: mismatches.length > 0 ? 'mismatch' : 'not_applicable',
      checkedAt,
      botPositions: bot.data.positions.length,
      exchangePositions: account.data.positions.length,
      mismatches,
      detail: mismatches.length > 0
        ? `DRY_RUN has ${mismatches.length} unattributed live exchange position/order item(s).`
        : 'DRY_RUN uses simulated positions; the live exchange account is flat.',
    }
  }

  if (!account.ok) {
    return {
      status: 'offline',
      checkedAt,
      botPositions: bot.data.positions.length,
      exchangePositions: 0,
      mismatches: [],
      detail: account.error,
    }
  }

  const botAmounts = new Map<string, number>()
  const exchangeAmounts = new Map<string, number>()
  for (const position of bot.data.positions) {
    const key = positionKey(position.symbol, position.side)
    botAmounts.set(key, (botAmounts.get(key) ?? 0) + position.baseAmount)
  }
  for (const position of account.data.positions) {
    const key = positionKey(position.symbol, position.side)
    exchangeAmounts.set(key, (exchangeAmounts.get(key) ?? 0) + position.baseAmount)
  }

  const mismatches: FreqtradeReconciliationResult['mismatches'] = []
  const keys = new Set([...botAmounts.keys(), ...exchangeAmounts.keys()])
  for (const key of keys) {
    const [symbol, side] = key.split('|')
    const botAmount = botAmounts.get(key) ?? 0
    const exchangeAmount = exchangeAmounts.get(key) ?? 0
    const tolerance = Math.max(1e-8, Math.max(botAmount, exchangeAmount) * 0.005)
    if (Math.abs(botAmount - exchangeAmount) > tolerance) {
      mismatches.push({
        symbol,
        side,
        issue: botAmount === 0 ? 'external_position' : exchangeAmount === 0 ? 'exchange_position_missing' : 'position_size_mismatch',
        botAmount,
        exchangeAmount,
      })
    }
  }

  const botOrders = new Map(
    bot.data.positions.flatMap((position) => (
      position.openOrderIds.map((id) => [orderKey(position.symbol, id), { id, symbol: position.symbol, side: position.side }] as const)
    )),
  )
  const exchangeOrders = new Map(account.data.openOrders.map((order) => [orderKey(order.symbol, order.id), order] as const))
  for (const [key, order] of botOrders) {
    if (!exchangeOrders.has(key)) {
      mismatches.push({
        symbol: order.symbol,
        side: order.side,
        orderId: order.id,
        issue: 'bot_open_order_missing_on_exchange',
        botAmount: 0,
        exchangeAmount: 0,
      })
    }
  }
  for (const [key, order] of exchangeOrders) {
    if (!botOrders.has(key)) {
      mismatches.push({
        symbol: order.symbol,
        side: order.side,
        orderId: order.id,
        issue: 'external_open_order',
        botAmount: 0,
        exchangeAmount: 0,
      })
    }
  }

  return {
    status: mismatches.length > 0 ? 'mismatch' : 'matched',
    checkedAt,
    botPositions: bot.data.positions.length,
    exchangePositions: account.data.positions.length,
    mismatches,
    detail: mismatches.length > 0 ? `${mismatches.length} reconciliation mismatch(es)` : 'Positions and open orders match.',
  }
}
